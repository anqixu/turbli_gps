// Map projections and great-circle routes.
//
// Every projection is cylindrical: x depends only on longitude and y only on
// latitude, in radians-scale units with y pointing north. Turbli's US and
// Europe maps are Mercator; its World map is Miller cylindrical.

const MERCATOR_MAX_LAT = 85.05112878;
const DEG = Math.PI / 180;

const PROJECTIONS = {
  mercator: {
    label: "Mercator",
    forward: (lon, lat) => [
      lon * DEG,
      Math.log(Math.tan(Math.PI / 4 + Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * DEG / 2))
    ],
    inverse: (x, y) => [x / DEG, (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG]
  },
  miller: {
    label: "Miller",
    forward: (lon, lat) => [lon * DEG, 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * DEG))],
    inverse: (x, y) => [x / DEG, (2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI) / DEG]
  },
  equirect: {
    label: "Equirectangular",
    forward: (lon, lat) => [lon * DEG, lat * DEG],
    inverse: (x, y) => [x / DEG, y / DEG]
  }
};

function toVector(lon, lat) {
  const cosLat = Math.cos(lat * DEG);
  return [cosLat * Math.cos(lon * DEG), cosLat * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

// Returns [lon, lat] points along the great circle from a to b. Longitudes are
// unwrapped (they may run past +-180) so the line never jumps across the map.
function greatCircle(a, b, segments = 128) {
  const va = toVector(a.lon, a.lat);
  const vb = toVector(b.lon, b.lat);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const angle = Math.acos(dot);
  const points = [];
  let previousLon = a.lon;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wa = angle < 1e-9 ? 1 - t : Math.sin((1 - t) * angle) / Math.sin(angle);
    const wb = angle < 1e-9 ? t : Math.sin(t * angle) / Math.sin(angle);
    const v = [0, 1, 2].map(k => wa * va[k] + wb * vb[k]);
    let lon = Math.atan2(v[1], v[0]) / DEG;
    const lat = Math.atan2(v[2], Math.hypot(v[0], v[1])) / DEG;
    lon += 360 * Math.round((previousLon - lon) / 360);
    previousLon = lon;
    points.push([lon, lat]);
  }
  return points;
}

// Returns [lon, lat] points with longitudes unwrapped like greatCircle's, so a
// track across the antimeridian stays continuous.
function unwrapLongitudes(points) {
  let previousLon = points.length ? points[0][0] : 0;
  return points.map(([lon, lat]) => {
    lon += 360 * Math.round((previousLon - lon) / 360);
    previousLon = lon;
    return [lon, lat];
  });
}

// Returns [minLon, minLat, maxLon, maxLat] around points, padded for context.
function paddedBbox(points) {
  const lons = points.map(p => p[0]);
  const lats = points.map(p => p[1]);
  const [minLon, maxLon, minLat, maxLat] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const lonPad = Math.max(4, (maxLon - minLon) * 0.12);
  const latPad = Math.max(3, (maxLat - minLat) * 0.25);
  return [minLon - lonPad, Math.max(-80, minLat - latPad), maxLon + lonPad, Math.min(84, maxLat + latPad)];
}
