const IDENTITY_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 };

const state = {
  geojson: null,
  bounds: null,
  projection: "web_mercator",
  mode: "image",
  imageTransform: { ...IDENTITY_TRANSFORM },
  viewTransform: loadViewTransform(),
  activeSource: null,
  serverState: null,
  overlayNatural: { width: 0, height: 0 },
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
  projection: document.querySelector("#projectionSelect"),
  uploadButton: document.querySelector("#uploadButton"),
  upload: document.querySelector("#uploadInput"),
  locate: document.querySelector("#locateButton"),
  fit: document.querySelector("#fitButton"),
  scale: document.querySelector("#scaleInput"),
  rotation: document.querySelector("#rotationInput"),
  x: document.querySelector("#xInput"),
  y: document.querySelector("#yInput"),
  status: document.querySelector("#statusLine"),
  source: document.querySelector("#sourceValue"),
  scrape: document.querySelector("#scrapeValue"),
  forecast: document.querySelector("#forecastValue"),
  sourceAltitude: document.querySelector("#sourceAltitudeValue"),
  turbliFetch: document.querySelector("#turbliFetchButton")
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

function equirectangular(lon, lat) {
  return [lon, lat];
}

function webMercator(lon, lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radius = 6378137;
  return [
    radius * lon * Math.PI / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360))
  ];
}

function usaAlbers(lon, lat) {
  const phi1 = 29.5 * Math.PI / 180;
  const phi2 = 45.5 * Math.PI / 180;
  const lat0 = 37.5 * Math.PI / 180;
  const lon0 = -96 * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const lam = lon * Math.PI / 180;
  const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
  const c = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(phi))) / n;
  const rho0 = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(lat0))) / n;
  const theta = n * (lam - lon0);
  return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

function project(lon, lat) {
  if (state.projection === "equirectangular") return equirectangular(lon, lat);
  if (state.projection === "web_mercator") return webMercator(lon, lat);
  return usaAlbers(lon, lat);
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
  const width = 1000 - pad * 2;
  const height = 620 - pad * 2;
  const scale = Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY));
  const usedWidth = (b.maxX - b.minX) * scale;
  const usedHeight = (b.maxY - b.minY) * scale;
  const ox = pad + (width - usedWidth) / 2;
  const oy = pad + (height - usedHeight) / 2;
  return [ox + (x - b.minX) * scale, oy + (b.maxY - y) * scale, scale];
}

function screenToMapPixels(sx, sy) {
  const rect = el.plane.getBoundingClientRect();
  return {
    x: sx / 1000 * rect.width,
    y: sy / 620 * rect.height
  };
}

function mapUnitsToPixels(x, y) {
  const rect = el.plane.getBoundingClientRect();
  return {
    x: x / 1000 * rect.width,
    y: y / 620 * rect.height
  };
}

function pixelToMapUnits(x, y) {
  const rect = el.plane.getBoundingClientRect();
  return {
    x: x / Math.max(1, rect.width) * 1000,
    y: y / Math.max(1, rect.height) * 620
  };
}

