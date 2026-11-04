/**
 * Ground focus in the Cockpit's orbital view: a click on a mapped point, or
 * FOCUS on the reach list, keeps the camera on that point as the satellite
 * moves; clicking elsewhere, FOCUS again, NADIR or the target leaving the
 * off-nadir reach eases the view back. Also builds the list of mapped points
 * in reach. Bound to the Cockpit controller like the orbital view itself
 * (src/ui/cockpitOrbitalView.js); its state lives on the orbital session, so
 * it ends with the session.
 */
import * as Cesium from 'cesium';
import { clampOrbitalLook, easeLook } from '../cockpitLook.js';
import { offNadirOrientation } from '../cockpitOrbital.js';
import {
  ORBITAL_REACH_LIST_MAX,
  ORBITAL_REACH_REFRESH_MS,
  detailRows,
  easeFocusRemainder,
  focusEaseDtMs,
  focusInReach,
  focusLook,
  geodeticToEcef,
  pointsInReach,
} from '../cockpitOrbitalFocus.js';
import {
  getContextStore,
  isContextRecordActive,
} from '../data/contextStore.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { pickedKindForLayer } from '../data/pickedContext.js';

const NADIR_LOOK = Object.freeze({ yawDeg: 0, pitchDeg: 0 });

/** Only fixed points on the ground are focus targets: no aircraft, ships or satellites. */
const GROUND_KINDS = new Set(['feature', 'fire']);

/** Whether the user asked for reduced motion: focus turns then cut. */
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

/** The layers' on/off state, as `isContextRecordActive` reads it. */
function layerGate(controller) {
  const isLayerEnabled = controller.services?.isLayerEnabled;
  return typeof isLayerEnabled === 'function'
    ? { isEnabled: (layerId) => isLayerEnabled(layerId) !== false }
    : null;
}

/** A context record that is a fixed ground point of a layer that is on. */
function groundRecord(controller, record) {
  if (!record || !isContextRecordActive(record, layerGate(controller)))
    return null;
  if (!GROUND_KINDS.has(pickedKindForLayer(record.layerId))) return null;
  if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude))
    return null;
  return record;
}

/** Where a mapped point is drawn: its rendered anchor, else on the ellipsoid. */
function recordPosition(record) {
  const anchor = record.entity?.__localBaseCartesian;
  if (
    anchor &&
    Number.isFinite(anchor.x) &&
    Number.isFinite(anchor.y) &&
    Number.isFinite(anchor.z)
  )
    return { x: anchor.x, y: anchor.y, z: anchor.z };
  return geodeticToEcef(record.latitude, record.longitude, 0);
}

/** The context record a scene pick landed on, when it is a ground point. */
function pickedGroundRecord(controller, picked) {
  if (!picked) return null;
  const store = getContextStore();
  for (const carrier of [picked.id, picked.primitive?.id, picked.primitive]) {
    const contextId =
      carrier && typeof carrier === 'object' ? carrier.__gevContextId : null;
    if (!contextId) continue;
    const record = groundRecord(controller, store.entities.get(contextId));
    if (record) return record;
  }
  return null;
}

/** The focus look at a record from the last frame's satellite, or null. */
function lookAt(state, record) {
  const frame = state.focusFrame;
  if (!frame) return null;
  return focusLook(frame.nadir, frame.position, recordPosition(record));
}

/**
 * Point the view at a mapped point and keep it there: from the view as it is
 * now, so switching targets turns rather than jumps. A point beyond the
 * reach is refused.
 * @returns {boolean} True when the focus is on that point.
 */
function startFocus(record) {
  const state = this.orbital;
  const look = lookAt(state, record);
  // Before the first frame there is nothing to measure against; the frame
  // that follows checks the reach.
  if (state.focusFrame && !focusInReach(look)) return false;
  state.focus = {
    key: String(record.id),
    label: String(record.label || record.layerName || record.id),
    look,
    // The view minus the target's look, eased away; set on the next frame.
    remainder: null,
  };
  state.focusReleasing = false;
  if (look) state.lookTarget = clampOrbitalLook(look);
  publishOrbitalReach.call(this);
  return true;
}

