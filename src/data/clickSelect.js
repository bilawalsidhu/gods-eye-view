/**
 * @module data/clickSelect
 * @description The one rule for a click on a moving thing on the map (an
 * aircraft, a satellite, a vessel, a train, a transit vehicle): the click
 * selects it and centres it once. It does not follow it.
 *
 * Centring is one camera flight: the camera keeps its distance and angle and
 * slides so the thing is in the middle when the flight lands. A moving thing
 * is met where it will be then (`positionAt`). After that the camera is the
 * user's again: a drag, pan or zoom moves the map, and the thing stays
 * selected with its card and track. Following is only ever asked for
 * explicitly: the card's Follow, a spoken "track", or a second click on the
 * selected aircraft, satellite or ship (`followOnSecondClick`).
 *
 * One thing is selected at a time across these layers. A layer that selects
 * says so (`claimSelection`); every other layer hears it
 * (`onSelectionChanged`) and lets its own selection go, leaving the camera
 * alone unless it follows that layer's own target.
 */
import {
  cross,
  distance,
  dot,
  eastNorthUp,
  framePoint,
  normalize,
  scale,
  sub,
  toLonLatH,
} from '../geo/index.js';
import { findCamera } from '../render/rendererOf.js';
import { worldClock } from '../time/worldClock.js';
import { stopFollowing } from './followed.js';
import {
  keptViewFrom,
  SELECTION_FOLLOW_TRANSITION_S,
} from './trackedCamera.js';
import { announceNavigationAuthority } from '../navigationPolicy.js';

/** Seconds a click's centring flight takes. */
export const CLICK_CENTER_S = SELECTION_FOLLOW_TRANSITION_S;

const isPoint = (p) =>
  Boolean(p) &&
  Number.isFinite(p.x) &&
  Number.isFinite(p.y) &&
  Number.isFinite(p.z) &&
  p.x * p.x + p.y * p.y + p.z * p.z > 0;

/** Points along a slide of the eye checked for clearing the ground. */
const PATH_SAMPLES = 32;

/** Whether every point between `from` and `to` is at least `floor` m up. */
function lineAbove(from, to, floor) {
  for (let i = 1; i < PATH_SAMPLES; i++) {
    const t = i / PATH_SAMPLES;
    const at = toLonLatH({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    });
    if (!at || at.height < floor) return false;
  }
  return true;
}

/**
 * Whether the eye can slide on a straight line from `from` to `to` and see
 * `at` from there: the slide never drops below half the lower end's height,
 * and nothing of the planet stands between the end and `at`. Short slides
 * always can; a slide of thousands of kilometres can cut under the
 * planet's curve, end under the ground, or end with the planet in the way.
 */
function slideSees(from, to, at) {
  const ends = [toLonLatH(from), toLonLatH(to)];
  if (!ends[0] || !ends[1]) return false;
  const floor = 0.5 * Math.min(ends[0].height, ends[1].height);
  if (!(floor > 0)) return false;
  // The target itself may stand on the ground: the sight line may come
  // down to it, never through the planet.
  return lineAbove(from, to, floor) && lineAbove(to, at, -50);
}

/** Least distance a framing flight stands back from its target, metres. */
const FRAME_MIN_RANGE_M = 2_000;
/** The tilt a framing flight looks down at its target with, at least. */
const FRAME_PITCH = (-45 * Math.PI) / 180;

/**
 * Where a framing flight puts the eye on `at`: on the camera's heading,
 * looking down at it at least 45°, from about the camera's own height (a
 * tenth of a satellite's at least), so the planet is behind it.
 */
function framingOf(pose, at) {
  const enu = eastNorthUp(at);
  const heading = Number.isFinite(pose.heading) ? pose.heading : 0;
  const pitch = Math.min(
    Number.isFinite(pose.pitch) ? pose.pitch : FRAME_PITCH,
    FRAME_PITCH,
  );
  const target = toLonLatH(at);
  const range = Math.max(
    FRAME_MIN_RANGE_M,
    Number.isFinite(pose.height) ? pose.height : 0,
    0.1 * Math.max(0, target?.height ?? 0),
  );
  const look = {
    x: Math.cos(pitch) * Math.sin(heading),
    y: Math.cos(pitch) * Math.cos(heading),
    z: Math.sin(pitch),
  };
  const destination = framePoint(enu, scale(look, -range));
  const direction = normalize(sub(at, destination));
  return {
    destination,
    direction,
    up: squareUp(direction, normalize(at), pose.up),
  };
}

/** `up` made square to `direction`, or the eye's own up (`fallback`). */
function squareUp(direction, up, fallback) {
  for (const candidate of [up, fallback]) {
    const side = cross(direction, candidate);
    const length = Math.hypot(side.x, side.y, side.z);
    if (length > 1e-9)
      return normalize(cross(scale(side, 1 / length), direction));
  }
  return up;
}

