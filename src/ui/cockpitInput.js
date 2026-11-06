/** Route Cockpit keys while preserving the active disclosure and form-control owner. */
import * as Cesium from 'cesium';
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

/** Where the track `kind` would ride is drawn now, as a world position. */
function subjectWorldPosition(kind) {
  if (kind !== 'aircraft') return null;
  return (
    this.viewer.trackedEntity?.position?.getValue?.(
      this.viewer.clock?.currentTime,
    ) ?? null
  );
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
 * Enter first person when the followed track itself is double-clicked: the
 * same entry, and the same gates, as C and the entry buttons. A
 * double-click anywhere else, or one a tool owns (drawing ends a shape with
 * one), is left alone.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @returns {boolean} True when it landed on the followed track, entered or
 *   refused by the gate: the caller does nothing else with it.
 */
export function onSceneDoubleClick(position) {
  if (this.active || this.destroyed || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  if (!doubleClickHitsSubject(position, subjectCanvasPosition.call(this)))
    return false;
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
 * The Cockpit's capture-phase keydown: Escape and C.
 * @param {KeyboardEvent} event
 */
export function onKeyDown(event) {
  if (this.destroyed) return false;
  if (event.repeat || event.isComposing) return;
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
  const key = event.key?.toLowerCase();
  if (key === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!this.active) {
      const cockpitAttempt = !!(
        this.readAircraftInfo() && this.viewer.trackedEntity?.position
      );
      if (!cockpitAttempt) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.active && !this.isEntryAllowed()) return;
    if (this.active) this.exit();
    else this.enter();
    return;
  }
}