/**
 * End the focus. The view eases back to nadir on the focus's clock (cut
 * under reduced motion), or with `handOver` stays where it is for an arrow
 * key to tilt on from.
 * @param {{handOver?: boolean}} [options]
 * @returns {boolean} True when a focus was ended.
 */
export function releaseOrbitalFocus({ handOver = false } = {}) {
  const state = this.orbital;
  if (!state?.focus) return false;
  state.focus = null;
  if (handOver) {
    state.lookTarget = clampOrbitalLook(state.lookView);
    state.focusReleasing = false;
  } else {
    state.lookTarget = { ...NADIR_LOOK };
    if (prefersReducedMotion()) {
      state.lookView = { ...NADIR_LOOK };
      state.focusReleasing = false;
    } else state.focusReleasing = true;
  }
  publishOrbitalReach.call(this);
  return true;
}

/**
 * FOCUS on the reach list: focus that point, switch to it from another, or
 * end the focus when it is the one held.
 * @param {string} key The point's context id.
 * @returns {boolean} True when the focus changed.
 */
export function toggleOrbitalFocus(key) {
  if (!inOrbit(this) || key === null || key === undefined) return false;
  const state = this.orbital;
  if (state.focus?.key === String(key)) return releaseOrbitalFocus.call(this);
  const record = groundRecord(
    this,
    getContextStore().entities.get(String(key)),
  );
  return record ? startFocus.call(this, record) : false;
}

/**
 * A click on the orbital picture. One on a mapped ground point in reach
 * focuses it; any other click ends a focus. A click a tool owns (drawing)
 * is left alone, as is every click outside orbit.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @returns {boolean} True when the click focused a point.
 */
export function onOrbitalClick(position) {
  if (!inOrbit(this) || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  let picked = null;
  try {
    picked = this.viewer.scene?.pick?.(position) ?? null;
  } catch {
    picked = null;
  }
  const record = pickedGroundRecord(this, picked);
  const state = this.orbital;
  if (record) {
    if (state.focus?.key === String(record.id)) return true;
    if (startFocus.call(this, record)) return true;
    // A mapped point beyond the reach leaves the view as it is.
    return false;
  }
  releaseOrbitalFocus.call(this);
  return false;
}

/**
 * Take the scene's single click through the orbital focus first, then hand
 * it on to Cesium's own (it picks into `selectedEntity`), as before.
 * @returns {() => void} Puts Cesium's handler back, unless another owner
 *   (the draw tool borrows it) has replaced ours since.
 */
export function routeSceneClick() {
  const handler = this.viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    this.onOrbitalClick(event?.position);
    stock?.(event);
  };
  handler.setInputAction(routed, type);
  return () => {
    if (handler.isDestroyed?.() || handler.getInputAction?.(type) !== routed)
      return;
    if (stock) handler.setInputAction(stock, type);
    else handler.removeInputAction(type);
  };
}

/**
 * The orbital view's look for one frame, while a focus holds or is ending.
 * A held focus aims at its target: the live look plus whatever is left of
 * the turn onto it. The focus ends, easing back, when its point is gone (its
 * layer off, the record dropped) or beyond the reach. Also rebuilds the
 * reach list on its own clock.
 * @param {object} state The orbital session.
 * @param {{direction: object, up: object, right: object}} nadir This
 *   frame's nadir frame.
 * @param {{x: number, y: number, z: number}} position The satellite, ECEF.
 * @param {number} nowMs
 * @returns {boolean} True when it placed `state.lookView` itself.
 */
export function updateOrbitalFocus(state, nadir, position, nowMs) {
  state.focusFrame = {
    nadir,
    position: { x: position.x, y: position.y, z: position.z },
  };
  const dtMs = nowMs - (state.lookLastMs || nowMs);
  let aimed = false;
  const focus = state.focus;
  if (focus) {
    const record = groundRecord(
      this,
      getContextStore().entities.get(focus.key),
    );
    const look = record
      ? focusLook(nadir, state.focusFrame.position, recordPosition(record))
      : null;
    if (!focusInReach(look)) {
      releaseOrbitalFocus.call(this);
    } else {
      focus.look = look;
      const reduced = prefersReducedMotion();
      focus.remainder = focus.remainder
        ? easeFocusRemainder(focus.remainder, dtMs, { immediate: reduced })
        : reduced
          ? { ...NADIR_LOOK }
          : {
              yawDeg: state.lookView.yawDeg - look.yawDeg,
              pitchDeg: state.lookView.pitchDeg - look.pitchDeg,
            };
      state.lookTarget = clampOrbitalLook(look);
      state.lookView = {
        yawDeg: look.yawDeg + focus.remainder.yawDeg,
        pitchDeg: look.pitchDeg + focus.remainder.pitchDeg,
      };
      aimed = true;
    }
  }
  if (nowMs - (state.reachMs ?? -Infinity) >= ORBITAL_REACH_REFRESH_MS)
    publishOrbitalReach.call(this, nowMs);
  return aimed;
}

