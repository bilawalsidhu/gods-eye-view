/**
 * Follow mode: the camera locked onto one moving entity, and let go the instant the user
 * touches the camera themselves.
 *
 * Two decisions carry this file.
 *
 * **It reads the store, not a primitive.** A layer mutates its point primitives in place
 * and pools them on removal, so a held reference can end up pointing at the primitive some
 * other aircraft is now using. What follow mode holds instead is the last reported fix off
 * the selection, and it extrapolates from it with the same `advanceGreatCircle` the layers
 * use, so the camera and the point it is centred on are computed from the same numbers and
 * cannot drift apart.
 *
 * **Manual camera input disengages it, immediately.** A camera that fights the user is
 * worse than no follow mode. What counts as manual input here is a pointer drag past
 * {@link DRAG_THRESHOLD_PX} and any wheel or pinch zoom, both read off the canvas. A click
 * that does not move is not manual input: clicking an aircraft is how you select it, and a
 * one-pixel jitter on the way to a click must not throw the mode away. Keyboard is not on
 * the list because Cesium binds no keys to the camera, so there is no keyboard camera input
 * to break out of; the follow key itself is the explicit way off.
 */

import { Cartesian3, HeadingPitchRange, Matrix4 } from 'cesium';
import type { Viewer } from 'cesium';

import { advanceGreatCircle } from './project';
import type { Selection } from '../state/store';
// The same guard the search box's own `/` shortcut uses. Two copies of "is the user typing"
// is two places to fix when it learns about a new element, and one of the two bare-key
// shortcuts then keeps the old rule.
import { isEditableTarget } from '../ui/search';

/**
 * How far a pointer has to travel with a button down before it counts as a drag.
 *
 * Four CSS pixels, measured as the sum of the two axes. Under this it is a click, and a
 * click selects rather than moves the camera.
 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * How close the camera is ever placed to what it follows, in metres.
 *
 * Follow mode keeps the distance the user was already at, which is what stops it yanking
 * the view. Zoomed right in on the ground and then following an airliner, that distance can
 * be a few metres and the camera would end up inside the thing it is watching.
 */
export const MINIMUM_RANGE_M = 300;

/** The key that engages and disengages follow mode on the current selection. */
export const FOLLOW_KEY = 'f';

/**
 * What the cards tell the user about follow mode.
 *
 * Built from {@link FOLLOW_KEY} rather than typed out, because a hint naming the wrong key is
 * worse than no hint. Nothing on screen used to say this mode existed, so nobody found it,
 * and it is on the cards rather than in permanent chrome because a selection is the only time
 * there is anything to follow.
 */
export const FOLLOW_HINT = `Press ${FOLLOW_KEY.toUpperCase()} to follow. Drag the globe to let go.`;

/**
 * One reported fix, flattened out of whichever kind of entity is selected.
 *
 * Aircraft and ships name their bearing and speed differently and only one of them has an
 * altitude, so the difference is resolved once, here, rather than in the camera maths.
 */
export interface FollowFix {
  lon: number;
  lat: number;
  altitudeM: number;
  /** Degrees clockwise from true north, or null when the feed reported none. */
  bearingDeg: number | null;
  speedMps: number | null;
  /**
   * Local clock reading when the fix reached the browser, which is what extrapolation runs
   * from. The server's own timestamp would add the clock skew between the two machines.
   */
  anchorMs: number;
}

/** The current fix for whatever is selected. */
export function followFix(selection: Selection): FollowFix {
  if (selection.kind === 'aircraft') {
    const { aircraft, receivedAtMs } = selection.aircraft;
    return {
      lon: aircraft.point.lon,
      lat: aircraft.point.lat,
      altitudeM: aircraft.point.altitude_m ?? 0,
      bearingDeg: aircraft.track_deg ?? null,
      // On the ground is stationary whatever speed the feed reports, matching the aircraft
      // layer: a taxiing groundspeed extrapolated along a track drives the camera off the
      // airfield.
      speedMps: aircraft.on_ground ? 0 : (aircraft.ground_speed_mps ?? null),
      anchorMs: receivedAtMs,
    };
  }
  const { vessel, receivedAtMs } = selection.vessel;
  return {
    lon: vessel.point.lon,
    lat: vessel.point.lat,
    // AIS carries no altitude and the contract guarantees the field is null on a vessel.
    altitudeM: 0,
    // Course over ground, not heading: heading is where the bow points and a ship crabs.
    bearingDeg: vessel.course_over_ground_deg ?? null,
    speedMps: vessel.speed_over_ground_mps ?? null,
    anchorMs: receivedAtMs,
  };
}

/** Whether this fix is going anywhere, and so whether the camera needs a frame. */
function isMoving(fix: FollowFix): boolean {
  return fix.bearingDeg !== null && fix.speedMps !== null && fix.speedMps > 0;
}

interface PointerOrigin {
  x: number;
  y: number;
}

