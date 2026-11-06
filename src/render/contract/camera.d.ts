/**
 * The camera. It belongs to the renderer: Core asks for poses, flights and
 * follows, and every renderer reproduces the behaviour below exactly.
 * A renderer whose engine has no such camera of its own builds this port
 * on the shared GEV camera controller (the stub's camera is its seed), so
 * flights, `lookAt` and follows are written once, not per engine.
 *
 * Behaviour every renderer keeps (Core depends on each one):
 * - Camera input is suspended during a flight, by a hold: a flight ending
 *   gives back only its own hold, never another owner's.
 * - `lookAt` orbits the target (the user can still rotate and zoom about it);
 *   `release` returns to the world frame.
 * - `changed` fires when the view has moved by more than the listener's own
 *   `threshold` (default 0.5) since it last fired, measured per listener:
 *   heading and roll each by their change over π since they last fired; the
 *   view by the larger of the direction's turn over half the vertical field
 *   of view and the eye's travel over its height, since the view last
 *   fired. A frame can fire it twice, once for each measure.
 * - `moveEnd` fires 500 ms after the last change, and never while following.
 * - A flight's `onCancel` and `onComplete` run synchronously, inside the call
 *   or frame that ends it.
 * - Axes follow the usual convention: heading clockwise from north, pitch
 *   negative looking down, roll about the view direction; local frames are
 *   east-north-up.
 */
import type {
  Ecef,
  GeoRect,
  HeadingPitchRange,
  HeadingPitchRoll,
  Off,
  Position,
  Release,
  Sphere,
  Vec3,
} from './common';

export interface CameraPose {
  lon: number;
  lat: number;
  /** Metres above the ellipsoid. */
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  position: Ecef;
  direction: Vec3;
  up: Vec3;
  right: Vec3;
  /** Vertical field of view, radians. */
  fovy: number;
  aspectRatio: number;
  near: number;
  far: number;
  /** False while `lookAt` has the camera in a target's frame. */
  frameIsIdentity: boolean;
}

export type Orientation =
  Partial<HeadingPitchRoll> | { direction: Vec3; up: Vec3 };

/**
 * A position, or a rectangle. For a rectangle the eye stands on the surface
 * normal at the geodesic midpoint of its central meridian (latitude 0 when it
 * spans nearly pole to pole), at the least distance that keeps on screen its
 * corners, its edge centres and, when it crosses the equator, its equator
 * points. The orientation is then resolved as for any position.
 */
export type Destination = Position | { rect: GeoRect };

/**
 * Omitted orientation angles are heading 0, pitch −π/2 (straight down) and
 * roll 0, not the current ones; an omitted destination keeps the position.
 */
export interface ViewSpec {
  destination?: Destination;
  orientation?: Orientation;
}

export type Easing =
  'linear' | 'quadraticInOut' | 'cubicInOut' | 'cubicOut' | 'quinticInOut';

/**
 * A flight's omitted orientation is the same as `setView`'s. Its omitted
 * duration is `min(3, ceil(distance / 1000 km) + 2)` seconds, the distance
 * measured from the eye's position in its current frame (the `lookAt` frame
 * when one is active). A flight with a duration of 0 or less, or one whose
 * eye (its position in its current frame, as above) already stands at the
 * destination with the destination's angles (to 1e-10, relative),
 * completes inside the call: it places the eye, runs `onComplete`, raises
 * `flightEnd` and resolves `done`, and no frame is needed. Starting a
 * flight cancels the one in progress.
 *
 * The path, at eased time `s` (0..1): longitude and latitude linear in `s`
 * the short way round; heading, pitch and roll linear in `s` the short way
 * round; height on an arc to `maxHeight` when both ends are below it,
 * otherwise linear. The reference traces (`conformance/goldens/camera.json`)
 * pin the arc and the omitted `maxHeight`.
 */
export interface FlightOptions {
  orientation?: Orientation;
  durationS?: number;
  /**
   * Omitted: `cubicOut` when descending from above 11.5 km, otherwise
   * `quinticInOut`.
   */
  easing?: Easing;
  /** Top of the height arc, metres. Omitted: a fifth of what fits both ends on screen. */
  maxHeight?: number;
  /** When the arc tops this height, pitch turns straight down mid-flight. */
  pitchAdjustHeight?: number;
  /** End in the world frame even when a target frame is active. */
  endFrame?: 'world';
  onComplete?: () => void;
  onCancel?: () => void;
}

export interface Flight {
  done: Promise<'complete' | 'cancelled'>;
  cancel(): void;
}

