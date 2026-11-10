/** Route Cockpit keys while preserving the active disclosure and form-control owner. */
import { followedOf } from '../data/followed.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { inputFor } from '../input/dispatcher.js';
import { findInput, findQuery } from '../render/rendererOf.js';
import { trackedPositionNow } from './cockpitCamera.js';

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
  return trackedPositionNow(this.viewer, followedOf(this.viewer));
}

/** The followed track's canvas position now, or null off screen. */
function subjectCanvasPosition() {
  const kind = this.resolveEntryKind();
  const world = kind ? subjectWorldPosition.call(this, kind) : null;
  if (!world) return null;
  return findQuery(this.viewer)?.project(world) ?? null;
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

/** Hold the renderer's own double-click follow off; returns the release. */
const holdStockFollow = (viewer) =>
  findInput(viewer)?.behaviours?.dblclickFollow?.suppress?.() ?? null;

/** How long a press on the followed track keeps the stock follow off. */
const SUBJECT_PRESS_HOLD_MS = 700;

/**
 * Take the scene's double-click on the followed track for the Cockpit. The
 * renderer's own double-click follow lets go of whatever is followed when
 * the double-click does not land on something it can follow itself: on a
 * followed aircraft's model it would drop the very track the double-click
 * means to ride. It runs before any subscriber and cannot be refused from
 * one, so a press on the followed track holds it off for that press
 * (`behaviours.dblclickFollow`, a hold a `down` subscriber takes covers its
 * press), and the double-click it ends in enters. A double-click anywhere
 * else is the renderer's, as before. `this.holdStockFollow`, when set, takes
 * the hold in place of the renderer's input port (tests).
 * @returns {() => void} Stops listening and lets any hold go.
 */
export function routeSceneDoubleClick() {
  let input;
  try {
    input = inputFor(this.viewer);
  } catch {
    // A viewer with no input to take (headless tools, partial stubs) has no
    // double-click to route.
    return () => {};
  }
  let release = null;
  let timer = null;
  const drop = () => {
    globalThis.clearTimeout(timer);
    timer = null;
    release?.();
    release = null;
  };
  const offDown = input.onPointer('down', ({ position }) => {
    drop();
    if (this.active || this.destroyed || !isPointerFree()) return;
    if (!doubleClickHitsSubject(position, subjectCanvasPosition.call(this)))
      return;
    release = this.holdStockFollow
      ? this.holdStockFollow()
      : holdStockFollow(this.viewer);
    // A press that ends in no double-click gives the follow back by itself.
    timer = globalThis.setTimeout(drop, SUBJECT_PRESS_HOLD_MS);
  });
  const offDouble = input.onPointer('dblclick', ({ position }) => {
    this.onSceneDoubleClick(position);
    drop();
  });
  return () => {
    offDown();
    offDouble();
    drop();
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
        this.readAircraftInfo() && followedOf(this.viewer)?.entity?.position
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