function pixelsToMapUnits(dx, dy) {
  const rect = el.plane.getBoundingClientRect();
  return {
    x: dx / Math.max(1, rect.width) * 1000,
    y: dy / Math.max(1, rect.height) * 620
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
  const rect = el.plane.getBoundingClientRect();
  const point = screenToMapPixels(sx, sy);
  const dx = point.x - rect.width / 2;
  const dy = point.y - rect.height / 2;
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
  if (state.lastFix) updatePosition(state.lastFix);
  applyTransforms();
}

function transformCss(transform, center = false, mapRelative = false) {
  const prefix = center ? "translate(-50%, -50%) " : "";
  const offset = mapRelative ? mapUnitsToPixels(transform.x, transform.y) : transform;
  return `${prefix}translate(${offset.x}px, ${offset.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`;
}

function updateMapPlaneSize() {
  const rect = el.map.getBoundingClientRect();
  const aspect = 1000 / 620;
  let width = rect.width;
  let height = width / aspect;
  if (height > rect.height) {
    height = rect.height;
    width = height * aspect;
  }
  el.plane.style.width = `${Math.max(1, width)}px`;
  el.plane.style.height = `${Math.max(1, height)}px`;
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
  const topLeft = mapUnitsToPixels(500, 310);
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
  el.modeToggle.title = state.mode === "view" ? "Move map" : "Align image";
  el.modeToggle.setAttribute("aria-label", state.mode === "view" ? "Move map" : "Align image");
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

function setSource(source) {
  state.activeSource = source;
  if (!source) return;
  el.overlay.src = source.url;
  el.overlay.style.display = "block";
  el.pasteHint.hidden = true;
  state.imageTransform = chooseTransformForSource(source);
  applyTransforms();
  el.source.textContent = source.name || source.id;
  el.scrape.textContent = source.scrapeTime || "--";
  el.forecast.textContent = source.forecastTime || "--";
  el.sourceAltitude.textContent = source.altitudeText || "--";
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
  const east = screenToMapPixels(eastX, eastY);
  const north = screenToMapPixels(northX, northY);
  const center = screenToMapPixels(sx, sy);
  return Math.max(
    Math.hypot(east.x - center.x, east.y - center.y),
    Math.hypot(north.x - center.x, north.y - center.y)
  );
}

async function copyCoordinates() {
  const text = coordinateText();
  if (text === "--") return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Coordinates copied");
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    setStatus("Coordinates copied");
  }
}

function updatePosition(position) {
  state.lastFix = position;
  const c = position.coords;
  const coords = coordinateDisplayText(position);
  fields.coord.textContent = coords;
  fields.altitude.textContent = altitudeDisplayText(position);

  const [sx, sy] = toScreen(...project(c.longitude, c.latitude));
  const px = sx / 10;
  const py = sy / 6.2;
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
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function fetchTurbliSource(force = false) {
  const payload = {
    latest: true,
    altitudeFeet: 33000,
    region: "us",
    force
  };
  setStatus("Fetching latest Turbli image...");
  const source = await api("/api/turbli/fetch", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await loadState();
  setSource(source);
  setStatus(source.cacheHit ? "Turbli image loaded from cache" : "Turbli image fetched and cached");
}

async function loadState() {
  state.serverState = await api("/api/state");
  const sources = state.serverState.sources?.sources || {};
  const activeId = state.serverState.sources?.activeSourceId;
  if (activeId && sources[activeId]) setSource(sources[activeId]);
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
  setSource(source);
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
  } else {
    state.gesture = {
      kind: event.button === 2 ? "rotate" : "drag",
      transform,
      x: event.clientX,
      y: event.clientY
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
    const delta = state.mode === "image"
      ? pixelsToMapUnits(center.x - state.gesture.center.x, center.y - state.gesture.center.y)
      : { x: center.x - state.gesture.center.x, y: center.y - state.gesture.center.y };
    const next = {
      x: state.gesture.transform.x + delta.x,
      y: state.gesture.transform.y + delta.y,
      scale: state.gesture.transform.scale * (gestureDistance(points) / state.gesture.distance),
      rotation: state.gesture.transform.rotation + gestureAngle(points) - state.gesture.angle
    };
    setActiveTransform(next);
    return;
  }
  if (state.gesture.kind === "rotate") {
    setActiveTransform({
      ...state.gesture.transform,
      rotation: state.gesture.transform.rotation + (event.clientX - state.gesture.x) * 0.35
    });
    return;
  }
  const delta = state.mode === "image"
    ? pixelsToMapUnits(event.clientX - state.gesture.x, event.clientY - state.gesture.y)
    : { x: event.clientX - state.gesture.x, y: event.clientY - state.gesture.y };
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
    await uploadFile(file);
  });
}

function setPanelCollapsed(collapsed) {
  el.app.classList.toggle("panel-collapsed", collapsed);
  el.panelHandle.setAttribute("aria-expanded", collapsed ? "false" : "true");
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
    state.panelGesture = {
      x: event.clientX,
      y: event.clientY,
      collapsed: el.app.classList.contains("panel-collapsed")
    };
    el.panelHandle.setPointerCapture(event.pointerId);
  });
  el.panelHandle.addEventListener("pointerup", event => {
    if (!state.panelGesture) return;
    const dx = event.clientX - state.panelGesture.x;
    const dy = event.clientY - state.panelGesture.y;
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    if (mobile && Math.abs(dy) > 36) {
      setPanelCollapsed(dy > 0);
      state.suppressPanelClick = true;
    } else if (!mobile && Math.abs(dx) > 36) {
      setPanelCollapsed(dx > 0);
      state.suppressPanelClick = true;
    }
    state.panelGesture = null;
  });
  el.panelHandle.addEventListener("pointercancel", () => {
    state.panelGesture = null;
  });
  el.panel.addEventListener("pointerdown", event => {
    if (event.target === el.panelHandle) return;
    state.panelGesture = {
      x: event.clientX,
      y: event.clientY,
      collapsed: el.app.classList.contains("panel-collapsed")
    };
  });
  el.panel.addEventListener("pointerup", event => {
    if (!state.panelGesture || event.target === el.panelHandle) return;
    const dx = event.clientX - state.panelGesture.x;
    const dy = event.clientY - state.panelGesture.y;
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    if (mobile && dy > 48 && Math.abs(dy) > Math.abs(dx) * 1.4) {
      setPanelCollapsed(true);
    } else if (!mobile && dx > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      setPanelCollapsed(true);
    }
    state.panelGesture = null;
  });
}

function bindEvents() {
  bindPanelHandle();
  el.modeToggle.addEventListener("click", () => {
    state.mode = state.mode === "image" ? "view" : "image";
    applyTransforms();
    setStatus(state.mode === "view" ? "Moving map and image together" : "Aligning image to map");
  });
  el.projection.addEventListener("change", () => {
    state.projection = el.projection.value;
    renderMap();
  });
  el.fit.addEventListener("click", () => {
    state.viewTransform = { ...IDENTITY_TRANSFORM };
    saveViewTransform();
    applyTransforms();
    renderMap();
  });
  el.locate.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("Browser geolocation is unavailable");
      return;
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
  fields.coord.addEventListener("click", copyCoordinates);
  el.uploadButton.addEventListener("click", () => el.upload.click());
  el.upload.addEventListener("change", async () => {
    await uploadFile(el.upload.files?.[0]);
    el.upload.value = "";
  });
  document.addEventListener("paste", async event => {
    const file = [...event.clipboardData.items]
      .find(item => item.type.startsWith("image/"))
      ?.getAsFile();
    if (file) {
      event.preventDefault();
      await uploadFile(file);
    }
  });
  el.turbliFetch.addEventListener("click", () => {
    fetchTurbliSource().catch(error => setStatus(error.message));
  });
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
  window.addEventListener("resize", () => {
    applyTransforms();
    if (state.lastFix) updatePosition(state.lastFix);
  });
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => {
      applyTransforms();
      if (state.lastFix) updatePosition(state.lastFix);
    });
    observer.observe(el.map);
  }
}

async function start() {
  bindEvents();
  state.geojson = await fetch("/data/us-states.geojson").then(res => res.json());
  await loadState();
  renderMap();
  setStatus("Ready");
}

start().catch(error => setStatus(error.message));
