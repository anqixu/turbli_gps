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
  minScore: 0.45      // Below this mean score the fit is reported as failed.
};

// (h, w) mask of dark, unsaturated pixels from canvas RGBA data.
function lineMask(rgba, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    mask[i] = luminance < 0.55 && chroma < 0.18 && rgba[i * 4 + 3] > 128 ? 1 : 0;
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
  let density = 0;
  for (let i = 0; i < mask.length; i++) density += mask[i];
  return { width, height, score, pxPerNatural: scale, density: density / mask.length };
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

// models: [{ projection, points }]. image: ImageData of the map image.
// Returns the best fit in natural image pixels, with its projection and score.
async function autofitImage(image, models, onProgress = () => {}) {
  const coarse = scoreImage(image, AUTOFIT.coarseSize, AUTOFIT.coarseCap);
  const fine = scoreImage(image, AUTOFIT.fineSize, AUTOFIT.fineCap);
  let best = null;
  for (const [index, model] of models.entries()) {
    onProgress(index / models.length, model.projection);
    await new Promise(resolve => setTimeout(resolve));
    const starts = coarseSearch(coarse, model.points, AUTOFIT.candidatesPerProjection);
    const ratio = fine.pxPerNatural / coarse.pxPerNatural;
    for (const start of starts) {
      const scaled = { ...start, a: start.a * ratio, bx: start.bx * ratio, by: start.by * ratio };
      const fit = refineFit(fine, model.points, scaled);
      if (!best || fit.score > best.score) best = { ...fit, projection: model.projection };
    }
  }
  // Convert from fine-image pixels to natural image pixels.
  const k = 1 / fine.pxPerNatural;
  return { ...best, a: best.a * k, bx: best.bx * k, by: best.by * k, ok: best.score >= AUTOFIT.minScore };
}
