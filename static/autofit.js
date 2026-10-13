// Fits outline points onto a map image by truncated chamfer matching.
//
// The image's coastlines and borders are thin, dark, unsaturated lines, while
// turbulence is drawn in saturated colours or near-white, so a luminance and
// chroma threshold isolates the outlines. A distance transform of that mask
// turns into a soft score map: 1 on a line, falling to 0 at `cap` pixels away.
// The fit maximises the mean score of the model points, first by exhaustive
// search over scale and translation on a small image, then by local pattern
// search over scale, rotation and translation on a larger one.
//
// Points are a Float64Array of interleaved map-unit x, y (y down). A fit maps
// a model point m to analysis-image pixels as u = a * R(theta) * m + (bx, by).

const AUTOFIT = {
  coarseSize: 110,    // Max dimension of the exhaustive-search image, px.
  fineSize: 420,      // Max dimension of the refinement image, px.
  coarseCap: 2.5,     // Score falloff distance at coarse size, px.
  fineCap: 3,         // Score falloff distance at fine size, px.
  // The model's span as a fraction of the image's larger side. It keeps the
  // search from shrinking the outlines onto one dense patch of lines.
  minSpan: 0.4,
  maxSpan: 2.0,
  scaleSteps: 26,
  candidatesPerProjection: 3,
  // Local search around an existing alignment: scale within x/÷ localScale,
  // shift within localShift of the cropped image's larger side.
  localScale: 1.25,
  localScaleSteps: 9,
  localShift: 0.08,
  // Below this chance-corrected match the fit is reported as failed.
  minMatch: 0.6
};

// Running maximum over a window of 2 * radius + 1, along one axis, in place.
function maxFilter1d(values, width, height, radius, horizontal) {
  const [outer, inner] = horizontal ? [height, width] : [width, height];
  const line = new Float32Array(inner);
  for (let o = 0; o < outer; o++) {
    const at = i => (horizontal ? o * width + i : i * width + o);
    for (let i = 0; i < inner; i++) line[i] = values[at(i)];
    for (let i = 0; i < inner; i++) {
      let max = line[i];
      for (let k = Math.max(0, i - radius); k <= Math.min(inner - 1, i + radius); k++) max = Math.max(max, line[k]);
      values[at(i)] = max;
    }
  }
}

// (h, w) mask of outline pixels from canvas RGBA data: unsaturated pixels that
// are either dark, or clearly darker than the brightest pixel nearby. The
// second test keeps the thin grey borders a browser leaves when it shrinks a
// Turbli map onto a phone screen; it demands near-zero chroma so the edges of
// Turbli's pale-blue turbulence do not pass for borders.
function lineMask(rgba, width, height) {
  const n = width * height;
  const luminance = new Float32Array(n);
  const chroma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    luminance[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    chroma[i] = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }
  const nearbyMax = Float32Array.from(luminance);
  maxFilter1d(nearbyMax, width, height, 2, true);
  maxFilter1d(nearbyMax, width, height, 2, false);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] <= 128) continue;
    const dark = luminance[i] < 0.55 && chroma[i] < 0.18;
    const contrast = luminance[i] < 0.8 && chroma[i] < 0.06 && nearbyMax[i] - luminance[i] > 0.18;
    mask[i] = dark || contrast ? 1 : 0;
  }
  return mask;
}

// Squared 1-D distance transform (Felzenszwalb and Huttenlocher), in place on f.
function distance1d(f, n, v, z, d) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]) k--;
      else break;
    } while (k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
  for (let q = 0; q < n; q++) f[q] = d[q];
}

// (h, w) Euclidean distance, in px, from each pixel to the nearest mask pixel.
function distanceTransform(mask, width, height) {
  const big = 1e10;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : big;
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    distance1d(f, height, v, z, d);
    for (let y = 0; y < height; y++) grid[y * width + x] = f[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    distance1d(f, width, v, z, d);
    for (let x = 0; x < width; x++) grid[y * width + x] = Math.sqrt(f[x]);
  }
  return grid;
}

