const IDENTITY_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 };
// Map units: the SVG viewBox, which every layer shares.
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 620;
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const SENSITIVITY = IS_ANDROID ? 0.7 : 1.0;

const state = {
  geojson: null,
  bounds: null,
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
  saveTimer: null
};

const el = {
  app: document.querySelector(".app"),
  map: document.querySelector("#map"),
  plane: document.querySelector("#mapPlane"),
  panel: document.querySelector("#panel"),
  panelHandle: document.querySelector("#panelHandle"),
  world: document.querySelector("#worldLayer"),
  svg: document.querySelector("#mapSvg"),
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

function setStatus(message) {
  el.status.value = message;
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

function setActiveTransform(next, autosave = true) {
  const normalized = {
    x: Number(next.x) || 0,
    y: Number(next.y) || 0,
    scale: clampScale(Number(next.scale) || 1),
    rotation: Number(next.rotation) || 0
  };
  if (state.mode === "view") {
    state.viewTransform = normalized;
    saveViewTransform();
  } else {
    state.imageTransform = normalized;
    if (autosave) scheduleAlignmentSave();
  }
  applyTransforms();
}

function project(lon, lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radius = 6378137;
  return [
    radius * lon * Math.PI / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360))
  ];
}

function visitCoordinates(geometry, callback) {
  if (geometry.type === "Polygon") {
    geometry.coordinates.forEach(ring => ring.forEach(([lon, lat]) => callback(lon, lat)));
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(([lon, lat]) => callback(lon, lat))));
  }
}

function computeProjection() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  state.geojson.features.forEach(feature => {
    visitCoordinates(feature.geometry, (lon, lat) => {
      const [x, y] = project(lon, lat);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
  });
  state.bounds = { minX, minY, maxX, maxY };
}

function toScreen(x, y) {
  const b = state.bounds;
  const pad = 24;
  const width = MAP_WIDTH - pad * 2;
  const height = MAP_HEIGHT - pad * 2;
  const scale = Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY));
  const usedWidth = (b.maxX - b.minX) * scale;
  const usedHeight = (b.maxY - b.minY) * scale;
  const ox = pad + (width - usedWidth) / 2;
  const oy = pad + (height - usedHeight) / 2;
  return [ox + (x - b.minX) * scale, oy + (b.maxY - y) * scale, scale];
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
      const [x, y] = toScreen(...project(lon, lat));
      parts.push(`${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
    });
    parts.push("Z");
  };
  if (geometry.type === "Polygon") geometry.coordinates.forEach(drawRing);
  if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(drawRing));
  return parts.join(" ");
}

function renderMap() {
  computeProjection();
  el.svg.innerHTML = "";
  state.geojson.features.forEach(feature => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "state");
    path.setAttribute("d", geometryToPath(feature.geometry));
    path.dataset.name = feature.properties?.name || "";
    el.svg.appendChild(path);
  });
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

function overlayBaseSizeUnits() {
  const width = 500;
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

  if (source.turbli?.region && source.turbli.region !== el.region.value) {
    el.region.value = source.turbli.region;
    await loadMapData(source.turbli.region);
    renderMap();
  }

  if (!isLoadableImageSource(source)) {
    clearOverlay();
    setStatus(source.fetchNote || "Turbli image could not be loaded");
    return;
  }
  el.overlay.src = source.url;
  el.overlay.style.display = "block";
  el.pasteHint.hidden = true;
  state.imageTransform = chooseTransformForSource(source);
  applyTransforms();
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
  const [eastX, eastY] = toScreen(...project(c.longitude + lonOffset, c.latitude));
  const [northX, northY] = toScreen(...project(c.longitude, c.latitude + latOffset));
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

  const [sx, sy] = toScreen(...project(c.longitude, c.latitude));
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
  setStatus(error.message);
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
  const payload = {
    latest: true,
    altitudeFeet: Number(el.altitudeFetch.value),
    leadHours: Number(el.leadFetch.value),
    region: el.region.value,
    force
  };
  setStatus("Fetching latest Turbli image...");
  const source = await api("/api/turbli/fetch", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await loadState();
  setStatus(source.cacheHit ? "Turbli image loaded from cache" : "Turbli image fetched and cached");
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
  await api("/api/upload", {
    method: "POST",
    body: JSON.stringify({ name: file.name || "pasted-image.png", dataUrl })
  });
  await loadState();
  setStatus("Image ready. Alignment autosaves.");
}

function scheduleAlignmentSave() {
  if (!state.activeSource) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveAlignment, 450);
}

async function saveAlignment() {
  if (!state.activeSource) return;
  try {
    await api("/api/transform", {
      method: "POST",
      body: JSON.stringify({
        sourceId: state.activeSource.id,
        family: state.activeSource.family,
        fileHash: state.activeSource.fileHash,
        transform: state.imageTransform
      })
    });
    setStatus("Alignment saved");
  } catch (error) {
    setStatus(`Autosave failed: ${error.message}`);
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
    if (state.mode === "image" && !state.activeSource) {
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
    if (state.mode === "image" && !state.activeSource) return;
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
    await uploadFile(file).catch(e => setStatus(e.message));
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
    setStatus(failedUrl ? `Image failed to load: ${failedUrl}` : "Image failed to load");
  });
  fields.coord.addEventListener("click", copyCoordinates);
  el.source.addEventListener("click", copySourceUrl);
  el.uploadButton.addEventListener("click", () => el.upload.click());
  el.upload.addEventListener("change", async () => {
    await uploadFile(el.upload.files?.[0]).catch(e => setStatus(e.message));
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
      await uploadFile(file).catch(e => setStatus(e.message));
    }
  });
  el.turbliFetch.addEventListener("click", () => {
    fetchTurbliSource().catch(error => setStatus(error.message));
  });
  el.region.addEventListener("change", () => {
    setStatus(`Switching map to ${el.region.value}...`);
    loadMapData(el.region.value)
      .then(() => {
        renderMap();
        setStatus(`Map switched to ${el.region.value}`);
      })
      .catch(error => setStatus(error.message));
  });
  el.opacity.addEventListener("input", () => {
    el.overlay.style.opacity = el.opacity.value;
  });
  el.wireframe.addEventListener("input", () => {
    document.documentElement.style.setProperty("--wireframe-thickness", `${el.wireframe.value}px`);
  });
  
  // Set initial values
  el.overlay.style.opacity = el.opacity.value;
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

const MAP_FILES = { us: "us-states.geojson", europe: "europe.geojson", world: "world.geojson" };

async function loadMapData(region) {
  const response = await fetch(`/data/${MAP_FILES[region] || MAP_FILES.us}`);
  if (!response.ok) throw new Error(`Map outline failed to load: ${response.status}`);
  state.geojson = await response.json();
}

async function start() {
  bindEvents();
  await loadMapData(el.region.value);
  await loadState();
  renderMap();
  setStatus("Ready");
}

start().catch(error => setStatus(error.message));
