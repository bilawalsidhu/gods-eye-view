/**
 * Portable camera-coverage math: where on the ground public cameras look,
 * and how many look at each spot. Pure functions, no I/O.
 *
 * Each camera's ground footprint is approximated as a horizontal sector:
 * apex at the mount, centred on its heading, opened by its horizontal field
 * of view, reaching its ground range. Poses in the public catalogs are
 * coarse (many headings are guesses), so results carry a confidence split.
 */

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;
const DEFAULT_FOV = 74;
const DEFAULT_RANGE_M = 120;
const DEFAULT_PITCH = -10;
const MAX_CELLS = 400_000;
const LOW_CONFIDENCE = new Set(['', 'low', 'fallback', 'hash', 'id-hash', 'guess', 'unknown']);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Normalize a camera record into a footprint, or null when it has no
 * usable position. Cameras without a heading are reported as unoriented.
 */
export function cameraFootprint(cam) {
  if (!fin(cam?.lat) || !fin(cam?.lon) || (cam.lat === 0 && cam.lon === 0)) return null;
  const fov = Math.max(8, Math.min(160, fin(cam.fovDeg) ? cam.fovDeg : DEFAULT_FOV));
  const pitch = Math.max(-89, Math.min(30, fin(cam.pitchDeg) ? cam.pitchDeg : DEFAULT_PITCH));
  const slant = fin(cam.rangeM) && cam.rangeM > 0 ? cam.rangeM : DEFAULT_RANGE_M / Math.cos(DEFAULT_PITCH * DEG);
  const rangeM = Math.max(20, Math.min(2000, slant * Math.cos(pitch * DEG)));
  const oriented = fin(cam.headingDeg);
  const confidence = String(cam.headingConfidence || '').toLowerCase();
  return {
    id: String(cam.id),
    lat: cam.lat,
    lon: cam.lon,
    headingDeg: oriented ? ((cam.headingDeg % 360) + 360) % 360 : null,
    fovDeg: fov,
    rangeM,
    oriented,
    lowConfidence: !oriented || LOW_CONFIDENCE.has(confidence),
  };
}

/** Sector polygon ([lon, lat] ring, closed) for display. */
export function footprintPolygon(fp, stepDeg = 5) {
  if (!fp.oriented) return null;
  const ring = [[fp.lon, fp.lat]];
  const half = fp.fovDeg / 2;
  const steps = Math.max(2, Math.ceil(fp.fovDeg / stepDeg));
  for (let i = 0; i <= steps; i++) {
    const b = fp.headingDeg - half + (fp.fovDeg * i) / steps;
    ring.push(offset(fp.lat, fp.lon, b, fp.rangeM));
  }
  ring.push([fp.lon, fp.lat]);
  return ring;
}

function offset(lat, lon, bearingDeg, distM) {
  const b = bearingDeg * DEG;
  const la = lat * DEG;
  const ad = distM / EARTH_R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(ad) + Math.cos(la) * Math.sin(ad) * Math.cos(b));
  const lo2 = lon * DEG + Math.atan2(Math.sin(b) * Math.sin(ad) * Math.cos(la), Math.cos(ad) - Math.sin(la) * Math.sin(la2));
  return [lo2 / DEG, la2 / DEG];
}

/** Run-length encode a byte array as [value, count, value, count, ...]. */
export function rle(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let j = i + 1;
    while (j < arr.length && arr[j] === v) j++;
    out.push(v, j - i);
    i = j;
  }
  return out;
}

export function unrle(pairs, length) {
  const out = new Uint8Array(length);
  let k = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    out.fill(pairs[i], k, k + pairs[i + 1]);
    k += pairs[i + 1];
  }
  return out;
}

/**
 * Count overlapping footprints on a grid over a bounding box.
 * @param {object[]} cameras Raw catalog records.
 * @param {{minLat:number,minLon:number,maxLat:number,maxLon:number}} bbox
 * @param {{cellM?: number, includeLowConfidence?: boolean}} [opts]
 */