/** Something the camera follows; Core owns it and the renderer reads it each frame. */
export interface FollowTarget {
  /** Stable key, e.g. `'flights:a1b2c3'`. */
  key: string;
  /** Where the target is at scene time `t` (epoch ms), or null when unknown. */
  position(t: number): Ecef | null;
  /** Where it is drawn, when that differs from `position` (a lifted icon). */
  visualPosition?(t: number): Ecef | null;
  /**
   * The drawn item this target is, when it is one. A renderer that moves
   * items itself (`motionSegments`) follows where it draws the item, so the
   * eye and the icon never part; `position` stays the answer elsewhere.
   */
  item?: { set: string; id: string };
  /**
   * `enu`: offset in the target's east-north-up frame;
   * `autodetect`: an orbit frame from its motion, north-up when still
   * (`followAutodetect`).
   */
  frame: 'enu' | 'autodetect';
  /** Offset of the eye from the target, metres in `frame`. */
  viewFrom: Vec3 | ((t: number) => Vec3);
  minRange?: number;
  boundingRadius?: number;
}

/**
 * A camera command, as an ownership hook sees it before it runs. An owner
 * that issues commands itself (a ground guard) recognises its own by
 * issuing them inside its own call; any other command is someone else's.
 */
export interface CameraCommand {
  kind:
    | 'setView'
    | 'flyTo'
    | 'flyToBounds'
    | 'lookAt'
    | 'release'
    | 'follow'
    | 'cancelFlight';
}

export interface CameraControls {
  /** False while any hold is out. */
  readonly enabled: boolean;
  /** Suspend user camera input until released. Holds are counted. */
  suspend(reason: string): Release;
  enableTilt: boolean;
  enableRotate: boolean;
  enableZoom: boolean;
  minDistance: number;
  maxDistance: number;
  /**
   * How long a motion the user lets go of coasts: seconds for its speed to
   * fall to 1/e. `drag` is moving the globe under the pointer and tilting
   * (one motion in the default renderer), `zoom` is zooming; 0 stops at
   * once. Set the whole object to change it.
   */
  coast: { drag: number; zoom: number };
  /** What the eye cannot pass below. */
  collision: 'none' | 'terrain' | 'tiles' | 'both';
  zoomFactor: number;
  /** Pitch the user may tilt between, radians (−π/2 straight down). */
  pitchRange: [min: number, max: number];
  /** Input bindings that zoom. */
  zoomInputs: Array<'wheel' | 'pinch' | 'rightDrag' | 'ctrlWheel'>;
}

export type CameraEvent =
  'changed' | 'moveStart' | 'moveEnd' | 'followChanged' | 'flightEnd';

export interface CameraPort {
  pose(): CameraPose;
  setView(view: ViewSpec): void;
  setFov(fov: { vertical: number }): void;
  /**
   * The geodetic rectangle in view: the bounds of the canvas corners on the
   * ellipsoid, a corner that misses it taken where the horizon is, and the
   * full longitude span to the pole when the view goes over one. The whole
   * globe when fewer than two corners land; null only when the globe is
   * wholly outside the view.
   */
  viewRectangle(): GeoRect | null;
  flyTo(destination: Destination, options?: FlightOptions): Flight;
  /**
   * Fly to look at a sphere from `offset` in its east-north-up frame
   * (default heading 0, pitch −π/4; a range of 0 fits the sphere in view).
   */
  flyToBounds(
    sphere: Sphere,
    options?: { offset?: HeadingPitchRange } & Pick<
      FlightOptions,
      'durationS' | 'easing' | 'onComplete' | 'onCancel'
    >,
  ): Flight;
  cancelFlight(): void;
  readonly flying: boolean;
  /** Orbit `target` at `offset`; user input orbits it too. */
  lookAt(target: Ecef, offset: HeadingPitchRange): void;
  /** Leave `lookAt` for the world frame. */
  release(): void;
  move(
    direction: 'forward' | 'back' | 'left' | 'right' | 'up' | 'down',
    metres: number,
  ): void;
  look(direction: 'left' | 'right' | 'up' | 'down', radians: number): void;
  rotateAround(axis: Vec3, radians: number): void;
  zoom(metres: number): void;
  follow(target: FollowTarget | null): void;
  readonly followed: FollowTarget | null;
  /** Whether the follow has placed its first frame. */
  readonly followFramed: boolean;
  /** The eye's offset from the followed target, in its frame. */
  readonly followOffset: {
    get(): Vec3 | null;
    set(offset: Vec3): void;
  };
  readonly controls: CameraControls;
  on(event: CameraEvent, cb: () => void, options?: { threshold?: number }): Off;
  /** Runs before each camera command, so an owner can yield to another. */
  onCommand(cb: (command: CameraCommand) => void): Off;
  /**
   * Column-major, right-handed: `view` takes ECEF to eye space (absolute,
   * not eye-relative); `projection` takes eye space to clip space with depth
   * in [-1, 1]. A renderer with an infinite far plane returns the
   * infinite-far form, and `pose().far` is `Infinity`.
   */
  matrices(): { view: Float64Array; projection: Float64Array };
}
