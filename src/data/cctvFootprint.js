/**
 * Pure monitor-plane footprint math shared by the client geometry
 * (src/layers/cctv/geometry.js), the server sidecar join
 * (server/providers/cctv/groundHeights.js) and the offline precompute
 * (scripts/precompute-cctv-heights.mjs). Lives outside every ownership
 * package on purpose. No Cesium, no DOM: the same function
 * decides where a plane's support points are on the ground for both.
 *
 * The plane is the pitched far cap of the camera frustum: center at range R
 * along the heading (horizontal R·cos(pitch)), half-width R·tan(hFov/2),
 * half-height R·tan(vFov/2) with vFov from a 16:9 aspect, tilted by the
 * pitch. Support points are a 3×3 grid over that rectangle: rows bottom /
 * middle / top, columns left / center / right, named `bl bm br ml mc mr tl tm
 * tr`. Their horizontal positions depend on the pose only, never on ground
 * height, so an offline job can sample the ground under them for the nominal
 * pose and the client can reuse those samples as long as the pose is the same.
 */

const EARTH_RADIUS_M = 6371000;
export const PLANE_VERT_ASPECT = 16 / 9;
export const SUPPORT_KEYS = Object.freeze([
  'bl',
  'bm',
  'br',
  'ml',
  'mc',
  'mr',
  'tl',
  'tm',
  'tr',
]);

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Offset a lat/lon by a distance along a compass heading (spherical earth;
 * sub-centimetre at the ≤ 5 km ranges cameras use).
 * @param {number} lat @param {number} lon @param {number} headingDeg @param {number} distM
 * @returns {{lat:number, lon:number}}
 */
export function projectPoint(lat, lon, headingDeg, distM) {
  const b = toRad(headingDeg);
  const la = toRad(lat);
  const lo = toRad(lon);
  const ad = distM / EARTH_RADIUS_M;
  const la2 = Math.asin(
    Math.sin(la) * Math.cos(ad) + Math.cos(la) * Math.sin(ad) * Math.cos(b),
  );
  const lo2 =
    lo +
    Math.atan2(
      Math.sin(b) * Math.sin(ad) * Math.cos(la),
      Math.cos(ad) - Math.sin(la) * Math.sin(la2),
    );
  return { lat: toDeg(la2), lon: toDeg(lo2) };
}

/**
 * Plane dimensions and offsets for a pose, before any ground is known.
 * @param {{pitchDeg:number, fovDeg:number, rangeM:number}} pose
 * @returns {{R:number, pitch:number, halfW:number, halfH:number, horiz:number,
 *   vert:number, upVert:number, upHoriz:number, vFovDeg:number}}
 */
export function planeDimensions(pose) {
  const R = Math.max(1, Number(pose.rangeM) || 1);
  const pitch = toRad(Math.max(-89, Math.min(89, Number(pose.pitchDeg) || 0)));
  const hFov = toRad(Math.max(8, Math.min(160, Number(pose.fovDeg) || 74)));
  const halfW = R * Math.tan(hFov / 2);
  const vFovRad = 2 * Math.atan(Math.tan(hFov / 2) / PLANE_VERT_ASPECT);
  const halfH = R * Math.tan(vFovRad / 2);
  return {
    R,
    pitch,
    halfW,
    halfH,
    horiz: R * Math.cos(pitch),
    vert: R * Math.sin(pitch),
    // In-plane "up", decomposed into a vertical part and a horizontal part
    // along the heading (a downward pitch tilts the plane's top forward).
    upVert: Math.cos(pitch) * halfH,
    upHoriz: -Math.sin(pitch) * halfH,
    vFovDeg: toDeg(vFovRad),
  };
}

