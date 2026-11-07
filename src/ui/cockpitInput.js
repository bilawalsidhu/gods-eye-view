/** Route Cockpit keys while preserving the active disclosure and form-control owner. */
import * as Cesium from 'cesium';
import { lookKeyStep } from '../cockpitLook.js';
import { isPointerFree } from '../data/inputOwnership.js';

/** How far from the followed track a double-click may land, CSS pixels. */
export const SUBJECT_DOUBLE_CLICK_RADIUS_PX = 32;

/**
 * Whether a double-click landed on the followed track's mark.
 * @param {{x: number, y: number}|null} click Canvas position of the click.
 * @param {{x: number, y: number}|null|undefined} subject Canvas position of
 *   the track, or nothing when it is off screen.
 * @param {number} [radiusPx]
 */
export function doubleClickHitsSubject(
  click,
  subject,
  radiusPx = SUBJECT_DOUBLE_CLICK_RADIUS_PX,
) {
  if (!click || !subject) return false;
  const distance = Math.hypot(click.x - subject.x, click.y - subject.y);
  return Number.isFinite(distance) && distance <= radiusPx;
}

/**
 * How long the first press of a double-click keeps its picture of the track,
 * ms: a click on a selected ship re-centres the camera, so the ship can move
 * on screen before the second click lands.
 */
export const DOUBLE_CLICK_MEMORY_MS = 700;

/** Where the track `kind` would ride is drawn now, as a world position. */
function subjectWorldPosition(kind) {
  if (kind === 'aircraft') {
    return (
      this.viewer.trackedEntity?.position?.getValue?.(
        this.viewer.clock?.currentTime,
      ) ?? null
    );
  }
  const info = this.readVesselInfo();
  if (!Number.isFinite(info?.latitude) || !Number.isFinite(info?.longitude))
    return null;
  // The sprite floats on the geoid, not on the ellipsoid (tens of metres
  // apart): project the height it is drawn at.
  const heightM = Number.isFinite(info.markHeightM)
    ? info.markHeightM
    : Number.isFinite(info.seaSurfaceHeightM)
      ? info.seaSurfaceHeightM
      : 0;
  return Cesium.Cartesian3.fromDegrees(info.longitude, info.latitude, heightM);
}

/** The followed track's canvas position now, or null off screen. */
function subjectCanvasPosition() {
  const kind = this.resolveEntryKind();
  const world = kind ? subjectWorldPosition.call(this, kind) : null;
  const scene = this.viewer.scene;
  if (!world || typeof scene?.cartesianToCanvasCoordinates !== 'function')
    return null;
  return (
    scene.cartesianToCanvasCoordinates(world, new Cesium.Cartesian2()) ?? null
  );
}

/**
 * Note where the followed track is drawn as a press begins, for a
 * double-click whose first click moves it. The second press of the gesture
 * keeps the first one's picture: by then the first click may have moved it.
 * @param {number} [nowMs]
 */
export function onScenePointerDown(nowMs = performance.now()) {
  if (this.active || this.destroyed) return;
  const start = this.doubleClickStart;
  if (start && nowMs - start.atMs <= DOUBLE_CLICK_MEMORY_MS) return;
  const at = subjectCanvasPosition.call(this);
  this.doubleClickStart = at ? { x: at.x, y: at.y, atMs: nowMs } : null;
}

/**
 * Enter first person when the followed track itself is double-clicked: the
 * same entry, and the same gates, as C and the entry buttons. The click may
 * land where the track is drawn now or where it was as the gesture began. A
 * double-click anywhere else, or one a tool owns (drawing ends a shape with
 * one), is left alone.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @param {number} [nowMs]
 * @returns {boolean} True when it landed on the followed track, entered or
 *   refused by the gate: the caller does nothing else with it.
 */
