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
 * explicitly (the card's Follow, a spoken "track").
 *
 * One thing is selected at a time across these layers. A layer that selects
 * says so (`claimSelection`); every other layer hears it
 * (`onSelectionChanged`) and lets its own selection go, leaving the camera
 * alone unless it follows that layer's own target.
 */
import { eastNorthUp, framePoint } from '../geo/index.js';
import { findCamera } from '../render/rendererOf.js';
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

/**
 * Fly the camera, keeping its distance and angle, to where it sees `at` in
 * the middle: the eye moves on a straight path and the view turns not at all.
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
  camera.cancelFlight();
  camera.flyTo(framePoint(eastNorthUp(at), kept), {
    orientation: { direction: pose.direction, up: pose.up },
    durationS: durationS > 0 ? durationS : CLICK_CENTER_S,
    easing: 'cubicInOut',
    // Below both ends: no arc, so the camera does not climb on the way.
    maxHeight: 0,
  });
  return true;
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
 *   Where the thing is `aheadMs` from now (ECEF). Something that barely
 *   moves may ignore `aheadMs`.
 * @param {{durationS?: number}} [options]
 * @returns {boolean} Whether the camera was sent.
 */
export function centerOnClick(
  viewer,
  positionAt,
  { durationS = CLICK_CENTER_S } = {},
) {
  if (!viewer || typeof positionAt !== 'function' || cockpitHoldsCamera())
    return false;
  const camera = findCamera(viewer);
  if (!camera) return false;
  let at = null;
  try {
    at = positionAt(durationS * 1000);
    if (!isPoint(at)) at = positionAt(0);
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
  listeners.clear();
}