export function coverageGrid(cameras, bbox, { cellM = 25, includeLowConfidence = true } = {}) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLat = (Math.PI * EARTH_R) / 180;
  const mPerDegLon = mPerDegLat * Math.cos(midLat * DEG);
  let cell = Math.max(5, cellM);
  let rows, cols;
  for (;;) {
    rows = Math.ceil(((bbox.maxLat - bbox.minLat) * mPerDegLat) / cell);
    cols = Math.ceil(((bbox.maxLon - bbox.minLon) * mPerDegLon) / cell);
    if (rows * cols <= MAX_CELLS) break;
    cell *= 1.5;
  }
  const dLat = cell / mPerDegLat;
  const dLon = cell / mPerDegLon;
  const counts = new Uint8Array(rows * cols);
  const footprints = [];
  const summary = { cameras: 0, oriented: 0, lowConfidence: 0, unoriented: 0 };

  for (const cam of cameras) {
    const fp = cameraFootprint(cam);
    if (!fp) continue;
    // Keep cameras whose footprint can reach the box.
    const padLat = fp.rangeM / mPerDegLat;
    const padLon = fp.rangeM / mPerDegLon;
    if (fp.lat < bbox.minLat - padLat || fp.lat > bbox.maxLat + padLat) continue;
    if (fp.lon < bbox.minLon - padLon || fp.lon > bbox.maxLon + padLon) continue;
    summary.cameras++;
    if (!fp.oriented) {
      summary.unoriented++;
      footprints.push(fp);
      continue;
    }
    summary.oriented++;
    if (fp.lowConfidence) summary.lowConfidence++;
    footprints.push(fp);
    if (fp.lowConfidence && !includeLowConfidence) continue;
    const r0 = Math.max(0, Math.floor((fp.lat - padLat - bbox.minLat) / dLat));
    const r1 = Math.min(rows - 1, Math.floor((fp.lat + padLat - bbox.minLat) / dLat));
    const c0 = Math.max(0, Math.floor((fp.lon - padLon - bbox.minLon) / dLon));
    const c1 = Math.min(cols - 1, Math.floor((fp.lon + padLon - bbox.minLon) / dLon));
    const half = fp.fovDeg / 2;
    const r2 = fp.rangeM * fp.rangeM;
    for (let r = r0; r <= r1; r++) {
      const y = (bbox.minLat + (r + 0.5) * dLat - fp.lat) * mPerDegLat;
      for (let c = c0; c <= c1; c++) {
        const x = (bbox.minLon + (c + 0.5) * dLon - fp.lon) * mPerDegLon;
        const d2 = x * x + y * y;
        if (d2 > r2) continue;
        if (d2 > 1) {
          const bearing = (Math.atan2(x, y) / DEG + 360) % 360;
          const diff = Math.abs(((bearing - fp.headingDeg + 540) % 360) - 180);
          if (diff > half) continue;
        }
        const k = r * cols + c;
        if (counts[k] < 255) counts[k]++;
      }
    }
  }

  let covered = 0, multi = 0, maxOverlap = 0;
  for (const v of counts) {
    if (v) covered++;
    if (v > 1) multi++;
    if (v > maxOverlap) maxOverlap = v;
  }
  const cellKm2 = (cell * cell) / 1e6;
  return {
    bbox,
    cellM: cell,
    rows,
    cols,
    dLat,
    dLon,
    counts: rle(counts),
    summary: {
      ...summary,
      coveredKm2: +(covered * cellKm2).toFixed(4),
      multiKm2: +(multi * cellKm2).toFixed(4),
      boxKm2: +(rows * cols * cellKm2).toFixed(4),
      maxOverlap,
    },
    footprints: footprints.map((fp) => ({ ...fp, polygon: footprintPolygon(fp) })),
  };
}