// Image scaled so its larger side is `size` px, with the line mask max-pooled
// so one-pixel lines survive the downsampling.
function scoreImage(image, size, cap) {
  const scale = Math.min(1, size / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const full = lineMask(image.data, image.width, image.height);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < image.height; y++) {
    const row = Math.min(height - 1, Math.floor(y * scale)) * width;
    for (let x = 0; x < image.width; x++) {
      if (full[y * image.width + x]) mask[row + Math.min(width - 1, Math.floor(x * scale))] = 1;
    }
  }
  const distance = distanceTransform(mask, width, height);
  const score = new Float32Array(width * height);
  for (let i = 0; i < score.length; i++) score[i] = Math.max(0, 1 - distance[i] / cap);
  // Mean score of a point dropped anywhere: what a random placement earns.
  let baseline = 0;
  for (let i = 0; i < score.length; i++) baseline += score[i];
  return { width, height, score, pxPerNatural: scale, baseline: baseline / score.length };
}

function meanScore(map, points, fit) {
  const cos = Math.cos(fit.theta) * fit.a;
  const sin = Math.sin(fit.theta) * fit.a;
  let total = 0;
  const n = points.length / 2;
  for (let i = 0; i < points.length; i += 2) {
    const u = Math.round(cos * points[i] - sin * points[i + 1] + fit.bx);
    const v = Math.round(sin * points[i] + cos * points[i + 1] + fit.by);
    if (u >= 0 && v >= 0 && u < map.width && v < map.height) total += map.score[v * map.width + u];
  }
  return total / n;
}

// Exhaustive scale x translation search with rotation fixed at 0. Returns the
// best fits, at least a few pixels apart, best first.
function coarseSearch(map, points, keep) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const side = Math.max(map.width, map.height);
  const n = points.length / 2;
  const results = [];
  for (let step = 0; step < AUTOFIT.scaleSteps; step++) {
    const fraction = AUTOFIT.minSpan * Math.pow(AUTOFIT.maxSpan / AUTOFIT.minSpan, step / (AUTOFIT.scaleSteps - 1));
    const a = fraction * side / span;
    // Integer model offsets relative to the footprint's corner, deduplicated.
    const offsets = new Map();
    for (let i = 0; i < points.length; i += 2) {
      const u = Math.round((points[i] - minX) * a);
      const v = Math.round((points[i + 1] - minY) * a);
      const key = v * 100000 + u;
      offsets.set(key, (offsets.get(key) || 0) + 1);
    }
    const us = [], vs = [], ws = [];
    for (const [key, count] of offsets) {
      us.push(key % 100000); vs.push(Math.floor(key / 100000)); ws.push(count);
    }
    const footW = (maxX - minX) * a;
    const footH = (maxY - minY) * a;
    const scaleResults = [];
    for (let ty = Math.floor(-0.5 * footH); ty <= map.height - 0.5 * footH; ty++) {
      for (let tx = Math.floor(-0.5 * footW); tx <= map.width - 0.5 * footW; tx++) {
        let total = 0;
        for (let k = 0; k < us.length; k++) {
          const u = us[k] + tx;
          const v = vs[k] + ty;
          if (u >= 0 && v >= 0 && u < map.width && v < map.height) total += ws[k] * map.score[v * map.width + u];
        }
        scaleResults.push({ score: total / n, a, theta: 0, bx: tx - minX * a, by: ty - minY * a });
      }
    }
    scaleResults.sort((p, q) => q.score - p.score);
    results.push(...scaleResults.slice(0, 20));
  }
  results.sort((p, q) => q.score - p.score);
  const picked = [];
  for (const fit of results) {
    if (picked.length >= keep) break;
    const far = picked.every(other => Math.hypot(other.bx - fit.bx, other.by - fit.by) > 4 || Math.abs(Math.log(other.a / fit.a)) > 0.1);
    if (far) picked.push(fit);
  }
  return picked;
}

// Local pattern search over a, theta, bx, by from `start`.
function refineFit(map, points, start) {
  let best = { ...start, score: meanScore(map, points, start) };
  const steps = { a: 0.03, theta: 1 * Math.PI / 180, bx: 3, by: 3 };
  const relative = { a: true, theta: false, bx: false, by: false };
  for (let iteration = 0; iteration < 400 && steps.bx > 0.2; iteration++) {
    let improved = false;
    for (const key of Object.keys(steps)) {
      for (const sign of [1, -1]) {
        const trial = { ...best };
        trial[key] = relative[key] ? best[key] * (1 + sign * steps[key]) : best[key] + sign * steps[key];
        // Rotating or scaling about the origin moves everything; re-centre on the image.
        if (key === "a" || key === "theta") {
          const cx = map.width / 2;
          const cy = map.height / 2;
          const inv = rotateScale(cx - best.bx, cy - best.by, -best.theta, 1 / best.a);
          const back = rotateScale(inv[0], inv[1], trial.theta, trial.a);
          trial.bx = cx - back[0];
          trial.by = cy - back[1];
        }
        trial.score = meanScore(map, points, trial);
        if (trial.score > best.score) {
          best = trial;
          improved = true;
        }
      }
    }
    if (!improved) for (const key of Object.keys(steps)) steps[key] /= 2;
  }
  return best;
}