export class FollowMode {
  private readonly viewer: Viewer;
  private readonly canvas: HTMLCanvasElement;
  private followedId: string | null = null;
  private fix: FollowFix | null = null;
  /** Heading, pitch and range captured when the mode engaged, then held. */
  private offset = new HeadingPitchRange(0, 0, MINIMUM_RANGE_M);
  /** Where a pointer went down, so a drag can be told from a click. */
  private origin: PointerOrigin | null = null;

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.origin = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const origin = this.origin;
    // `buttons` is a mask of what is held down, so this is nothing at all on a bare hover
    // and is a drag for a mouse button, a touch and a pen alike.
    if (origin === null || event.buttons === 0) {
      return;
    }
    const travelled = Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
    if (travelled >= DRAG_THRESHOLD_PX) {
      this.stop();
    }
  };

  private readonly onPointerUp = (): void => {
    this.origin = null;
  };

  private readonly onWheel = (): void => {
    this.stop();
  };

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.canvas = viewer.scene.canvas;
    // Listeners for the life of the object rather than per engagement: they cost nothing
    // while nothing is followed, and attaching them on engage would miss a drag that began
    // in the same gesture.
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel);
  }

  /** What is being followed, or null. */
  get following(): string | null {
    return this.followedId;
  }

  /**
   * Engage on a selection, or disengage when it is null.
   *
   * The camera keeps the heading and pitch it already had and stays the distance away it
   * already was: engaging is meant to lock onto what you are looking at, not to fly you
   * somewhere new.
   */
  start(selection: Selection | null, nowMs: number = Date.now()): void {
    // Released first even when already following: heading and pitch are read relative to
    // whatever reference frame the camera is in, and the frame set by the last engagement
    // is centred on the entity we are about to stop following.
    this.stop();
    if (selection === null) {
      return;
    }
    const fix = followFix(selection);
    const camera = this.viewer.camera;
    const target = Cartesian3.fromDegrees(fix.lon, fix.lat, fix.altitudeM);
    const range = Math.max(Cartesian3.distance(camera.positionWC, target), MINIMUM_RANGE_M);
    this.offset = new HeadingPitchRange(camera.heading, camera.pitch, range);
    this.followedId = selection.id;
    this.fix = fix;
    this.aim(fix, nowMs);
  }

  /** Engage on this selection, or disengage if it is already the one being followed. */
  toggle(selection: Selection | null, nowMs: number = Date.now()): void {
    if (selection !== null && selection.id === this.followedId) {
      this.stop();
      return;
    }
    this.start(selection, nowMs);
  }

  /**
   * A new selection state: a fresh fix for the followed entity, something else selected, or
   * nothing.
   *
   * Anything other than a new fix for the same entity disengages. A selection that has
   * dropped off its feed arrives here as null, and leaving the camera locked to the last
   * place we saw it would be exactly the frozen-but-looks-live view this app exists to
   * avoid.
   */
  refresh(selection: Selection | null, nowMs: number = Date.now()): void {
    if (this.followedId === null) {
      return;
    }
    if (selection?.id !== this.followedId) {
      this.stop();
      return;
    }
    const fix = followFix(selection);
    this.fix = fix;
    this.aim(fix, nowMs);
  }

  /**
   * Move the camera on to where the followed entity is now. Returns whether it moved, which
   * is what tells the motion loop whether to ask for a frame.
   *
   * A parked ship or an aircraft with no track reported returns false: it is already
   * centred, and re-aiming at the same point every animation frame would render the globe
   * continuously for nothing.
   */
  tick(nowMs: number = Date.now()): boolean {
    const fix = this.fix;
    if (fix === null || !isMoving(fix)) {
      return false;
    }
    this.aim(fix, nowMs);
    return true;
  }

  /**
   * Disengage, and hand the camera back to the world.
   *
   * Releasing the reference frame is the half that is easy to forget. Cesium leaves the
   * camera locked to the frame `lookAt` set, so without this the user's next drag orbits a
   * point the entity left minutes ago and the globe appears stuck.
   */
  stop(): void {
    if (this.followedId === null) {
      return;
    }
    this.followedId = null;
    this.fix = null;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  /** Takes the fix as an argument because every caller already has one in hand. */
  private aim(fix: FollowFix, nowMs: number): void {
    const moved = advanceGreatCircle(
      fix.lon,
      fix.lat,
      fix.bearingDeg,
      fix.speedMps,
      (nowMs - fix.anchorMs) / 1000,
    );
    this.viewer.camera.lookAt(
      Cartesian3.fromDegrees(moved.lon, moved.lat, fix.altitudeM),
      this.offset,
    );
  }
}

/**
 * Bind the follow key to the current selection.
 *
 * Nothing modified: `Ctrl+F` is the browser's find and `Cmd+F` on a Mac likewise, and
 * taking either would be a worse trade than the shortcut is worth. Nothing while the user
 * is typing either, or the search box would engage follow mode on every "f" in "Frankfurt".
 *
 * Returns a function that unbinds it.
 */
export function installFollowKey(
  follow: FollowMode,
  selected: () => Selection | null,
  target: Document = document,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) {
      return;
    }
    if (event.key.toLowerCase() === FOLLOW_KEY) {
      follow.toggle(selected());
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}