export function onSceneDoubleClick(position, nowMs = performance.now()) {
  const start = this.doubleClickStart;
  this.doubleClickStart = null;
  if (this.active || this.destroyed || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  const hit =
    doubleClickHitsSubject(position, subjectCanvasPosition.call(this)) ||
    (Boolean(start) &&
      nowMs - start.atMs <= DOUBLE_CLICK_MEMORY_MS &&
      doubleClickHitsSubject(position, start));
  if (!hit) return false;
  this.enter();
  return true;
}

/**
 * Take the scene's double-click through the Cockpit first. Cesium's Viewer
 * installs its own (pickAndTrackObject), which untracks whenever the pick is
 * not an Entity: on a followed aircraft's model, a primitive, it would drop
 * the very track the double-click means to ride. A double-click on the
 * followed track is the Cockpit's; any other goes on to Cesium's.
 * @returns {() => void} Puts Cesium's handler back, unless another owner
 *   (the draw tool borrows it) has replaced ours since.
 */
export function routeSceneDoubleClick() {
  const handler = this.viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    if (this.onSceneDoubleClick(event?.position)) return;
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
 * Focus inside one of these keeps its arrows (and Home): text entry, sliders,
 * tabs, radio groups, lists and menus all move with them.
 */
const LOOK_KEY_OWNERS = [
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role=slider]',
  '[role=tab]',
  '[role=tablist]',
  '[role=radio]',
  '[role=radiogroup]',
  '[role=listbox]',
  '[role=menu]',
  '[role=menuitem]',
  '[role=option]',
].join(', ');

/**
 * Turn the bridge view with the arrow keys (Shift for 45° steps) and bring
 * it back over the bow with Home or 0. Only a bridge looks around, and only
 * while focus is on the scene or a plain HUD button.
 * @returns {boolean} True when the key was taken.
 */
function handleLookKey(event) {
  if (!this.active || this.subjectKind !== 'vessel') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const step = lookKeyStep(event.key, event.shiftKey);
  const reset = !event.repeat && (event.key === 'Home' || event.key === '0');
  if (!step && !reset) return false;
  if (event.target?.closest?.(LOOK_KEY_OWNERS)) return false;
  if (this.isUtilityDisclosureOpen?.()) return false;
  event.preventDefault();
  if (step) this.turnLook(step);
  else this.lookAhead();
  return true;
}

/**
 * The Cockpit's capture-phase keydown: Escape and C, and on a bridge the
 * look-around keys.
 * @param {KeyboardEvent} event
 */
export function onKeyDown(event) {
  if (this.destroyed) return false;
  if (event.isComposing) return;
  // Held arrows turn a bridge view smoothly; every other key acts once.
  if (event.repeat && !lookKeyStep(event.key)) return;
  if (event.key === 'Escape' && this.active) {
    // The credit lightbox owns Escape while its Close control or links hold
    // focus. Its target handler closes the overlay and restores attribution
    // focus; Cockpit must stay active behind it.
    if (event.target?.closest?.('.cesium-credit-lightbox')) return;
    // An open Display or Radio popover takes Escape itself.
    if (this.isUtilityDisclosureOpen?.()) return;
    if (this.context?.contains(event.target) && !this.contextCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setContextCollapsed(true);
      if (
        event.target === this.contextToggle ||
        this.contextToggle?.contains?.(event.target)
      ) {
        this.contextToggle?.blur?.();
      } else {
        this.contextToggle?.focus({ preventScroll: true });
      }
      return;
    }
    if (this.signalStream?.contains(event.target) && !this.signalCollapsed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setSignalCollapsed(true, { user: true });
      if (
        event.target === this.signalToggle ||
        this.signalToggle?.contains?.(event.target)
      ) {
        this.signalToggle?.blur?.();
      } else {
        this.signalToggle?.focus({ preventScroll: true });
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.exit();
    return;
  }
  if (event.target?.closest?.('input, textarea, select, [contenteditable]'))
    return;
  if (handleLookKey.call(this, event)) return;
  const key = event.key?.toLowerCase();
  if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!this.active) {
      const cockpitAttempt = !!(
        this.readAircraftInfo() && this.viewer.trackedEntity?.position
      );
      // With no tracked aircraft, C takes the selected vessel's bridge.
      const bridgeAttempt = !cockpitAttempt && !!this.readVesselInfo();
      if (!cockpitAttempt && !bridgeAttempt) return;
      if (bridgeAttempt) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.isBridgeEntryAllowed()) this.enter({ kind: 'vessel' });
        return;
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.active && !this.isEntryAllowed()) return;
    if (this.active) this.exit();
    else this.enter({ kind: 'aircraft' });
    return;
  }
}
