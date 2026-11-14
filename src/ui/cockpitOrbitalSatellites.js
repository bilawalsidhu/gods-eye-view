/**
 * The satellites around the one the Cockpit's orbital view rides: the
 * nearest ones for the Live Signals rows, and riding one of them (or going
 * back to the one before) from its row. The view stays in orbit: the
 * satellites layer tracks the
 * new satellite, the Cockpit takes the camera straight back, any ground
 * focus ends, and the camera hops along the great circle to the new
 * satellite. Bound to the Cockpit controller like the orbital view itself.
 */
import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';
import { zoomTransitionProgress } from '../cockpitOrbital.js';
import {
  ORBITAL_HOP_MS,
  ORBITAL_SATELLITES_MAX,
  hopPosition,
} from '../cockpitOrbitalSatellites.js';

/** Whether the user asked for reduced motion: hops then cut. */
function prefersReducedMotion() {
  return Boolean(
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  );
}

function inOrbit(controller) {
  return (
    controller.active &&
    !controller.destroyed &&
    controller.subjectKind === 'satellite' &&
    Boolean(controller.orbital)
  );
}

/** The satellites ridden in this orbital visit, oldest first. */
function visits(controller) {
  const state = controller.orbital;
  if (!Array.isArray(state.visits)) state.visits = [];
  const current = controller.subjectId;
  if (current !== null && current !== undefined && !state.visits.length)
    state.visits.push(current);
  return state.visits;
}

/**
 * The satellites nearest the ridden one, nearest first (debris left out):
 * the layer's bounded nearest query, measured from the satellite itself
 * (not the camera, which may still be hopping to it).
 * @returns {Array<object>} As the layer's `getNearestPositions`.
 */
export function orbitalNearbySatellites() {
  const layer = this.services?.satellitesLayer;
  if (typeof layer?.getNearestPositions !== 'function') return [];
  try {
    const from = layer.getCockpitPosition?.();
    if (!from) return [];
    return (
      layer.getNearestPositions(from, ORBITAL_SATELLITES_MAX, {
        excludeIds: [this.subjectId],
        excludeClasses: ['debris'],
      }) || []
    );
  } catch {
    return [];
  }
}

/**
 * The satellite ridden before this one in this orbital visit, or null.
 * @returns {number|string|null}
 */
export function previousOrbitalSatellite() {
  if (!inOrbit(this)) return null;
  const ridden = visits(this);
  return ridden.length > 1 ? ridden[ridden.length - 2] : null;
}

/**
 * Ride the satellite a Live Signals row names: back to the one ridden before
 * (its RETURN row), or on to another, remembered so RETURN can come back.
 * @param {number|string} noradId
 * @returns {boolean} True when the ridden satellite changed.
 */
export function rideOrbitalSatellite(noradId) {
  if (!inOrbit(this)) return false;
  const ridden = visits(this);
  const back = ridden.length > 1 ? ridden[ridden.length - 2] : null;
  if (back !== null && String(back) === String(noradId)) {
    if (!switchOrbitalSatellite.call(this, back)) {
      // It left the catalogue: forget it, so RETURN offers the one before.
      ridden.splice(ridden.length - 2, 1);
      this.refreshOrbitalSignals?.();
      return false;
    }
    ridden.pop();
  } else {
    if (!switchOrbitalSatellite.call(this, noradId)) return false;
    ridden.push(this.subjectId);
  }
  // The RETURN row follows the history just changed.
  this.refreshOrbitalSignals?.();
  return true;
}

/**
 * Ride another satellite without leaving orbit. The satellites layer tracks
 * it (as a click on its point would); the Cockpit takes the camera back at
 * once, ends any ground focus with the view back at nadir, and starts the
 * hop from where the camera is.
 * @param {number|string} noradId
 * @returns {boolean} True when the ridden satellite changed.
 */
export function switchOrbitalSatellite(noradId) {
  if (!inOrbit(this)) return false;
  if (String(noradId) === String(this.subjectId)) return false;
  const layer = this.services?.satellitesLayer;
  const state = this.orbital;
  const from = state.focusFrame?.position ?? null;
  let tracked = false;
  try {
    tracked = Boolean(layer?.trackById?.(noradId, { origin: 'user' }));
  } catch {
    tracked = false;
  }
  // Tracking hands the camera to Cesium's follow; the orbital view keeps it.
  this.viewer.trackedEntity = undefined;
  const info = tracked ? this.readSatelliteInfo() : null;
  if (!info || String(info.noradId) !== String(noradId)) {
    // Nothing changed hands, or the layer could not take it: the view ends
    // on the next frame rather than ride something it did not ask for.
    return false;
  }
  layer.setCockpitSubject?.(info.noradId);
  this.subjectId = info.noradId;
  state.focus = null;
  state.focusReleasing = !prefersReducedMotion();
  state.lookTarget = { yawDeg: 0, pitchDeg: 0 };
  if (!state.focusReleasing) state.lookView = { yawDeg: 0, pitchDeg: 0 };
  state.hop =
    from && !prefersReducedMotion()
      ? { from: { ...from }, startMs: performance.now() }
      : null;
  // The rows measure from the camera's frame, still the old satellite's:
  // until the camera is on the new one, they list no sites or satellites.
  state.awaitingFrame = true;
  state.previousUp = null;
  // The field of view is still the old satellite's until the next frame; the
  // HUD published below sizes the strip from the settled zoom meanwhile.
  state.verticalFov = null;
  state.place = undefined;
  state.placeTracker?.reset?.();
  state.prefetched?.clear?.();
  this.lastHudUpdateMs = 0;
  this.lastContextUpdateMs = 0;
  this.dispatchCockpitModeChanged(true, info);
  // The new satellite's TRACK ACQUIRED replaces the old one, time and all.
  this.signalItems = this.signalItems.filter((item) => item.key !== 'track');
  this.signalSignatures.delete('track');
  this.pushCockpitSignal(
    'track',
    'track',
    t('TRACK ACQUIRED'),
    t('{label} · NADIR VIEW', { label: info.name }),
  );
  this.updateOrbitalHud(info);
  this.refreshOrbitalSignals?.();
  return true;
}

/**
 * Where the camera is this frame: on the satellite, or part-way along a hop
 * to it, eased like a zoom step. The hop ends when it lands.
 * @param {object} state The orbital session.
 * @param {Cesium.Cartesian3} position The ridden satellite this frame.
 * @param {number} nowMs
 * @returns {Cesium.Cartesian3}
 */
export function orbitalEyePosition(state, position, nowMs) {
  const hop = state.hop;
  if (!hop) return position;
  const progress = zoomTransitionProgress(nowMs - hop.startMs, {
    durationMs: ORBITAL_HOP_MS,
  });
  if (progress >= 1) {
    state.hop = null;
    return position;
  }
  const eye = hopPosition(hop.from, position, progress);
  if (!eye) {
    state.hop = null;
    return position;
  }
  return new Cesium.Cartesian3(eye.x, eye.y, eye.z);
}