/**
 * Ease the orbital look toward its target for one frame: the look's own
 * easing, on the focus's slower clock while a focus is easing back.
 * @param {object} state The orbital session.
 * @param {number} dtMs
 * @param {{immediate?: boolean}} [options]
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function easeOrbitalLook(state, dtMs, { immediate = false } = {}) {
  const view = easeLook(
    state.lookView,
    state.lookTarget,
    state.focusReleasing ? focusEaseDtMs(dtMs) : dtMs,
    { immediate },
  );
  if (
    state.focusReleasing &&
    view.yawDeg === state.lookTarget.yawDeg &&
    view.pitchDeg === state.lookTarget.pitchDeg
  )
    state.focusReleasing = false;
  return view;
}

/**
 * The focused target for the HUD: its name and the live look at it, whose
 * single off-nadir angle the readout shows. Null without a focus, or before
 * its first frame.
 * @returns {{key: string, label: string, offNadirDeg: number,
 *   yawDeg: number, pitchDeg: number}|null}
 */
export function orbitalFocusReadout() {
  const focus = this.orbital?.focus;
  if (!focus?.look) return null;
  return {
    key: focus.key,
    label: focus.label,
    offNadirDeg: focus.look.offNadirDeg,
    yawDeg: focus.look.yawDeg,
    pitchDeg: focus.look.pitchDeg,
  };
}

/**
 * Rebuild and publish the list of mapped points in reach: ground points of
 * the layers that are on, facing the satellite and within the off-nadir
 * reach or in the frame now, nearest to nadir first, at most
 * ORBITAL_REACH_LIST_MAX.
 * @param {number} [nowMs]
 */
export function publishOrbitalReach(nowMs = performance.now()) {
  const state = this.orbital;
  if (!inOrbit(this) || !state) return;
  state.reachMs = nowMs;
  const frame = state.focusFrame;
  const records = new Map();
  const candidates = [];
  if (frame) {
    for (const entry of getContextStore().entities.values()) {
      const record = groundRecord(this, entry);
      if (!record) continue;
      const position = recordPosition(record);
      if (!position) continue;
      const key = String(record.id);
      records.set(key, record);
      candidates.push({ key, position });
    }
  }
  const frustum = this.viewer.camera?.frustum;
  const reach = frame
    ? pointsInReach(candidates, {
        nadir: frame.nadir,
        view: offNadirOrientation(frame.nadir, {
          northDeg: state.lookView.pitchDeg,
          eastDeg: state.lookView.yawDeg,
        }),
        satellite: frame.position,
        verticalFovRad: state.verticalFov,
        aspect: Number.isFinite(frustum?.aspectRatio) ? frustum.aspectRatio : 1,
        max: ORBITAL_REACH_LIST_MAX,
      })
    : { count: 0, entries: [] };
  const focusKey = state.focus?.key ?? null;
  this.publishOrbitalReach({
    count: reach.count,
    focusKey,
    entries: reach.entries.map(({ key, offNadirDeg, reachable }) => {
      const record = records.get(key);
      const source = String(record.source || '');
      return {
        key,
        label: String(record.label || record.layerName || key),
        layerName: String(record.layerName || ''),
        source,
        latitude: record.latitude,
        longitude: record.longitude,
        offNadirDeg,
        reachable,
        focused: key === focusKey,
        osm: /openstreetmap|\bosm\b/i.test(source),
        details: detailRows(record.properties),
      };
    }),
  });
}

/** Clear the reach list as the orbital session ends. */
export function endOrbitalFocus() {
  this.publishOrbitalReach(null);
}