/**
 * Horizontal (lat/lon) positions of the mount and the nine plane support
 * points for a pose. Altitudes are not part of this: the caller adds the
 * ground it measured under each point.
 * @param {{lat:number, lon:number, headingDeg:number, pitchDeg:number,
 *   fovDeg:number, rangeM:number}} pose
 * @returns {{mount:{lat:number,lon:number}, capCenter:{lat:number,lon:number},
 *   supports: Record<string,{lat:number,lon:number, row:-1|0|1, col:-1|0|1}>}}
 */
export function planeSupportPoints(pose) {
  const dims = planeDimensions(pose);
  const heading = Number(pose.headingDeg) || 0;
  const cap = projectPoint(pose.lat, pose.lon, heading, dims.horiz);
  const supports = {};
  const rows = { b: -1, m: 0, t: 1 };
  // Column letter: l / r, with the centre spelled `m` in the bottom and top
  // rows (bm, tm) and `c` in the middle row (mc).
  const cols = { l: -1, m: 0, c: 0, r: 1 };
  for (const key of SUPPORT_KEYS) {
    const row = rows[key[0]];
    const col = cols[key[1]];
    const across = projectPoint(
      cap.lat,
      cap.lon,
      heading + 90,
      col * dims.halfW,
    );
    const along = projectPoint(
      across.lat,
      across.lon,
      heading,
      row * dims.upHoriz,
    );
    supports[key] = { lat: along.lat, lon: along.lon, row, col };
  }
  return { mount: { lat: pose.lat, lon: pose.lon }, capCenter: cap, supports };
}

/**
 * Altitude of the plane at a support point, given the plane center altitude:
 * the rigid rectangle's rows sit ± upVert around the center.
 * @param {number} capAltM @param {-1|0|1} row @param {{upVert:number}} dims
 * @returns {number}
 */
export function supportAltitude(capAltM, row, dims) {
  return capAltM + row * dims.upVert;
}

/**
 * The single rigid lift (metres, ≥ 0) that puts every support point at least
 * `clearanceM` above the ground measured under it. Support points without a
 * measured ground fall back to `fallbackGroundM` (normally the ground at the
 * mount), which is what makes the pre-precompute path deterministic instead
 * of buried.
 * @param {number} capAltM - Unlifted plane center altitude.
 * @param {{upVert:number}} dims
 * @param {Record<string, number>|null|undefined} groundUnder - support key → ground altitude.
 * @param {number} fallbackGroundM
 * @param {number} clearanceM
 * @returns {{liftM:number, limitingKey:string|null}}
 */
export function requiredPlaneLift(
  capAltM,
  dims,
  groundUnder,
  fallbackGroundM,
  clearanceM,
) {
  let liftM = 0;
  let limitingKey = null;
  const rows = { b: -1, m: 0, t: 1 };
  for (const key of SUPPORT_KEYS) {
    const raw = groundUnder ? groundUnder[key] : undefined;
    // Strict: a null/absent support must fall back, not read as 0 m.
    const ground =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : fallbackGroundM;
    if (!Number.isFinite(ground)) continue;
    const alt = supportAltitude(capAltM, rows[key[0]], dims);
    const deficit = ground + clearanceM - alt;
    if (deficit > liftM) {
      liftM = deficit;
      limitingKey = key;
    }
  }
  return { liftM, limitingKey };
}

/**
 * Stable hash of the nominal pose a footprint was sampled for, so shipped
 * samples are only reused while the pose they describe is unchanged.
 * @param {{lat:number, lon:number, headingDeg:number, pitchDeg:number,
 *   fovDeg:number, rangeM:number, mountHeightM:number}} pose
 * @returns {string}
 */
export function poseHash(pose) {
  const text = [
    Number(pose.lat).toFixed(6),
    Number(pose.lon).toFixed(6),
    Number(pose.headingDeg).toFixed(1),
    Number(pose.pitchDeg).toFixed(1),
    Number(pose.fovDeg).toFixed(1),
    Number(pose.rangeM).toFixed(1),
    Number(pose.mountHeightM).toFixed(1),
  ].join('|');
  // FNV-1a 32-bit, base36: short, stable, dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p1-${h.toString(36)}`;
}