/**
 * The latest centring flight: what was selected when it started, where it
 * lands, and whether it has landed. Deselecting what it centres cancels it
 * in flight; once landed, the view it left is the selection's (see
 * `isCentredOnSelection`).
 */
let centring = null;

/**
 * Fly the camera, keeping its distance and angle, to where it sees `at` in
 * the middle: the eye moves on a straight path and the view turns not at all.
 * When that slide would take the eye under the ground, or leave the planet
 * between the eye and the target (a satellite far across the sky seen from
 * close to the surface, an aircraft beyond the horizon), the camera flies
 * to frame the target instead, looking down at it on its own heading.
 * @param {object} camera The camera port.
 * @param {{x: number, y: number, z: number}} at ECEF.
 * @param {number} [durationS]
 * @returns {boolean} Whether a flight started.
 */
export function flyKeepingView(camera, at, durationS = CLICK_CENTER_S) {
  if (!camera || !isPoint(at)) return false;
  const pose = camera.pose();
  const kept = keptViewFrom(pose, at);
  if (!kept) return false;
  let destination = framePoint(eastNorthUp(at), kept);
  let direction = pose.direction;
  let up = pose.up;
  const slides = slideSees(pose.position, destination, at);
  if (!slides) ({ destination, direction, up } = framingOf(pose, at));
  camera.cancelFlight();
  const flight = camera.flyTo(destination, {
    orientation: { direction, up },
    durationS: durationS > 0 ? durationS : CLICK_CENTER_S,
    easing: 'cubicInOut',
    // A slide keeps below both ends: no arc, so the camera does not climb
    // on the way. A framing flight arcs as any long flight does.
    ...(slides ? { maxHeight: 0 } : {}),
  });
  const mine = {
    flight,
    selection: current,
    position: { ...destination },
    direction: { ...direction },
    range: distance(destination, at),
    landed: false,
  };
  centring = mine;
  Promise.resolve(flight?.done)
    .catch(() => {})
    .then(() => {
      mine.landed = true;
    });
  return true;
}

/** Cancel the centring flight of `selection`, if it is still on its way. */
function cancelCentring(selection) {
  if (!centring || centring.selection !== selection) return;
  const { flight, landed } = centring;
  centring = null;
  if (!landed) flight?.cancel?.();
}

/**
 * Whether the camera rests where a click's centring left it, on what is
 * still selected: the view is the selection's, not one to correct.
 * @param {{position: object, direction: object}|null|undefined} pose
 */
export function isCentredOnSelection(pose) {
  if (!centring || !current || centring.selection !== current) return false;
  if (!pose?.position || !pose?.direction) return false;
  // Within what a renderer's own clamps may move a landed camera: a
  // thousandth of the range, a hundredth of a degree.
  return (
    distance(pose.position, centring.position) <
      Math.max(1, 1e-3 * centring.range) &&
    dot(normalize(pose.direction), normalize(centring.direction)) >
      Math.cos(1e-2 * (Math.PI / 180))
  );
}

/**
 * World ms per real ms that the clock `clockId` (a layer's own time, from
 * `worldTimeFor`) runs at now: 1 for a live layer, the playback rate while
 * the world plays, 0 while it is paused or held.
 * @param {string|null|undefined} clockId
 * @param {{getState: () => object}} [clock]
 */
export function clockRateFor(clockId, clock = worldClock) {
  const state = clock?.getState?.();
  if (!clockId || !state || state.live) return 1;
  if (!state.following?.includes?.(clockId)) return 1;
  if (!state.playing || state.buffering) return 0;
  return Number.isFinite(state.rate) && state.rate > 0 ? state.rate : 1;
}

/** Whether the Cockpit holds the camera (it keeps it through a click). */
function cockpitHoldsCamera() {
  return Boolean(
    globalThis.document?.body?.classList?.contains?.('cockpit-mode'),
  );
}

/**
 * Centre a clicked thing once. A follow in progress (of anything) ends, as
 * the click is the user's newest word on the camera; nothing is followed
 * after. The Cockpit keeps the camera: nothing moves there.
 * @param {object} viewer
 * @param {(aheadMs: number) => ({x: number, y: number, z: number}|null)} positionAt
 *   Where the thing is `aheadMs` from now (ECEF) on its layer's own clock.
 *   Something that barely moves may ignore `aheadMs`.
 * @param {{durationS?: number, clockId?: string}} [options] `clockId`: the
 *   layer's clock (`worldTimeFor`'s id), so the lead is the time that
 *   passes on it while the camera flies: the flight's length at the
 *   playback rate, none while it is paused.
 * @returns {boolean} Whether the camera was sent.
 */
