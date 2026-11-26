/**
 * @module app/globeInViewRecovery
 * @description Turns the camera back to the planet when a move ends looking
 * away from it, through the renderer's camera and frame ports.
 */
import { PI_OVER_TWO } from '../geo/vector.js';
import {
  FREE_LOOK_MAX_HEIGHT_METERS,
  globeOutOfFrame,
  isFreeGlobeCamera,
} from '../globeInView.js';
import { canvasOf, findCamera, findFrame } from '../render/rendererOf.js';
import {
  currentSelection,
  isCentredOnSelection,
  onSelectionChanged,
} from '../data/clickSelect.js';

/** Whether two vectors agree to `tolerance` in every component. */
const within = (a, b, tolerance) =>
  Math.abs(a.x - b.x) <= tolerance &&
  Math.abs(a.y - b.y) <= tolerance &&
  Math.abs(a.z - b.z) <= tolerance;

// How often a moving camera is sampled to see whether it has come to rest, how
// far a pose may drift between samples and still count as at rest, and how
// long after the camera last moved the check gives up if the camera never
// raises moveEnd.
const SETTLE_SAMPLE_MS = 250;
const SETTLE_POSITION_TOLERANCE_M = 1e-3;
const SETTLE_DIRECTION_TOLERANCE = 1e-9;
const SETTLE_GIVE_UP_MS = 5 * 60_000;

/**
 * Turn the camera back to the planet when a move ends above `minHeight` with
 * no surface on screen (`globeOutOfFrame`: limb glow and slivers up to about
 * one sample cell thick can count as none), and return the disposer. Views with
 * more surface, such as an oblique orbital shot, are left as they are. This
 * catches a saved or shared view that looked away, or any other move that ends
 * looking away from the planet.
 * Heading and position are kept. Following cameras, locked ones (a target's
 * frame), a view a click left centred on what is still selected (a
 * satellite far out in space, src/data/clickSelect.js), a camera flight in
 * progress, a pointer held down on the canvas
 * (a drag held still), and any time `paused`
 * returns true (an authored scene playing) are left alone; a check they defer
 * runs once they end, however long they last.
 * `keyholeRadius`
 * returns the radius of the visible circle when a scope mask hides the rest of
 * the frame (see `globeFrameShare`), or 0; it is read at every check.
 *
 * The camera's `moveEnd` alone is not enough: the default renderer compares
 * the camera with the last frame's to the last rounding error, and at some of
 * these poses the camera drifts by a rounding error every frame, so it never
 * sees it stop.
 * So each `moveStart` also starts a check of its own that samples the pose
 * every 250 ms, with a tolerance for that drift, and once the pose has held
 * for half a second after moving runs the same recovery. It keeps watching
 * until the camera raises `moveEnd`, since under that drift it raises no new
 * `moveStart` for a later move, and gives up five minutes after the camera
 * last moved.
 * `setTimeout` and `clearTimeout` can be injected for tests.
 */
