const IDENTITY_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 };
// Map units: the SVG viewBox, which every layer shares.
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 620;
// Overlay images are laid out 500 map units wide before their own transform.
const OVERLAY_BASE_WIDTH = 500;
// View extents as [minLon, minLat, maxLon, maxLat]. The route region's extent
// comes from the route itself.
const REGIONS = {
  us: { file: "us-states.geojson", bbox: [-127, 22, -64, 51] },
  europe: { file: "europe.geojson", bbox: [-25, 30, 50, 72] },
  asia: { file: "world.geojson", bbox: [60, -10, 150, 56] },
  natl: { file: "world.geojson", bbox: [-130, 28, 28, 72] },
  world: { file: "world.geojson", bbox: [-180, -75, 180, 82] },
  route: { file: "world.geojson", bbox: null }
};
const IMAGE_REGIONS = ["us", "europe", "world"];
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const SENSITIVITY = IS_ANDROID ? 0.7 : 1.0;

const state = {
  geojson: null,
  geojsonCache: new Map(),
  // Projection bounds and the fit of those bounds into the viewBox.
  frame: null,
  projection: "mercator",
  grid: null,
  route: null,
  mode: "view",
  imageTransform: { ...IDENTITY_TRANSFORM },
  viewTransform: loadViewTransform(),
  activeSource: null,
  serverState: null,
  overlayNatural: { width: 0, height: 0 },
  // Rendered map plane size in CSS px; cached so gestures never force a layout read.
  planeSize: { width: MAP_WIDTH, height: MAP_HEIGHT },
  watchId: null,
  lastFix: null,
  lastPositionRenderAt: 0,
  centerOnNextFix: false,
  hasCenteredOnGps: false,
  pointerMap: new Map(),
  gesture: null,
  panelGesture: null,
  suppressPanelClick: false,
  saveTimer: null,
  // Set while an alignment save should not announce itself (autofit success).
  quietSave: false,
  toastTimer: null
};

const el = {
  app: document.querySelector(".app"),
  map: document.querySelector("#map"),
  plane: document.querySelector("#mapPlane"),
  panel: document.querySelector("#panel"),
  panelHandle: document.querySelector("#panelHandle"),
  world: document.querySelector("#worldLayer"),
  svg: document.querySelector("#mapSvg"),
  gridCanvas: document.querySelector("#gridCanvas"),
  routeSvg: document.querySelector("#routeSvg"),
  routeInput: document.querySelector("#routeInput"),
  fetchKind: document.querySelector("#fetchKindSelect"),
  autofit: document.querySelector("#autofitButton"),
  overlay: document.querySelector("#overlayImage"),
  dot: document.querySelector("#positionDot"),
  accuracy: document.querySelector("#accuracyRing"),
  altitudeRing: document.querySelector("#altitudeRing"),
  pasteHint: document.querySelector("#pasteHint"),
  modeToggle: document.querySelector("#modeToggle"),
  uploadButton: document.querySelector("#uploadButton"),
  upload: document.querySelector("#uploadInput"),
  locate: document.querySelector("#locateButton"),
  fit: document.querySelector("#fitButton"),
  resetImage: document.querySelector("#resetImageButton"),
  scale: document.querySelector("#scaleInput"),
  rotation: document.querySelector("#rotationInput"),
  x: document.querySelector("#xInput"),
  y: document.querySelector("#yInput"),
  status: document.querySelector("#statusLine"),
  toast: document.querySelector("#toast"),
  source: document.querySelector("#sourceValue"),
  scrape: document.querySelector("#scrapeValue"),
  forecast: document.querySelector("#forecastValue"),
  sourceAltitude: document.querySelector("#sourceAltitudeValue"),
  turbliFetch: document.querySelector("#turbliFetchButton"),
  region: document.querySelector("#regionSelect"),
  altitudeFetch: document.querySelector("#altitudeFetchSelect"),
  leadFetch: document.querySelector("#leadFetchSelect"),
  opacity: document.querySelector("#opacityInput"),
  wireframe: document.querySelector("#wireframeInput")
};

const fields = {
  coord: document.querySelector("#coordValue"),
  altitude: document.querySelector("#altitudeValue")
};

// Seconds a toast stays up. Warnings stay longer and can be tapped away.
const TOAST_SECONDS = { info: 3, warning: 8 };

// Shows message in the panel's status line and, because the panel is usually
// collapsed (always on phones), as a toast over the map. toast: false updates
// only the status line.
function setStatus(message, { kind = "info", toast = true } = {}) {
  el.status.value = message;
  if (!toast || !message) return;
  el.toast.textContent = message;
  el.toast.classList.toggle("is-warning", kind === "warning");
  el.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(hideToast, TOAST_SECONDS[kind] * 1000);
}

function setWarning(message) {
  setStatus(message, { kind: "warning" });
}

function hideToast() {
  clearTimeout(state.toastTimer);
  el.toast.hidden = true;
}

function formatMegabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Status text for the server's download progress. Turbli sends no
// Content-Length, so the percentage comes from the last download's size.
function progressText(progress) {
  if (!progress.received) return `${progress.label}...`;
  const total = progress.total || progress.estimate;
  if (!total) return `${progress.label}: ${formatMegabytes(progress.received)}`;
  const percent = Math.min(99, Math.round(100 * progress.received / total));
  return `${progress.label}: ${formatMegabytes(progress.received)} of ${progress.total ? "" : "~"}${formatMegabytes(total)} (${percent}%)`;
}

// Runs task while polling the server's download progress into the status line.
async function withProgress(task) {
  let running = true;
  (async () => {
    while (running) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const progress = await api("/api/progress");
        if (running && progress.label) setStatus(progressText(progress));
      } catch {}
    }
  })();
  try {
    return await task();
  } finally {
    running = false;
  }
}

// A failed autofit leaves a badge on its button and the reason on hover.
function setAutofitWarning(message) {
  const title = message ? `Autofit failed: ${message}` : "Autofit outlines to image";
  el.autofit.classList.toggle("has-warning", Boolean(message));
  el.autofit.title = title;
  el.autofit.setAttribute("aria-label", title);
}

function loadViewTransform() {
  try {
    return { ...IDENTITY_TRANSFORM, ...JSON.parse(localStorage.getItem("turbliGpsViewTransform") || "{}") };
  } catch {
    return { ...IDENTITY_TRANSFORM };
  }
}

function saveViewTransform() {
  localStorage.setItem("turbliGpsViewTransform", JSON.stringify(state.viewTransform));
}

function meters(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)} m` : "--";
}

function signedMeters(value) {
  return Number.isFinite(value) ? `±${value.toFixed(0)} m` : "";
}

function decimals(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function clampScale(value) {
  return Math.max(0.05, Math.min(12, value));
}

function activeTransform() {
  return state.mode === "view" ? state.viewTransform : state.imageTransform;
}

function normalizeTransform(next) {
  return {
    x: Number(next.x) || 0,
    y: Number(next.y) || 0,
    scale: clampScale(Number(next.scale) || 1),
    rotation: Number(next.rotation) || 0
  };
}

function setActiveTransform(next, autosave = true) {
  const normalized = normalizeTransform(next);
  if (state.mode === "view") {
    state.viewTransform = normalized;
    saveViewTransform();
  } else {
    state.imageTransform = normalized;
    if (autosave) scheduleAlignmentSave();
  }
  applyTransforms();
}

function regionBbox() {
  if (el.region.value === "route" && state.route) return paddedBbox(state.route.points);
  return REGIONS[el.region.value]?.bbox || REGIONS.world.bbox;
}

// Fits the region's projected extent into the viewBox with a margin.
function screenFrame(projection) {
  const [minLon, minLat, maxLon, maxLat] = regionBbox();
  const [minX, minY] = PROJECTIONS[projection].forward(minLon, minLat);
  const [maxX, maxY] = PROJECTIONS[projection].forward(maxLon, maxLat);
  const pad = 24;
  const width = MAP_WIDTH - pad * 2;
  const height = MAP_HEIGHT - pad * 2;
  const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
  return {
    projection,
    minX,
    maxY,
    scale,
    ox: pad + (width - (maxX - minX) * scale) / 2,
    oy: pad + (height - (maxY - minY) * scale) / 2
  };
}

// [lon, lat] degrees to [x, y] map units (y down).
function lonLatToScreen(lon, lat, frame = state.frame) {
  const [x, y] = PROJECTIONS[frame.projection].forward(lon, lat);
  return [frame.ox + (x - frame.minX) * frame.scale, frame.oy + (frame.maxY - y) * frame.scale];
}

function screenToLonLat(sx, sy, frame = state.frame) {
  return PROJECTIONS[frame.projection].inverse(
    frame.minX + (sx - frame.ox) / frame.scale,
    frame.maxY - (sy - frame.oy) / frame.scale
  );
}

function mapUnitsToPixels(x, y) {
  return {
    x: x / MAP_WIDTH * state.planeSize.width,
    y: y / MAP_HEIGHT * state.planeSize.height
  };
}

function pixelsToMapUnits(dx, dy) {
  return {
    x: dx / state.planeSize.width * MAP_WIDTH,
    y: dy / state.planeSize.height * MAP_HEIGHT
  };
}

function rotatePoint(x, y, degrees) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos
  };
}

function centerViewOnSvgPoint(sx, sy) {
  const point = mapUnitsToPixels(sx, sy);
  const dx = point.x - state.planeSize.width / 2;
  const dy = point.y - state.planeSize.height / 2;
  const rotated = rotatePoint(dx, dy, state.viewTransform.rotation);
  state.viewTransform = {
    ...state.viewTransform,
    x: -rotated.x * state.viewTransform.scale,
    y: -rotated.y * state.viewTransform.scale
  };
  saveViewTransform();
  applyTransforms();
}

function geometryToPath(geometry) {
  const parts = [];
  const drawRing = ring => {
    ring.forEach(([lon, lat], index) => {
      const [x, y] = lonLatToScreen(lon, lat);
      parts.push(`${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
    });
    parts.push("Z");
  };
  if (geometry.type === "Polygon") geometry.coordinates.forEach(drawRing);
  if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(drawRing));
  return parts.join(" ");
}

