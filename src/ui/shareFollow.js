import { findCamera, findFrame } from '../render/rendererOf.js';
import { followedOf, followedPosition } from '../data/followed.js';
import { toLonLatH } from '../geo/ellipsoid.js';
import {
  eastNorthUp,
  framePoint,
  frameVector,
  inverseFramePoint,
  inverseFrameVector,
  isIdentity,
  offsetFromHeadingPitchRange,
} from '../geo/frames.js';
import {
  add,
  cross,
  dot,
  magnitude,
  negate,
  normalize,
  scale,
  sub,
  vec,
} from '../geo/vector.js';
import { createFrameWait } from '../time/frameWait.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  SHARE_VIEW_FOLLOW_RANGE_MAX_M,
  followOffsetFor,
  followOffsetFromEnu,
  followOffsetToEnu,
} from '../share/follow.js';

/**
 * The bridge between the camera following an entity and a share link's thing
 * view: what the camera follows now, in the share format's terms, and the
 * stored follow offset applied to an entity the camera has started to follow.
 */

const KIND_BY_LAYER = new Map(
  SHARE_VIEW_ENTITY_KINDS.map((entry) => [entry.layerId, entry.kind]),
);
/** Drawn time (ms) to wait for the follow to frame the entity. */
const MAX_FRAMING_WAIT_MS = 2_000;
const EPSILON10 = 1e-10;

/** Where `followed` is shown now, as an ECEF position, or null. */
function shownAt(viewer, followed) {
  const p = followedPosition(viewer, followed);
  return p ? vec(p.x, p.y, p.z) : null;
}

/** `position`'s local east/north/up offset from `origin`, in metres. */
function enuOffset(origin, position) {
  const local = inverseFramePoint(eastNorthUp(origin), position);
  return { east: local.x, north: local.y, up: local.z };
}

/** A column-major 4×4 frame-to-ECEF matrix as a frame of axes and origin. */
const frameOfMatrix = (m) => ({
  x: vec(m[0], m[1], m[2]),
  y: vec(m[4], m[5], m[6]),
  z: vec(m[8], m[9], m[10]),
  origin: vec(m[12], m[13], m[14]),
});

/** The frame the camera's eye is in now, or null when it cannot say. */
function eyeFrame(camera) {
  const matrix = camera?.followFrame?.();
  return matrix ? frameOfMatrix(matrix) : null;
}

/** The angle between two vectors, as the default renderer measures it. */
function angleBetween(a, b) {
  const unitA = normalize(a);
  const unitB = normalize(b);
  return Math.atan2(magnitude(cross(unitA, unitB)), dot(unitA, unitB));
}

/**
 * The eye at `offset` in `frame`, looking at the frame's origin with the
 * frame's z as up, in the world: where a look at a frame's origin from an
 * offset puts it.
 */
function lookingAtOrigin(frame, offset) {
  const direction = normalize(negate(offset));
  let right = cross(direction, vec(0, 0, 1));
  if (dot(right, right) < EPSILON10) right = vec(1, 0, 0);
  right = normalize(right);
  const up = normalize(cross(right, direction));
  return {
    position: framePoint(frame, offset),
    direction: frameVector(frame, direction),
    up: frameVector(frame, up),
  };
}

/**
 * The heading, pitch and roll that turn the east-north-up frame at
 * `position` onto `direction` and `up`, exactly: straight down included,
 * where a renderer reading angles off a direction rounds the roll away.
 */
function anglesAt(position, direction, up) {
  const enu = eastNorthUp(position);
  const d = inverseFrameVector(enu, direction);
  const u = inverseFrameVector(enu, up);
  // From both components: near straight down `asin` would lose precision.
  const pitch = Math.atan2(d.z, Math.hypot(d.x, d.y));
  // Straight up or down, any heading will do: the roll takes the rest.
  const a = Math.abs(d.x) + Math.abs(d.y) > 0 ? Math.atan2(d.y, d.x) : 0;
  const across = vec(-Math.sin(a), Math.cos(a), 0);
  const lifted = vec(
    Math.cos(a) * -Math.sin(pitch),
    Math.sin(a) * -Math.sin(pitch),
    Math.cos(pitch),
  );
  return {
    heading: Math.PI / 2 - a,
    pitch,
    roll: Math.atan2(-dot(u, across), dot(u, lifted)),
  };
}