export function installGlobeInViewRecovery(
  viewer,
  {
    minHeight = FREE_LOOK_MAX_HEIGHT_METERS,
    keyholeRadius = () => 0,
    paused = () => false,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = {},
) {
  const camera = findCamera(viewer);
  if (!camera) throw new TypeError('A viewer with a camera is required');

  // A pointer held on the globe is a gesture in progress, even when it holds
  // still for half a second: the check waits until every pointer pressed on
  // it (each finger of a pinch) is released. A release the page never sees,
  // outside the window, is taken as given when the window loses focus, the
  // page is hidden, the canvas loses the pointer's capture, or the pointer
  // moves with no button down.
  const canvas = canvasOf(viewer);
  const releaseTarget = canvas?.ownerDocument ?? canvas;
  const releaseWindow = canvas?.ownerDocument?.defaultView;
  const heldPointers = new Set();
  const onPointerDown = (event) => heldPointers.add(event?.pointerId);
  const onPointerUp = (event) => heldPointers.delete(event?.pointerId);
  const onPointerMove = (event) => {
    if (event?.buttons === 0) heldPointers.delete(event.pointerId);
  };
  const releaseAll = () => heldPointers.clear();
  const onVisibilityChange = () => {
    if (canvas.ownerDocument.visibilityState === 'hidden') releaseAll();
  };
  const listeners = [
    [canvas, 'pointerdown', onPointerDown],
    [canvas, 'lostpointercapture', onPointerUp],
    [releaseTarget, 'pointerup', onPointerUp],
    [releaseTarget, 'pointercancel', onPointerUp],
    [releaseTarget, 'pointermove', onPointerMove],
    [canvas?.ownerDocument, 'visibilitychange', onVisibilityChange],
    [releaseWindow, 'blur', releaseAll],
  ];
  for (const [target, type, listener] of listeners)
    target?.addEventListener?.(type, listener);

  // Returns false while a flight, a paused scene or a held pointer defers the
  // check, so the caller can try again once it ends.
  const recover = () => {
    if (!isFreeGlobeCamera(viewer)) return true;
    if (camera.flying || paused() || heldPointers.size > 0) return false;
    const pose = camera.pose();
    if (
      isCentredOnSelection(pose) ||
      !(pose.height > minHeight) ||
      !globeOutOfFrame(pose, { keyholeRadius: keyholeRadius() })
    )
      return true;
    camera.setView({
      orientation: { heading: pose.heading, pitch: -PI_OVER_TWO, roll: 0 },
    });
    findFrame(viewer)?.requestRender?.('globe-in-view');
    return true;
  };

  let lastPosition = null;
  let lastDirection = null;
  const remember = () => {
    ({ position: lastPosition, direction: lastDirection } = camera.pose());
  };
  let settleTimer = null;
  let settleElapsed = 0;
  let restingSamples = 0;
  let movedSinceCheck = false;
  const stopSettling = () => {
    if (settleTimer !== null) unschedule(settleTimer);
    settleTimer = null;
  };
  const sample = () => {
    settleTimer = null;
    settleElapsed += SETTLE_SAMPLE_MS;
    const now = camera.pose();
    const atRest =
      within(now.position, lastPosition, SETTLE_POSITION_TOLERANCE_M) &&
      within(now.direction, lastDirection, SETTLE_DIRECTION_TOLERANCE);
    restingSamples = atRest ? restingSamples + 1 : 0;
    if (!atRest) {
      movedSinceCheck = true;
      settleElapsed = 0;
    }
    // Two quiet samples in a row after a move: at rest for half a second, as
    // for moveEnd.
    if (restingSamples >= 2 && movedSinceCheck) {
      if (recover()) movedSinceCheck = false;
      // A flight or a playing scene bounds its own deferral.
      else settleElapsed = 0;
    }
    if (settleElapsed >= SETTLE_GIVE_UP_MS) return;
    remember();
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const startSettling = () => {
    stopSettling();
    settleElapsed = 0;
    restingSamples = 0;
    movedSinceCheck = true;
    remember();
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const removeMoveEnd = camera.on('moveEnd', () => {
    if (recover()) stopSettling();
    // Deferred: keep sampling so the check runs once the flight or scene ends.
    else if (settleTimer === null) startSettling();
  });
  const removeMoveStart = camera.on('moveStart', startSettling);
  // A view held for a selection is checked once it is let go: the camera
  // has no move to end then, and may be looking at nothing but space.
  // A switch lets go of one thing and selects the next in the same turn:
  // only a selection still empty once the turn is over is let go.
  let releaseQueued = false;
  const removeSelectionChanged = onSelectionChanged((selection) => {
    if (selection || releaseQueued) return;
    releaseQueued = true;
    queueMicrotask(() => {
      releaseQueued = false;
      if (!active || currentSelection()) return;
      if (!recover() && settleTimer === null) startSettling();
    });
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    stopSettling();
    removeMoveEnd();
    removeMoveStart();
    removeSelectionChanged();
    for (const [target, type, listener] of listeners)
      target?.removeEventListener?.(type, listener);
    heldPointers.clear();
  };
}