export function centerOnClick(
  viewer,
  positionAt,
  { durationS = CLICK_CENTER_S, clockId = null } = {},
) {
  if (!viewer || typeof positionAt !== 'function' || cockpitHoldsCamera())
    return false;
  const camera = findCamera(viewer);
  if (!camera) return false;
  let at = null;
  try {
    const aheadMs = durationS * 1000 * clockRateFor(clockId);
    at = positionAt(aheadMs);
    if (!isPoint(at) && aheadMs !== 0) at = positionAt(0);
  } catch {
    at = null;
  }
  if (!isPoint(at)) return false;
  stopFollowing(viewer);
  // The click supersedes a search or a fly-to still on its way, as a
  // vessel's focus does; a pending shared selection is the layer's to drop.
  announceNavigationAuthority('click-select', {
    cancelPendingSelection: false,
  });
  return flyKeepingView(camera, at, durationS);
}

/**
 * A click on the thing that is already selected: the second click follows
 * it, the same follow the card's Follow starts. A click on the thing the
 * camera already follows keeps following it, as it was (no toggle, no
 * fresh framing). The Cockpit keeps the camera: nothing changes there.
 * @param {string} layerId The clicked thing's layer.
 * @param {string|number} id The clicked thing's id in that layer.
 * @param {{isFollowed: () => boolean, follow: () => unknown}} layer The
 *   layer's own follow: whether the camera follows the thing now, and
 *   following it.
 * @returns {boolean} Whether a follow was started.
 */
export function followOnSecondClick(layerId, id, { isFollowed, follow }) {
  if (
    !current ||
    current.layerId !== String(layerId) ||
    current.id !== String(id) ||
    cockpitHoldsCamera()
  )
    return false;
  if (isFollowed()) return false;
  // A centring flight still on its way gives way to the follow.
  cancelCentring(current);
  return Boolean(follow());
}

/** @type {Selection|null} */
let current = null;
const listeners = new Set();

/**
 * @typedef {object} Selection
 * @property {string} layerId The layer whose thing is selected.
 * @property {string|null} id The thing's id in that layer.
 * @property {object|null} subject What the selected-thing card shows for it
 *   (a `Followed`, src/data/followed.js), when the layer draws that card.
 * @property {string} origin Who selected it: 'user' for a click, else the
 *   selecting path's own origin ('voice', 'tool', 'share-restore', ...).
 */

/**
 * Say `layerId` has selected `id`; every other layer lets its selection go.
 * @param {string} layerId
 * @param {string|number|null} id
 * @param {{subject?: object|null, origin?: string}} [options]
 * @returns {Selection}
 */
export function claimSelection(
  layerId,
  id,
  { subject = null, origin = 'user' } = {},
) {
  const previous = current;
  if (previous) cancelCentring(previous);
  current = {
    layerId: String(layerId),
    id: id === null || id === undefined ? null : String(id),
    subject: subject ?? null,
    origin: String(origin || 'user'),
  };
  notify(current, previous);
  return current;
}

/**
 * `layerId` let go of its selection (of `id`, when given): nothing is
 * selected, unless another layer has claimed the selection since.
 * @param {string} layerId
 * @param {string|number} [id]
 */
export function releaseSelection(layerId, id) {
  if (!current || current.layerId !== String(layerId)) return;
  if (id !== undefined && id !== null && current.id !== String(id)) return;
  const previous = current;
  current = null;
  // Deselected while the camera is on its way to it: the camera stops.
  cancelCentring(previous);
  notify(null, previous);
}

/** What is selected now, or null. */
export function currentSelection() {
  return current;
}

/**
 * Run `cb(selection, previous)` whenever the selection changes hands or is
 * let go.
 * @param {(selection: Selection|null, previous: Selection|null) => void} cb
 * @returns {() => void} Off.
 */
export function onSelectionChanged(cb) {
  if (typeof cb !== 'function') return () => {};
  const entry = { cb };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

/**
 * A layer's side of the one-selection rule: `clear()` runs when another
 * layer claims the selection while this one has something selected.
 * @param {string} layerId
 * @param {() => boolean} hasSelection
 * @param {(selection: Selection) => void} clear Let the layer's own
 *   selection go; given the selection that took its place.
 * @returns {() => void} Off.
 */
export function yieldSelectionToOthers(layerId, hasSelection, clear) {
  return onSelectionChanged((selection) => {
    if (!selection || selection.layerId === String(layerId)) return;
    if (hasSelection()) clear(selection);
  });
}

function notify(selection, previous) {
  for (const entry of [...listeners]) {
    if (!listeners.has(entry)) continue;
    try {
      entry.cb(selection, previous);
    } catch (error) {
      console.warn('[clickSelect] selection listener failed', error);
    }
  }
}

/** Forget the selection and every listener (tests). */
export function _resetSelectionForTest() {
  current = null;
  centring = null;
  listeners.clear();
}