/** Put the eye at a world pose, keeping the frame the camera is in. */
function placeEye(camera, eye) {
  camera.setView({
    destination: eye.position,
    orientation: anglesAt(eye.position, eye.direction, eye.up),
  });
}

/** Degrees to the share format's 10⁻⁴-degree coordinate precision. */
const toCoordinate = (degrees) => Math.round(degrees * 1e4) / 1e4;

/**
 * The selected vessel as a thing view's subject: its drawn position as the
 * last-known fix, and the follow offset that puts the derived camera
 * (followCameraFor) where the camera is now. The offset is computed from the
 * fix at the format's precision, so the opened link's camera matches this
 * one to within the offset's whole metres and degrees. Null when the offset
 * cannot carry the camera (it is not above the vessel's horizon, or its range
 * is outside 1 m to SHARE_VIEW_FOLLOW_RANGE_MAX_M): the link is then a place
 * view.
 */
function selectedVesselSubject(cameraPosition, vessel, nowMs) {
  const id = String(vessel?.id || '');
  if (!id || !vessel.position) return null;
  const fixAt = toLonLatH(vessel.position);
  const cameraAt = toLonLatH(cameraPosition);
  if (!fixAt || !cameraAt) return null;
  const lastKnown = {
    lat: toCoordinate(fixAt.lat),
    lon: toCoordinate(fixAt.lon),
    alt: Math.round(fixAt.height),
    observedAtMs: Number.isFinite(vessel.observedAtMs)
      ? vessel.observedAtMs
      : nowMs,
  };
  const offset = followOffsetFor(lastKnown, {
    lat: cameraAt.lat,
    lon: cameraAt.lon,
    alt: cameraAt.height,
  });
  if (
    !offset ||
    !(offset.range >= 1 && offset.range <= SHARE_VIEW_FOLLOW_RANGE_MAX_M)
  )
    return null;
  return { kind: 'vessel', id, offset, lastKnown };
}

/**
 * The entity a share link made now names, as `{ kind, id, offset, lastKnown }`:
 * the entity the camera follows, with the camera's offset from it and its
 * displayed position as of `nowMs`; else, while the camera follows nothing,
 * the selected vessel (`readSelectedVessel()`, the vessel layer's
 * `getSelectedFix()`). A selected vessel is not followed (the camera stays
 * where the user puts it), so its offset is the one that derives the camera
 * where it is now. Null when there is nothing a share link can name.
 */
export function readShareFollowSubject({
  viewer,
  nowMs = Date.now(),
  readSelectedVessel = null,
}) {
  const cameraPosition = viewer ? findCamera(viewer)?.pose().position : null;
  if (!cameraPosition) return null;
  const followed = followedOf(viewer);
  if (!followed) {
    const vessel = readSelectedVessel?.() ?? null;
    return vessel ? selectedVesselSubject(cameraPosition, vessel, nowMs) : null;
  }
  const trackedId = String(followed.key || '');
  const separator = trackedId.indexOf(':');
  if (separator <= 0) return null;
  const kind = KIND_BY_LAYER.get(trackedId.slice(0, separator));
  const id = trackedId.slice(separator + 1);
  const target = kind ? shownAt(viewer, followed) : null;
  if (!kind || !id || !target) return null;
  const offset = followOffsetFromEnu(enuOffset(target, cameraPosition));
  const fix = toLonLatH(target);
  if (!offset || !fix) return null;
  return {
    kind,
    id,
    offset,
    lastKnown: {
      lat: fix.lat,
      lon: fix.lon,
      alt: fix.height,
      observedAtMs: nowMs,
    },
  };
}

/** Largest turn, in radians, the camera makes around the entity per frame. */
const MAX_TURN_PER_FRAME = Math.PI / 3;