function rotateScale(x, y, theta, a) {
  return [a * (Math.cos(theta) * x - Math.sin(theta) * y), a * (Math.sin(theta) * x + Math.cos(theta) * y)];
}

// Copies the (x, y, width, height) rectangle out of an ImageData.
function cropImage(image, rect) {
  const out = new ImageData(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    out.data.set(image.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

function clampRect(rect, image) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.width, Math.ceil(rect.x + rect.width)) - x),
    height: Math.max(1, Math.min(image.height, Math.ceil(rect.y + rect.height)) - y)
  };
}

// Longest run of true entries, allowing short gaps: [start, end) or null.
function longestRun(flags, maxGap) {
  let best = null;
  let start = -1;
  let lastTrue = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0 || i - lastTrue > maxGap) start = i;
      lastTrue = i;
      if (!best || lastTrue + 1 - start > best[1] - best[0]) best = [start, lastTrue + 1];
    }
  }
  return best;
}

// Where the map sits in a screenshot of turbli.com: the band of rows tinted
// by turbulence colour, even Turbli's palest blue. Page text is grey and
// links are too sparse to form a band. The band keeps the full width, since
// the map spans a phone's width and parts of it may be calm and white.
// Returns a padded rectangle in natural px, or null when the band covers most
// of the image anyway.
function colourBounds(image) {
  const step = Math.max(1, Math.round(Math.max(image.width, image.height) / 400));
  const cols = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const tinted = [];
  for (let r = 0; r < rows; r++) {
    let count = 0;
    for (let c = 0; c < cols; c++) {
      const i = ((r * step) * image.width + c * step) * 4;
      const chroma = (Math.max(image.data[i], image.data[i + 1], image.data[i + 2])
        - Math.min(image.data[i], image.data[i + 1], image.data[i + 2])) / 255;
      if (chroma > 0.1) count++;
    }
    tinted.push(count >= Math.max(2, cols * 0.02));
  }
  const run = longestRun(tinted, Math.ceil(rows * 0.05));
  if (!run) return null;
  const pad = 0.05 * (run[1] - run[0]) * step;
  const rect = clampRect({ x: 0, y: run[0] * step - pad, width: image.width, height: (run[1] - run[0]) * step + 2 * pad }, image);
  return rect.height < 0.8 * image.height ? rect : null;
}

// Maps points through a fit into image px; returns the ones inside rect.
function pointsInside(points, fit, rect) {
  const kept = [];
  const cos = Math.cos(fit.theta) * fit.a;
  const sin = Math.sin(fit.theta) * fit.a;
  for (let i = 0; i < points.length; i += 2) {
    const u = cos * points[i] - sin * points[i + 1] + fit.bx;
    const v = sin * points[i] + cos * points[i + 1] + fit.by;
    if (u >= rect.x && v >= rect.y && u < rect.x + rect.width && v < rect.y + rect.height) kept.push(points[i], points[i + 1], u, v);
  }
  return kept;
}

function shiftFit(fit, dx, dy, k = 1) {
  return { ...fit, a: fit.a * k, bx: (fit.bx + dx) * k, by: (fit.by + dy) * k };
}

function withMatch(fit, map) {
  const match = (fit.score - map.baseline) / (1 - map.baseline);
  return { ...fit, match, ok: match >= AUTOFIT.minMatch };
}