function svgElement(name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function renderMap() {
  state.frame = screenFrame(state.projection);
  el.svg.innerHTML = "";
  state.geojson.features.forEach(feature => {
    const path = svgElement("path", { class: "state", d: geometryToPath(feature.geometry) });
    path.dataset.name = feature.properties?.name || "";
    el.svg.appendChild(path);
  });
  drawRoute();
  drawGrid();
  applyTransforms();
  if (state.lastFix) updatePosition(state.lastFix);
}

function transformCss(transform, center = false, mapRelative = false) {
  const prefix = center ? "translate(-50%, -50%) " : "";
  const offset = mapRelative ? mapUnitsToPixels(transform.x, transform.y) : transform;
  return `${prefix}translate(${offset.x}px, ${offset.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`;
}

function updateMapPlaneSize() {
  const rect = el.map.getBoundingClientRect();
  const aspect = MAP_WIDTH / MAP_HEIGHT;
  let width = rect.width;
  let height = width / aspect;
  if (height > rect.height) {
    height = rect.height;
    width = height * aspect;
  }
  state.planeSize = { width: Math.max(1, width), height: Math.max(1, height) };
  el.plane.style.width = `${state.planeSize.width}px`;
  el.plane.style.height = `${state.planeSize.height}px`;
}

function drawRoute() {
  el.routeSvg.innerHTML = "";
  if (!state.route) return;
  const points = state.route.points.map(([lon, lat]) => lonLatToScreen(lon, lat));
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  el.routeSvg.appendChild(svgElement("path", { class: "route-line", d }));
  for (const [[x, y], airport] of [[points[0], state.route.from], [points[points.length - 1], state.route.to]]) {
    el.routeSvg.appendChild(svgElement("circle", { class: "route-airport", cx: x, cy: y, r: 4 }));
    const label = svgElement("text", { class: "route-label", x: x + 7, y: y - 7 });
    label.textContent = airport.code;
    el.routeSvg.appendChild(label);
  }
}

function drawGrid() {
  const active = Boolean(state.grid);
  el.app.classList.toggle("grid-active", active);
  el.gridCanvas.hidden = !active;
  if (active) renderGrid(el.gridCanvas, state.grid, MAP_WIDTH, MAP_HEIGHT, (sx, sy) => screenToLonLat(sx, sy));
}

async function setProjection(projection) {
  if (!PROJECTIONS[projection] || projection === state.projection) return;
  state.projection = projection;
  renderMap();
}

function hasImage() {
  return el.overlay.style.display === "block" && state.overlayNatural.width > 0;
}

function overlayBaseSizeUnits() {
  const width = OVERLAY_BASE_WIDTH;
  const natural = state.overlayNatural;
  const ratio = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0.62;
  return {
    width,
    height: width * ratio
  };
}

function updateOverlayGeometry() {
  const size = overlayBaseSizeUnits();
  const topLeft = mapUnitsToPixels(MAP_WIDTH / 2, MAP_HEIGHT / 2);
  const pixelSize = mapUnitsToPixels(size.width, size.height);
  el.overlay.style.left = `${topLeft.x}px`;
  el.overlay.style.top = `${topLeft.y}px`;
  el.overlay.style.width = `${pixelSize.x}px`;
  el.overlay.style.height = `${pixelSize.y}px`;
}

function syncDotToTransformedPosition() {
  if (el.accuracy.hidden) return;
  const mapRect = el.map.getBoundingClientRect();
  const anchor = el.accuracy.getBoundingClientRect();
  el.dot.style.left = `${anchor.left + anchor.width / 2 - mapRect.left}px`;
  el.dot.style.top = `${anchor.top + anchor.height / 2 - mapRect.top}px`;
}

function applyTransforms() {
  updateMapPlaneSize();
  el.world.style.transform = transformCss(state.viewTransform);
  updateOverlayGeometry();
  el.overlay.style.transform = transformCss(state.imageTransform, true, true);
  el.dot.style.transform = "translate(-50%, -50%)";
  if (state.lastFix) syncDotToTransformedPosition();
  const current = activeTransform();
  el.scale.value = current.scale;
  el.rotation.value = current.rotation;
  el.x.value = Math.round(current.x);
  el.y.value = Math.round(current.y);
  el.modeToggle.textContent = state.mode === "view" ? "↔️" : "🖼️";
  el.modeToggle.title = state.mode === "view" ? "Move Wireframe Map" : "Move Image";
  el.modeToggle.setAttribute("aria-label", state.mode === "view" ? "Move Wireframe Map" : "Move Image");
  el.modeToggle.setAttribute("aria-pressed", state.mode === "view" ? "true" : "false");
}

function chooseTransformForSource(source) {
  const bank = state.serverState?.transforms || {};
  return {
    ...IDENTITY_TRANSFORM,
    ...(bank.uploads?.[source.fileHash]
      || bank.sources?.[source.id]
      || bank.families?.[source.family]
      || {})
  };
}

function isLoadableImageSource(source) {
  return Boolean(source?.url) && !/^https?:\/\/[^/]*turbli\.com\//i.test(source.url);
}

function clearOverlay() {
  el.overlay.removeAttribute("src");
  el.overlay.style.display = "none";
  state.overlayNatural = { width: 0, height: 0 };
  el.pasteHint.hidden = false;
}

async function setSource(source) {
  state.activeSource = source;
  if (!source) return;
  el.source.textContent = source.name || source.id;
  el.scrape.textContent = source.scrapeTime || "--";
  el.forecast.textContent = source.forecastTime || "--";
  el.sourceAltitude.textContent = source.altitudeText || "--";

  setAutofitWarning(null);
  if (source.kind === "turbli_grid") {
    clearOverlay();
    el.pasteHint.hidden = true;
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Turbli grid failed to load: ${response.status}`);
    state.grid = decodeGrid(await response.json());
    if (state.projection === "mercator") drawGrid();
    else await setProjection("mercator");
    return;
  }
  state.grid = null;
  drawGrid();

  if (source.turbli?.region && source.turbli.region !== el.region.value) {
    el.region.value = source.turbli.region;
    await selectRegion(source.turbli.region);
  }

  if (!isLoadableImageSource(source)) {
    clearOverlay();
    setStatus(source.fetchNote || "Turbli image could not be loaded");
    return;
  }
  el.overlay.src = source.url;
  el.overlay.style.display = "block";
  el.pasteHint.hidden = true;
  const saved = chooseTransformForSource(source);
  state.imageTransform = normalizeTransform(saved);
  if (saved.projection && saved.projection !== state.projection) await setProjection(saved.projection);
  else applyTransforms();
}

function sourceUrl(source = state.activeSource) {
  return source?.remoteUrl || source?.url || "";
}

function coordinateText(position = state.lastFix) {
  if (!position) return "--";
  const c = position.coords;
  return `${String(c.latitude)}, ${String(c.longitude)}`;
}

function coordinateDisplayText(position = state.lastFix) {
  if (!position) return "--";
  const c = position.coords;
  const accuracy = signedMeters(c.accuracy);
  return `${decimals(c.latitude)}, ${decimals(c.longitude)}${accuracy ? ` (${accuracy})` : ""}`;
}

function altitudeDisplayText(position = state.lastFix) {
  if (!position) return "--";
  const c = position.coords;
  if (!Number.isFinite(c.altitude)) return "--";
  const accuracy = signedMeters(c.altitudeAccuracy);
  return `${meters(c.altitude)}${accuracy ? ` (${accuracy})` : ""}`;
}

function projectedAccuracyRadius(c, sx, sy) {
  if (!Number.isFinite(c.accuracy) || c.accuracy <= 0) return 0;
  const latitudeFactor = Math.max(0.05, Math.cos(c.latitude * Math.PI / 180));
  const lonOffset = c.accuracy / (111320 * latitudeFactor);
  const latOffset = c.accuracy / 110540;
  const [eastX, eastY] = lonLatToScreen(c.longitude + lonOffset, c.latitude);
  const [northX, northY] = lonLatToScreen(c.longitude, c.latitude + latOffset);
  const east = mapUnitsToPixels(eastX, eastY);
  const north = mapUnitsToPixels(northX, northY);
  const center = mapUnitsToPixels(sx, sy);
  return Math.max(
    Math.hypot(east.x - center.x, east.y - center.y),
    Math.hypot(north.x - center.x, north.y - center.y)
  );
}

async function copyCoordinates() {
  const text = coordinateText();
  if (text === "--") return;
  await copyText(text, "Coordinates copied");
}

async function copyText(text, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  setStatus(message);
}

async function copySourceUrl() {
  await copyText(sourceUrl(), "Source URL copied");
}

function updatePosition(position) {
  state.lastFix = position;
  const c = position.coords;
  const coords = coordinateDisplayText(position);
  fields.coord.textContent = coords;
  fields.altitude.textContent = altitudeDisplayText(position);

  const [sx, sy] = lonLatToScreen(c.longitude, c.latitude);
  const px = sx / MAP_WIDTH * 100;
  const py = sy / MAP_HEIGHT * 100;
  el.dot.hidden = false;
  el.accuracy.hidden = false;
  el.altitudeRing.hidden = !Number.isFinite(c.altitudeAccuracy);
  const hRadius = Math.max(0, Math.min(260, projectedAccuracyRadius(c, sx, sy)));
  el.accuracy.style.left = `${px}%`;
  el.accuracy.style.top = `${py}%`;
  el.accuracy.style.width = `${hRadius * 2}px`;
  el.accuracy.style.height = `${hRadius * 2}px`;
  const altRadius = Math.max(16, Math.min(240, (c.altitudeAccuracy || 0) * 0.35));
  el.altitudeRing.style.left = `${px}%`;
  el.altitudeRing.style.top = `${py}%`;
  el.altitudeRing.style.width = `${altRadius * 2}px`;
  el.altitudeRing.style.height = `${altRadius * 2}px`;
  syncDotToTransformedPosition();

  if (state.centerOnNextFix) {
    centerViewOnSvgPoint(sx, sy);
    state.centerOnNextFix = false;
    state.hasCenteredOnGps = true;
  }
}

function handlePositionUpdate(position) {
  const now = performance.now();
  state.lastFix = position;
  if (state.lastPositionRenderAt && now - state.lastPositionRenderAt < 500 && !state.centerOnNextFix) return;
  state.lastPositionRenderAt = now;
  updatePosition(position);
}

function setGpsActive(active) {
  el.locate.classList.toggle("is-active", active);
  el.locate.title = active ? "Stop GPS" : "Start GPS";
  el.locate.setAttribute("aria-label", active ? "Stop GPS" : "Start GPS");
}

function stopGpsWatch() {
  if (state.watchId == null) return;
  navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  setGpsActive(false);
  setStatus("GPS watch stopped");
}

function handlePositionError(error) {
  setWarning(error.message);
  if (error.code === error.PERMISSION_DENIED) stopGpsWatch();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function fetchTurbliSource(force = false) {
  const grid = el.fetchKind.value === "grid";
  if (!grid && !IMAGE_REGIONS.includes(el.region.value)) {
    throw new Error("Turbli publishes map images only for the US, Europe and World; use the turbulence grid");
  }
  const payload = {
    latest: true,
    altitudeFeet: Number(el.altitudeFetch.value),
    leadHours: Number(el.leadFetch.value),
    region: el.region.value,
    force
  };
  const label = grid ? "Turbli grid" : "Turbli image";
  setStatus(`Fetching ${label}...`);
  const source = await withProgress(() => api(grid ? "/api/turbli/grid" : "/api/turbli/fetch", {
    method: "POST",
    body: JSON.stringify(payload)
  }));
  await loadState();
  setStatus(`${label} ${source.cacheHit ? "loaded from cache" : "fetched and cached"}, valid ${source.forecastTime}`);
}

async function setRoute(text) {
  setStatus(`Looking up ${text}...`);
  const route = await withProgress(() => api("/api/route", { method: "POST", body: JSON.stringify({ route: text }) }));
  state.route = { text, from: route.from, to: route.to, points: greatCircle(route.from, route.to) };
  try {
    localStorage.setItem("turbliGpsRoute", JSON.stringify({ text, from: route.from, to: route.to }));
  } catch {}
  el.region.value = "route";
  await selectRegion("route");
  setStatus(`Route ${route.from.code} (${route.from.name}) to ${route.to.code} (${route.to.name})`);
}

function loadRoute() {
  try {
    const saved = JSON.parse(localStorage.getItem("turbliGpsRoute") || "null");
    return saved && { ...saved, points: greatCircle(saved.from, saved.to) };
  } catch {
    return null;
  }
}

// Outline points, in map units, as the given projection would draw them:
// rings densified every few units, clipped to the viewBox, then thinned.
function modelPoints(projection) {
  const frame = screenFrame(projection);
  const points = [];
  const add = (x, y) => {
    if (x >= 0 && y >= 0 && x <= MAP_WIDTH && y <= MAP_HEIGHT) points.push(x, y);
  };
  const visitRing = ring => {
    let previous = null;
    for (const [lon, lat] of ring) {
      const point = lonLatToScreen(lon, lat, frame);
      if (previous) {
        const steps = Math.max(1, Math.ceil(Math.hypot(point[0] - previous[0], point[1] - previous[1]) / 3));
        for (let i = 1; i <= steps; i++) {
          add(previous[0] + (point[0] - previous[0]) * i / steps, previous[1] + (point[1] - previous[1]) * i / steps);
        }
      }
      previous = point;
    }
  };
  for (const feature of state.geojson.features) {
    const geometry = feature.geometry;
    if (geometry.type === "Polygon") geometry.coordinates.forEach(visitRing);
    if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(visitRing));
  }
  const stride = Math.max(1, Math.ceil(points.length / 2 / 2500));
  const thinned = [];
  for (let i = 0; i < points.length; i += 2 * stride) thinned.push(points[i], points[i + 1]);
  return Float64Array.from(thinned);
}

// Converts a fit (natural image px = a * R(theta) * map units + b) into the
// overlay transform, whose image centre sits at the viewBox centre plus (x, y).
function transformFromFit(fit, width, height) {
  const unitsPerPixel = OVERLAY_BASE_WIDTH / width;
  const [cx, cy] = rotateScale(width / 2 - fit.bx, height / 2 - fit.by, -fit.theta, 1 / fit.a);
  return normalizeTransform({
    x: cx - MAP_WIDTH / 2,
    y: cy - MAP_HEIGHT / 2,
    scale: 1 / (fit.a * unitsPerPixel),
    rotation: -fit.theta * 180 / Math.PI
  });
}

// Aligns the outlines with the overlay image. Success is silent; failure keeps
// the current alignment and shows a warning on the autofit button.
async function autofitOverlay() {
  if (!hasImage()) {
    setStatus("Paste, drop, or upload a map image first");
    return;
  }
  const previousStatus = el.status.value;
  const { naturalWidth: width, naturalHeight: height } = el.overlay;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(el.overlay, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const models = Object.keys(PROJECTIONS).map(projection => ({ projection, points: modelPoints(projection) }));
  const fit = await autofitImage(image, models, (_, projection) => {
    setStatus(`Autofitting ${PROJECTIONS[projection].label} outlines...`, { toast: false });
  });
  if (!fit.ok) {
    const reason = `outlines matched only ${Math.round(Math.max(0, fit.match) * 100)}%; pick the region the image shows, or align by hand`;
    setAutofitWarning(reason);
    setWarning(`Autofit failed: ${reason}`);
    return;
  }
  setAutofitWarning(null);
  state.imageTransform = transformFromFit(fit, width, height);
  if (fit.projection !== state.projection) await setProjection(fit.projection);
  else applyTransforms();
  state.quietSave = true;
  scheduleAlignmentSave();
  setStatus(previousStatus, { toast: false });
}

function whenOverlayLoaded() {
  if (el.overlay.complete && el.overlay.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    el.overlay.addEventListener("load", resolve, { once: true });
    el.overlay.addEventListener("error", reject, { once: true });
  });
}

async function loadState() {
  state.serverState = await api("/api/state");
  const sources = state.serverState.sources?.sources || {};
  const activeId = state.serverState.sources?.activeSourceId;
  if (activeId && sources[activeId]) await setSource(sources[activeId]);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  setStatus("Uploading image...");
  const dataUrl = await readFileAsDataUrl(file);
  const source = await api("/api/upload", {
    method: "POST",
    body: JSON.stringify({ name: file.name || "pasted-image.png", dataUrl })
  });
  await loadState();
  setStatus("Image ready. Alignment autosaves.");
  // An image without its own saved alignment is fitted straight away, and only
  // a failure is reported. A load failure is reported by the overlay's handler.
  if (!state.serverState.transforms?.uploads?.[source.fileHash]) {
    await whenOverlayLoaded().then(autofitOverlay, () => {});
  }
}

function scheduleAlignmentSave() {
  if (!state.activeSource) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveAlignment, 450);
}

async function saveAlignment() {
  const quiet = state.quietSave;
  state.quietSave = false;
  if (!state.activeSource) return;
  try {
    await api("/api/transform", {
      method: "POST",
      body: JSON.stringify({
        sourceId: state.activeSource.id,
        family: state.activeSource.family,
        fileHash: state.activeSource.fileHash,
        transform: { ...state.imageTransform, projection: state.projection }
      })
    });
    if (!quiet) setStatus("Alignment saved");
  } catch (error) {
    setWarning(`Autosave failed: ${error.message}`);
  }
}

function gestureDistance(points) {
  const [a, b] = points;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function gestureAngle(points) {
  const [a, b] = points;
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

function gestureDelta(dx, dy) {
  const x = dx * SENSITIVITY;
  const y = dy * SENSITIVITY;
  return state.mode === "image" ? pixelsToMapUnits(x, y) : { x, y };
}

function beginGesture(event) {
  const points = [...state.pointerMap.values()];
  const transform = { ...activeTransform() };
  if (points.length >= 2) {
    state.gesture = {
      kind: "pinch",
      transform,
      center: {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2
      },
      distance: gestureDistance(points),
      angle: gestureAngle(points)
    };
  } else if (points.length === 1) {
    state.gesture = {
      kind: event.button === 2 ? "rotate" : "drag",
      transform,
      x: points[0].x,
      y: points[0].y
    };
  }
}

function updateGesture(event) {
  if (!state.gesture) return;
  const points = [...state.pointerMap.values()];
  if (state.gesture.kind === "pinch" && points.length >= 2) {
    const center = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2
    };
    const delta = gestureDelta(center.x - state.gesture.center.x, center.y - state.gesture.center.y);
    const next = {
      x: state.gesture.transform.x + delta.x,
      y: state.gesture.transform.y + delta.y,
      scale: state.gesture.transform.scale * (gestureDistance(points) / state.gesture.distance),
      rotation: state.gesture.transform.rotation + (gestureAngle(points) - state.gesture.angle) * SENSITIVITY
    };
    setActiveTransform(next);
    return;
  }
  if (state.gesture.kind === "rotate") {
    setActiveTransform({
      ...state.gesture.transform,
      rotation: state.gesture.transform.rotation + (event.clientX - state.gesture.x) * 0.35 * SENSITIVITY
    });
    return;
  }
  const delta = gestureDelta(event.clientX - state.gesture.x, event.clientY - state.gesture.y);
  setActiveTransform({
    ...state.gesture.transform,
    x: state.gesture.transform.x + delta.x,
    y: state.gesture.transform.y + delta.y
  });
}

function bindMapGestures() {
  el.map.addEventListener("contextmenu", event => event.preventDefault());
  el.map.addEventListener("pointerdown", event => {
    if (state.mode === "image" && !hasImage()) {
      setStatus("Paste, drop, or upload an image first");
      return;
    }
    event.preventDefault();
    el.map.setPointerCapture(event.pointerId);
    state.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture(event);
    el.map.classList.add("is-dragging");
  });
  el.map.addEventListener("pointermove", event => {
    if (!state.pointerMap.has(event.pointerId)) return;
    state.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });
    updateGesture(event);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    el.map.addEventListener(type, event => {
      state.pointerMap.delete(event.pointerId);
      if (state.pointerMap.size === 0) {
        state.gesture = null;
        el.map.classList.remove("is-dragging");
        if (state.mode === "image") scheduleAlignmentSave();
      } else {
        beginGesture(event);
      }
    });
  }
  el.map.addEventListener("wheel", event => {
    if (state.mode === "image" && !hasImage()) return;
    event.preventDefault();
    const current = activeTransform();
    const zoom = Math.exp(-event.deltaY * 0.0015);
    setActiveTransform({ ...current, scale: current.scale * zoom });
  }, { passive: false });
  el.map.addEventListener("dragover", event => {
    event.preventDefault();
  });
  el.map.addEventListener("drop", async event => {
    event.preventDefault();
    const file = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
    await uploadFile(file).catch(e => setWarning(e.message));
  });
}

function setPanelCollapsed(collapsed) {
  el.app.classList.toggle("panel-collapsed", collapsed);
  el.panelHandle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function beginPanelGesture(event) {
  state.panelGesture = { x: event.clientX, y: event.clientY };
}

function endPanelGesture(event) {
  const start = state.panelGesture;
  state.panelGesture = null;
  if (!start) return null;
  return {
    dx: event.clientX - start.x,
    dy: event.clientY - start.y,
    mobile: window.matchMedia("(max-width: 820px)").matches
  };
}

function bindPanelHandle() {
  el.panelHandle.addEventListener("click", () => {
    if (state.suppressPanelClick) {
      state.suppressPanelClick = false;
      return;
    }
    setPanelCollapsed(!el.app.classList.contains("panel-collapsed"));
  });
  el.panelHandle.addEventListener("pointerdown", event => {
    beginPanelGesture(event);
    el.panelHandle.setPointerCapture(event.pointerId);
  });
  el.panelHandle.addEventListener("pointerup", event => {
    const swipe = endPanelGesture(event);
    if (!swipe) return;
    const travel = swipe.mobile ? swipe.dy : swipe.dx;
    if (Math.abs(travel) > 36) {
      setPanelCollapsed(travel > 0);
      state.suppressPanelClick = true;
    }
  });
  el.panelHandle.addEventListener("pointercancel", () => {
    state.panelGesture = null;
  });
  el.panel.addEventListener("pointerdown", event => {
    if (event.target !== el.panelHandle) beginPanelGesture(event);
  });
  el.panel.addEventListener("pointerup", event => {
    if (event.target === el.panelHandle) return;
    const swipe = endPanelGesture(event);
    if (!swipe) return;
    const [along, across] = swipe.mobile ? [swipe.dy, swipe.dx] : [swipe.dx, swipe.dy];
    if (along > 48 && Math.abs(along) > Math.abs(across) * 1.4) setPanelCollapsed(true);
  });
}

function bindEvents() {
  bindPanelHandle();
  el.toast.addEventListener("click", hideToast);
  el.modeToggle.addEventListener("click", () => {
    state.mode = state.mode === "image" ? "view" : "image";
    applyTransforms();
    setStatus(state.mode === "view" ? "Move Wireframe Map mode" : "Move Image mode");
  });
  el.fit.addEventListener("click", () => {
    state.viewTransform = { ...IDENTITY_TRANSFORM };
    saveViewTransform();
    applyTransforms();
  });
  el.locate.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("Browser geolocation is unavailable");
      return;
    }

    if (state.mode === "image") {
      state.mode = "view";
      applyTransforms();
      setStatus("Switched to Move Wireframe Map mode");
    }

    if (state.watchId != null) {
      stopGpsWatch();
      return;
    }
    state.centerOnNextFix = !state.hasCenteredOnGps;
    state.watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handlePositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    });
    setGpsActive(true);
    setStatus("GPS watch running");
  });
  el.overlay.addEventListener("load", () => {
    state.overlayNatural = {
      width: el.overlay.naturalWidth,
      height: el.overlay.naturalHeight
    };
    applyTransforms();
  });
  el.overlay.addEventListener("error", () => {
    const failedUrl = sourceUrl();
    clearOverlay();
    setWarning(failedUrl ? `Image failed to load: ${failedUrl}` : "Image failed to load");
  });
  fields.coord.addEventListener("click", copyCoordinates);
  el.source.addEventListener("click", copySourceUrl);
  el.uploadButton.addEventListener("click", () => el.upload.click());
  el.upload.addEventListener("change", async () => {
    await uploadFile(el.upload.files?.[0]).catch(e => setWarning(e.message));
    el.upload.value = "";
  });
  el.resetImage.addEventListener("click", () => {
    state.imageTransform = { ...IDENTITY_TRANSFORM };
    applyTransforms();
    scheduleAlignmentSave();
    setStatus("Image position reset");
  });
  document.addEventListener("paste", async event => {
    const file = [...event.clipboardData.items]
      .find(item => item.type.startsWith("image/"))
      ?.getAsFile();
    if (file) {
      event.preventDefault();
      await uploadFile(file).catch(e => setWarning(e.message));
    }
  });
  el.turbliFetch.addEventListener("click", () => {
    fetchTurbliSource().catch(error => setWarning(error.message));
  });
  el.autofit.addEventListener("click", () => {
    autofitOverlay().catch(error => setWarning(`Autofit failed: ${error.message}`));
  });
  el.region.addEventListener("change", () => {
    if (el.region.value === "route" && !state.route) setStatus("Type a route like SEA-MUC");
    selectRegion(el.region.value)
      .then(() => setStatus(`Map switched to ${el.region.selectedOptions[0].textContent}`))
      .catch(error => setWarning(error.message));
  });
  el.routeInput.addEventListener("change", () => {
    if (el.routeInput.value.trim()) setRoute(el.routeInput.value.trim()).catch(error => setWarning(error.message));
  });
  for (const input of [el.altitudeFetch, el.leadFetch]) {
    input.addEventListener("change", () => {
      if (state.activeSource?.kind === "turbli_grid") fetchTurbliSource().catch(error => setWarning(error.message));
    });
  }
  el.opacity.addEventListener("input", () => {
    el.overlay.style.opacity = el.opacity.value;
    el.gridCanvas.style.opacity = el.opacity.value;
  });
  el.wireframe.addEventListener("input", () => {
    document.documentElement.style.setProperty("--wireframe-thickness", `${el.wireframe.value}px`);
  });
  
  // Set initial values
  el.overlay.style.opacity = el.opacity.value;
  el.gridCanvas.style.opacity = el.opacity.value;
  document.documentElement.style.setProperty("--wireframe-thickness", `${el.wireframe.value}px`);

  for (const input of [el.scale, el.rotation, el.x, el.y]) {
    input.addEventListener("input", () => {
      setActiveTransform({
        x: Number(el.x.value),
        y: Number(el.y.value),
        scale: Number(el.scale.value),
        rotation: Number(el.rotation.value)
      });
    });
  }
  bindMapGestures();
  const relayout = () => {
    applyTransforms();
    if (state.lastFix) updatePosition(state.lastFix);
  };
  // The map fills the viewport, so observing it also covers window resizes.
  if ("ResizeObserver" in window) {
    new ResizeObserver(relayout).observe(el.map);
  } else {
    window.addEventListener("resize", relayout);
  }
}

async function loadGeojson(file) {
  if (!state.geojsonCache.has(file)) {
    const response = await fetch(`/data/${file}`);
    if (!response.ok) throw new Error(`Map outline failed to load: ${response.status}`);
    state.geojsonCache.set(file, await response.json());
  }
  return state.geojsonCache.get(file);
}

async function selectRegion(region) {
  state.geojson = await loadGeojson((REGIONS[region] || REGIONS.us).file);
  try {
    localStorage.setItem("turbliGpsRegion", region);
  } catch {}
  renderMap();
}

async function start() {
  bindEvents();
  state.route = loadRoute();
  if (state.route) el.routeInput.value = state.route.text;
  try {
    const region = localStorage.getItem("turbliGpsRegion");
    if (REGIONS[region]) el.region.value = region;
  } catch {}
  await selectRegion(el.region.value);
  await loadState();
  setStatus("Ready", { toast: false });
}

start().catch(error => setWarning(error.message));
