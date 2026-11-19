/**
 * The camera. It belongs to the renderer: the application asks for poses,
 * flights and follows, and the renderer reproduces the behaviour below
 * exactly.
 *
 * Behaviour the renderer keeps (the application depends on each one):
 * - Camera input is suspended during a flight, by a hold: a flight ending
 *   gives back only its own hold, never another owner's.
 * - `lookAt` orbits the target (the user can still rotate and zoom about it);
 *   `release` returns to the world frame.
 * - `changed` fires when the view has moved by more than the listener's own
 *   `threshold` (`cameraChangeThreshold`; default 0.5, and 0.5 for every
 *   listener without the capability) since it last fired, measured per
 *   listener, without changing what any other listener is measured by:
 *   heading and roll each by their change over π since they last fired; the
 *   view by the larger of the direction's turn over half the vertical field
 *   of view and the eye's travel over its height, since the view last
 *   fired. A frame can fire it twice, once for each measure.
 * - `moveEnd` fires 500 ms after the last change of the eye, following or
 *   not: a followed target that moves keeps the eye moving, and one that
 *   stands still lets the move end.
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
  LonLat,
  Off,
  Position,
  Release,
  Sphere,
  Vec3,
} from './common';
import type { PointerEv, PointerEventType } from './input';
import type { HeightOptions } from './query';

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
  /**
   * Vertical field of view, radians. `fovy` and `aspectRatio` describe a
   * centred perspective frustum. Where the renderer's frustum is off-centre or
   * orthographic, it reports the nearest centred one here and its exact
   * projection only in `matrices()`; code that culls or projects exactly
   * reads `matrices()`.
   */
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
  | 'linear'
  | 'quadraticInOut'
  | 'cubicInOut'
  | 'cubicOut'
  | 'quadraticOut'
  | 'quinticInOut'
  | 'sineInOut';

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

/** Something the camera follows; the application owns it and the renderer reads it each frame. */
export interface FollowTarget {
  /** Stable key, e.g. `'flights:a1b2c3'`. */
  key: string;
  /** Where the target is at scene time `t` (epoch ms), or null when unknown. */
  position(t: number): Ecef | null;
  /** Where it is drawn, when that differs from `position` (a lifted icon). */
  visualPosition?(t: number): Ecef | null;
  /**
   * The drawn item this target is, when it is one. Where the renderer moves
   * items itself (`motionSegments`), it follows where it draws the item, so the
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
  /**
   * Seconds of wall time the first framing takes; without it the eye is
   * placed at `viewFrom` on the first frame. With it the eye stays in the
   * target's frame from the first frame (riding along with the target) and
   * moves from where it stood to the framing, both its offset and its view
   * turning, eased (`render/camera/followTransition.js`, the one rule every
   * renderer follows); `followFramed` turns true on arrival. A `viewFrom`
   * along the eye's own view at its own range keeps the view and the range
   * throughout, so the target slides to the centre.
   */
  transitionS?: number;
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
  /**
   * Input bindings that zoom. `ctrlWheel`: Ctrl+wheel, and a trackpad
   * pinch (which browsers send as Ctrl+wheel), zoom the globe rather than
   * the page.
   */
  zoomInputs: Array<'wheel' | 'pinch' | 'rightDrag' | 'ctrlWheel'>;
  /**
   * `keepEarthFramed`: keep the whole Earth in reach and in frame as the
   * user zooms out. An outward user zoom goes no farther than about
   * 40,000 km, or than the height a camera command left the eye at when
   * that is higher (the user then zooms in from there), and from high up
   * it turns the view down toward the globe so the whole Earth stays in
   * frame. A camera command, a follow and a flight are not held to it, and
   * a camera command ends any turn under way. Off by default.
   */
  keepEarthFramed?: boolean;
}

export type CameraEvent =
  'changed' | 'moveStart' | 'moveEnd' | 'followChanged' | 'flightEnd';