// Searches near `init` (a fit in natural px): the outlines that fall inside
// the image under init, against the image cropped to their footprint.
function localFit(image, points, init) {
  const inside = pointsInside(points, init, { x: 0, y: 0, width: image.width, height: image.height });
  if (inside.length / 4 < 40) return null;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  const model = [];
  for (let i = 0; i < inside.length; i += 4) {
    model.push(inside[i], inside[i + 1]);
    minU = Math.min(minU, inside[i + 2]); maxU = Math.max(maxU, inside[i + 2]);
    minV = Math.min(minV, inside[i + 3]); maxV = Math.max(maxV, inside[i + 3]);
  }
  const pad = 0.15 * Math.max(maxU - minU, maxV - minV);
  const rect = clampRect({ x: minU - pad, y: minV - pad, width: maxU - minU + 2 * pad, height: maxV - minV + 2 * pad }, image);
  const map = scoreImage(cropImage(image, rect), AUTOFIT.fineSize, AUTOFIT.fineCap);
  const pts = Float64Array.from(model);
  const start = shiftFit(init, -rect.x, -rect.y, map.pxPerNatural);
  // Exhaustive search over scale (about the footprint's centre) and translation.
  const centre = { x: ((minU + maxU) / 2 - rect.x) * map.pxPerNatural, y: ((minV + maxV) / 2 - rect.y) * map.pxPerNatural };
  const reach = Math.round(AUTOFIT.localShift * Math.max(map.width, map.height));
  // The few best fits so far, best first.
  const candidates = [];
  const keep = fit => {
    if (candidates.length === 3 && fit.score <= candidates[2].score) return;
    candidates.push(fit);
    candidates.sort((p, q) => q.score - p.score);
    candidates.length = Math.min(candidates.length, 3);
  };
  for (let s = 0; s < AUTOFIT.localScaleSteps; s++) {
    const f = Math.pow(AUTOFIT.localScale, (2 * s) / (AUTOFIT.localScaleSteps - 1) - 1);
    const scaled = { ...start, a: start.a * f, bx: centre.x - f * (centre.x - start.bx), by: centre.y - f * (centre.y - start.by) };
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const fit = { ...scaled, bx: scaled.bx + dx, by: scaled.by + dy };
        fit.score = meanScore(map, pts, fit);
        keep(fit);
      }
    }
  }
  let best = null;
  for (const candidate of candidates) {
    const fit = refineFit(map, pts, candidate);
    if (!best || fit.score > best.score) best = fit;
  }
  const k = 1 / map.pxPerNatural;
  return { ...withMatch(best, map), a: best.a * k, bx: best.bx * k + rect.x, by: best.by * k + rect.y };
}

// Exhaustive search over scale and translation, then refinement, for every
// projection, within rect (the map's part of the image).
async function globalFit(image, models, rect, onProgress) {
  const cropped = cropImage(image, rect);
  const coarse = scoreImage(cropped, AUTOFIT.coarseSize, AUTOFIT.coarseCap);
  const fine = scoreImage(cropped, AUTOFIT.fineSize, AUTOFIT.fineCap);
  let best = null;
  for (const [index, model] of models.entries()) {
    onProgress(index / models.length, model.projection);
    await new Promise(resolve => setTimeout(resolve));
    const starts = coarseSearch(coarse, model.points, AUTOFIT.candidatesPerProjection);
    const ratio = fine.pxPerNatural / coarse.pxPerNatural;
    for (const start of starts) {
      const fit = refineFit(fine, model.points, shiftFit(start, 0, 0, ratio));
      if (!best || fit.score > best.score) best = { ...fit, projection: model.projection };
    }
  }
  const k = 1 / fine.pxPerNatural;
  return { ...withMatch(best, fine), a: best.a * k, bx: best.bx * k + rect.x, by: best.by * k + rect.y };
}

// models: [{ projection, points }]. image: ImageData of the map image or a
// screenshot of turbli.com. init, when given, is the current alignment as a
// fit in natural px with its projection; a good fit near it wins over a
// global search. Returns the best fit in natural image px, with its
// projection, its raw mean score, and its match: the score corrected for
// chance, so a map dense with borders cannot pass with outlines that merely
// land near some line.
async function autofitImage(image, models, onProgress = () => {}, init = null) {
  const initModel = init && models.find(model => model.projection === init.projection);
  if (initModel) {
    onProgress(0, init.projection);
    await new Promise(resolve => setTimeout(resolve));
    const fit = localFit(image, initModel.points, init);
    if (fit?.ok) return { ...fit, projection: init.projection, local: true };
  }
  const rect = colourBounds(image) || { x: 0, y: 0, width: image.width, height: image.height };
  return globalFit(image, models, rect, onProgress);
}