/**
 * Put the camera at a shared follow offset from `followed` (what
 * `followedOf` gave) once following it has framed the camera. The renderer keeps the offset afterwards, as it keeps one
 * the user orbits to. The camera swings round the entity at most 60° a frame:
 * the follow's own guard treats a jump to the far side as the camera crossing
 * through the entity and puts it back. Returns a disposer.
 */
export function applyShareFollowOffset(viewer, followed, offset) {
  const frames = viewer ? findFrame(viewer) : null;
  if (!frames || !followed || !(offset?.range > 0)) return () => {};
  const local = followOffsetToEnu(offset);
  let count = 0;
  const framingWait = createFrameWait(MAX_FRAMING_WAIT_MS);
  let remove = null;
  const stop = () => {
    remove?.();
    remove = null;
  };
  remove = frames.on('preUpdate', () => {
    if (followedOf(viewer) !== followed) {
      stop();
      return;
    }
    count += 1;
    // Let the follow frame the camera first (its first frame), then move it.
    const camera = findCamera(viewer);
    const frame = eyeFrame(camera);
    const ported = camera?.followed === followed;
    const framed =
      count > 1 &&
      (ported ? camera.followFramed : frame !== null && !isIdentity(frame));
    const target = framed && frame ? shownAt(viewer, followed) : null;
    if (!target) {
      if (framingWait.tick()) stop();
      return;
    }
    // The offset is east/north/up at the entity; the follow's own frame may
    // differ, so place the camera in world space and re-express it there.
    const world = framePoint(
      eastNorthUp(target),
      vec(local.east, local.north, local.up),
    );
    const goal = inverseFramePoint(frame, world);
    const from =
      (ported && camera.followOffset.get()) ||
      inverseFramePoint(frame, camera.pose().position);
    const angle = magnitude(from) > 0 ? angleBetween(from, goal) : 0;
    const done = !(angle > MAX_TURN_PER_FRAME);
    const next = done ? goal : turnToward(from, goal, MAX_TURN_PER_FRAME);
    // Through the port when it follows: its close-range guard keeps the eye.
    if (ported) camera.followOffset.set(next);
    else placeEye(camera, lookingAtOrigin(frame, next));
    if (done) stop();
  });
  return stop;
}

/**
 * `from` turned `step` radians toward `to`, with its length moved the same
 * fraction of the way: one frame of the swing round the entity.
 */
function turnToward(from, to, step) {
  const angle = angleBetween(from, to);
  const unitFrom = normalize(from);
  // The direction perpendicular to `from` in the plane toward `to` (or any
  // perpendicular when they are opposite).
  let toward = sub(normalize(to), scale(unitFrom, Math.cos(angle)));
  if (magnitude(toward) < 1e-9)
    toward = cross(
      unitFrom,
      Math.abs(unitFrom.z) < 0.9 ? vec(0, 0, 1) : vec(1, 0, 0),
    );
  toward = normalize(toward);
  const length =
    magnitude(from) + (magnitude(to) - magnitude(from)) * (step / angle);
  const direction = add(
    scale(unitFrom, Math.cos(step)),
    scale(toward, Math.sin(step)),
  );
  return scale(direction, length);
}

/**
 * Put the eye of a camera that follows something at `offset` (heading,
 * pitch, range) from `target`, keeping the follow's own reference frame
 * (a satellite's included): the follow's next update carries the new offset
 * along with the target. False when the camera cannot say which frame it
 * is in.
 * @param {object} viewer
 * @param {{x: number, y: number, z: number}} target
 * @param {{heading: number, pitch: number, range: number}} offset
 */
export function placeFollowEye(viewer, target, offset) {
  const camera = findCamera(viewer);
  if (!eyeFrame(camera)) return false;
  // Where looking at `target` from `offset` in its east-north-up frame puts
  // the eye, placed in the world while the camera stays in its frame.
  placeEye(
    camera,
    lookingAtOrigin(
      eastNorthUp(vec(target.x, target.y, target.z)),
      offsetFromHeadingPitchRange(offset.heading, offset.pitch, offset.range),
    ),
  );
  return true;
}