export interface CameraPort {
  /**
   * Whether any of the ECEF points may be on screen: false only when their
   * bounding sphere is outside the view or all of them are below the horizon
   * of WGS84 shrunk by `horizonMarginM` metres; null when it cannot tell
   * (not a 3D scene, an empty point set, or a non-finite point or camera
   * vector), which callers treat as visible. Supply a finite, nonnegative
   * margin smaller than the shortest WGS84 radius.
   */
  visiblePoints?(points: Ecef[], horizonMarginM: number): boolean | null;
  pose(): CameraPose;
  /**
   * Place the eye. A position with a `{direction, up}` orientation is placed
   * exactly as given (`up` made square to `direction`), never rounded
   * through heading, pitch and roll: the application's step moves (pans, turns, the
   * globe turned under the eye, zooms; `geo/eyeMoves`) are such views,
   * sent many times over.
   */
  setView(view: ViewSpec): void;
  /**
   * Hold the vertical field of view, across resizes, until `null` gives the
   * field of view back to the renderer: it is then as it was before the
   * first hold, and follows the view's shape as the renderer's own does.
   */
  setFov(fov: { vertical: number } | null): void;
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
  /**
   * Follow `target`, or stop following with null; `followChanged` fires
   * whenever `followed` changes, and only then.
   */
  follow(target: FollowTarget | null): void;
  readonly followed: FollowTarget | null;
  /** Whether the follow has placed its first frame. */
  readonly followFramed: boolean;
  /** The eye's offset from the followed target, in its frame. */
  readonly followOffset: {
    get(): Vec3 | null;
    set(offset: Vec3): void;
  };
  /**
   * `followFrame`: the frame the eye is placed in now, as a column-major
   * 4×4 matrix from that frame to ECEF (a rigid frame: unit axes, then the
   * origin). Once a follow has framed the camera (`followFramed`) it is the
   * follow's frame, whose origin is the target and in which `followOffset`
   * is the eye: east-north-up for an `enu` follow, the renderer's own orbit
   * frame for `autodetect`; until then it is whatever frame the eye was in
   * before. Under `lookAt` it is the target's east-north-up frame; in the
   * world frame, the identity. A follow's frame moves with its target, so a
   * reading is valid only for the tick it is read in. `setView` places a
   * world pose and keeps this frame, so code can re-express an offset in
   * the follow's own frame, whichever frame that is, and place the eye there.
   * Read-only, handed again while it holds, as `matrices()` are.
   */
  followFrame?(): Float64Array;
  readonly controls: CameraControls;
  /**
   * `threshold` (`cameraChangeThreshold`): the fraction of change, as the
   * header measures it, that fires this `changed` listener; ignored for the
   * other events, and without the capability (every listener then fires at
   * 0.5).
   */
  on(event: CameraEvent, cb: () => void, options?: { threshold?: number }): Off;
  /** Runs before each camera command, so an owner can yield to another. */
  onCommand(cb: (command: CameraCommand) => void): Off;
  /**
   * Column-major, right-handed: `view` takes ECEF to eye space (absolute,
   * not eye-relative); `projection` takes eye space to clip space with depth
   * in [-1, 1]. A renderer with an infinite far plane returns the
   * infinite-far form, and `pose().far` is `Infinity`. Read-only: a
   * renderer may hand the same arrays again while they hold, and hands new
   * ones once they change (one kept from an earlier frame stays as it was).
   */
  matrices(): {
    readonly view: Float64Array;
    readonly projection: Float64Array;
  };
}

/** A camera controller's frame tick: the loop's clock and the scene time. */
export interface CameraTick {
  /** The loop's clock, ms, on the `performance.now()` timeline. */
  now: number;
  /** Scene time, epoch ms. */
  time: number;
}

/** The eye a camera controller writes, in ECEF; `fovy` vertical, radians. */
export interface ControllerEye {
  position: Ecef;
  direction: Ecef;
  up: Ecef;
  right: Ecef;
  fovy: number;
}

/**
 * The camera a renderer hands a camera controller: it reads and writes the
 * eye exactly, says the canvas's CSS size, and lends the query, draw and
 * frame ports' members the controller needs.
 */
export interface NativeCamera {
  pose(): {
    position: Ecef;
    direction: Ecef;
    up: Ecef;
    near: number;
    far: number;
  };
  setPose(eye: ControllerEye): void;
  viewport(): { width: number; height: number };
  sampleHeightNow?(point: LonLat, options?: HeightOptions): number | null;
  pickPosition?(x: number, y: number): Ecef | null;
  /** Where the draw port draws an item it moves itself. */
  itemPosition?(
    item: { set: string; id: string | number },
    aheadMs?: number,
  ): Ecef | null;
  requestRender?(reason: string): void;
}

/**
 * A camera controller, handed to a renderer in place of its own camera:
 * given the native camera, the
 * input port's pointer events and the page's keys, it makes the camera port.
 * The renderer runs `frame.beforeUpdate` before its `preUpdate` listeners
 * and `frame.afterUpdate` after them, each tick, drawn or not.
 */
export type CameraControllerFactory = (options: {
  native: NativeCamera;
  input?: {
    on(type: PointerEventType, cb: (event: PointerEv) => void): Off;
  };
  report?: (error: unknown) => void;
  keyTarget?: EventTarget;
  thresholds?: boolean;
}) => {
  port: CameraPort;
  frame: {
    beforeUpdate(tick: CameraTick): void;
    afterUpdate(tick: CameraTick): void;
  };
  destroy(): void;
};
