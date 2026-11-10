/**
 * What a share link's thing view follows, and where its camera is: the
 * entity kinds and the follow-offset geometry of the share format
 * (docs/SHARE-LINK-FORMAT.md). Like the rest of the format, every code,
 * default and formula here is permanent.
 *
 * Pure and dependency-free, so the app's follow camera and the codec
 * (viewCodec.js) share one definition.
 */

const freezeAll = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

/**
 * Things a view can follow. `code` is permanent and is also the number of the
 * thing-message field that carries this kind's id, so the kind costs nothing
 * on the wire. `idForm` picks the compact numeric spelling (a 24-bit ICAO
 * address or a decimal number); any other identifier travels as text.
 * `tracking` names the layer-state slot that holds the same selection in the
 * long form.
 */
export const SHARE_VIEW_ENTITY_KINDS = freezeAll([
  {
    code: 1,
    kind: 'aircraft',
    layerId: 'flights',
    idForm: 'hex24',
    tracking: 'flights',
  },
  {
    code: 2,
    kind: 'military_aircraft',
    layerId: 'military',
    idForm: 'hex24',
    tracking: 'military',
  },
  {
    code: 3,
    kind: 'vessel',
    layerId: 'ais-live-vessels',
    idForm: 'decimal',
    tracking: null,
  },
  {
    code: 4,
    kind: 'satellite',
    layerId: 'satellites',
    idForm: 'decimal',
    tracking: 'satellites',
  },
]);
/**
 * The frozen meaning of an omitted follow-offset field. An offset whose
 * fields all equal these is written as nothing, so it decodes as these.
 */
export const SHARE_VIEW_FOLLOW_OFFSET_DEFAULT = Object.freeze({
  range: 2000,
  heading: 0,
  pitch: -35,
});

const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;

/**
 * The camera's offset from a followed entity in the entity's local east,
 * north and up metres: the camera looks along (heading, pitch) at the entity
 * from `range` metres away. Heading is clockwise from north; a negative pitch
 * looks down, so the camera sits above the entity.
 */
export function followOffsetToEnu({ range, heading, pitch }) {
  const horizontal = range * Math.cos(pitch * RAD);
  return {
    east: -horizontal * Math.sin(heading * RAD),
    north: -horizontal * Math.cos(heading * RAD),
    up: -range * Math.sin(pitch * RAD),
  };
}

/** The inverse of {@link followOffsetToEnu}, in whole metres and degrees. */
export function followOffsetFromEnu({ east, north, up }) {
  const range = Math.hypot(east, north, up);
  if (!(range > 0)) return null;
  return {
    range: Math.round(range),
    heading: (Math.round(Math.atan2(-east, -north) / RAD) + 360) % 360,
    pitch: Math.round(Math.asin(Math.max(-1, Math.min(1, -up / range))) / RAD),
  };
}

/** Earth-centred position of (lat, lon, alt) on the format's sphere. */
function toEcef(lat, lon, alt) {
  const r = EARTH_RADIUS_M + alt;
  const cosLat = Math.cos(lat * RAD);
  return [
    r * cosLat * Math.cos(lon * RAD),
    r * cosLat * Math.sin(lon * RAD),
    r * Math.sin(lat * RAD),
  ];
}

/** The local east, north and up unit vectors at (lat, lon). */
function enuBasis(lat, lon) {
  const sinLat = Math.sin(lat * RAD);
  const cosLat = Math.cos(lat * RAD);
  const sinLon = Math.sin(lon * RAD);
  const cosLon = Math.cos(lon * RAD);
  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where the camera sits while following an entity at `fix` from `offset`,
 * and how it looks back at the entity, on a sphere of radius 6 371 000 m. A
 * thing view with a fix stores no camera of its own: this is its camera, and
 * the place a decoder falls back to. Pure, and computed only from values at
 * the format's precision, so encoder and decoder agree.
 */
export function followCameraFor(fix, offset) {
  const local = followOffsetToEnu(offset);
  const at = toEcef(fix.lat, fix.lon, fix.alt);
  const basis = enuBasis(fix.lat, fix.lon);
  const camera = [0, 1, 2].map(
    (i) =>
      at[i] +
      local.east * basis.east[i] +
      local.north * basis.north[i] +
      local.up * basis.up[i],
  );
  const horizontal = Math.hypot(camera[0], camera[1]);
  const lat = Math.atan2(camera[2], horizontal) / RAD;
  const lon = Math.atan2(camera[1], camera[0]) / RAD;
  const alt = Math.hypot(horizontal, camera[2]) - EARTH_RADIUS_M;
  // The view direction, camera to entity, in the camera's own local frame.
  const view = [0, 1, 2].map((i) => at[i] - camera[i]);
  const own = enuBasis(lat, lon);
  const length = Math.hypot(...view);
  if (!(length > 0))
    return { ...fix, heading: offset.heading, pitch: offset.pitch, roll: 0 };
  return {
    lat,
    lon,
    alt,
    heading:
      (Math.atan2(dot(view, own.east), dot(view, own.north)) / RAD + 360) % 360,
    pitch:
      Math.asin(Math.max(-1, Math.min(1, dot(view, own.up) / length))) / RAD,
    roll: 0,
  };
}
