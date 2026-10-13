// Renders Turbli's global turbulence grid as a heatmap in map units.
//
// A grid is { lat0, lon0, step, rows, cols, values }: values is a Uint8Array of
// EDR x 100, row-major, row 0 at lat0 (south) and column 0 at lon0 (west).

// turbli.com's colour scale (static/js/interactive/colorbar.js). Turbli fades
// from white below 12 on a white map; on this dark map the same band fades in
// from transparent instead, so its first two stops take the light-blue colour.
const TURBULENCE_STOPS = [
  [0, "#bdcfe1"], [12, "#bdcfe1"], [16, "#bdcfe1"], [20, "#2b6eb1"],
  [26, "#ffd199"], [32, "#ff8c00"], [40, "#9c2661"]
];
// Opacity by EDR x 100: smooth air is transparent, light turbulence translucent.
const ALPHA_STOPS = [[12, 0], [16, 0.5], [20, 1]];
// Lookup entries per EDR x 100 unit, so interpolated values do not posterize.
const LUT_STEPS = 4;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Piecewise-linear interpolation through [value, output] stops.
function interpolateStops(stops, value, output) {
  let i = 0;
  while (i < stops.length - 2 && value > stops[i + 1][0]) i++;
  const t = Math.max(0, Math.min(1, (value - stops[i][0]) / (stops[i + 1][0] - stops[i][0])));
  return output(stops[i][1], stops[i + 1][1], t);
}

// (256 * LUT_STEPS, 4) RGBA lookup indexed by EDR x 100 * LUT_STEPS.
const TURBULENCE_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * LUT_STEPS * 4);
  for (let index = 0; index < 256 * LUT_STEPS; index++) {
    const value = index / LUT_STEPS;
    const rgb = interpolateStops(TURBULENCE_STOPS, value, (c0, c1, t) => {
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return a.map((channel, k) => channel + (b[k] - channel) * t);
    });
    lut.set([...rgb, 255 * interpolateStops(ALPHA_STOPS, value, (a0, a1, t) => a0 + (a1 - a0) * t)], index * 4);
  }
  return lut;
})();

function decodeGrid(json) {
  const raw = atob(json.values);
  const values = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) values[i] = raw.charCodeAt(i);
  return { ...json, values };
}

// Draws the grid onto canvas, whose pixels span the map's width x height units.
// screenToLonLat(sx, sy) maps map units to [lon, lat]. Because every projection
// is cylindrical, longitude is solved once per column and latitude once per row.
function renderGrid(canvas, grid, width, height, screenToLonLat) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const columnX = new Float32Array(width);
  const rowY = new Float32Array(height);
  for (let i = 0; i < width; i++) {
    const lon = screenToLonLat(i + 0.5, height / 2)[0];
    columnX[i] = ((((lon - grid.lon0) / grid.step) % grid.cols) + grid.cols) % grid.cols;
  }
  for (let j = 0; j < height; j++) {
    const lat = screenToLonLat(width / 2, j + 0.5)[1];
    rowY[j] = Math.max(0, Math.min(grid.rows - 1, (lat - grid.lat0) / grid.step));
  }
  const { values, cols, rows } = grid;
  const out = image.data;
  for (let j = 0; j < height; j++) {
    const y = rowY[j];
    const r0 = Math.floor(y);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fy = y - r0;
    for (let i = 0; i < width; i++) {
      const x = columnX[i];
      const c0 = Math.floor(x);
      const c1 = (c0 + 1) % cols;
      const fx = x - c0;
      const top = values[r0 * cols + c0] * (1 - fx) + values[r0 * cols + c1] * fx;
      const bottom = values[r1 * cols + c0] * (1 - fx) + values[r1 * cols + c1] * fx;
      const index = Math.round((top * (1 - fy) + bottom * fy) * LUT_STEPS);
      const o = (j * width + i) * 4;
      const l = index * 4;
      out[o] = TURBULENCE_LUT[l];
      out[o + 1] = TURBULENCE_LUT[l + 1];
      out[o + 2] = TURBULENCE_LUT[l + 2];
      out[o + 3] = TURBULENCE_LUT[l + 3];
    }
  }
  ctx.putImageData(image, 0, 0);
}
