/**
 * Shared value types of the renderer contract.
 *
 * Only plain numbers, strings and typed arrays cross the contract: no engine
 * object ever does. Positions are f64 Earth-centred, Earth-fixed metres
 * (`Ecef`) or geodetic degrees and metres (`LonLatH`). Angles are radians
 * unless a name says degrees. Times are epoch milliseconds. Screen positions
 * are CSS pixels from the top left of the renderer's canvas.
 */

/** Earth-centred, Earth-fixed position in metres (WGS84). */
export interface Ecef {
  x: number;
  y: number;
  z: number;
}

/** A direction or offset in metres; the frame is stated where it is used. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Geodetic position: degrees, and metres above the WGS84 ellipsoid. */
export interface LonLatH {
  lon: number;
  lat: number;
  height?: number;
}

/** Geodetic position without a height. */
export interface LonLat {
  lon: number;
  lat: number;
}

/** Either position form. A value with `lon` and `lat` is geodetic. */
export type Position = Ecef | LonLatH;

/** CSS pixels from the canvas's top left. */
export interface ScreenXY {
  x: number;
  y: number;
}

/** A screen rectangle in CSS pixels. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A geodetic rectangle in degrees. */
export interface GeoRect {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A ray in ECEF metres; `direction` is a unit vector. */
export interface Ray {
  origin: Ecef;
  direction: Vec3;
}

/** A bounding sphere. */
export interface Sphere {
  center: Ecef;
  radius: number;
}

export interface HeadingPitchRoll {
  heading: number;
  pitch: number;
  roll: number;
}

export interface HeadingPitchRange {
  heading: number;
  pitch: number;
  range: number;
}

/** A quaternion `(x, y, z, w)`, unit length. */
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A CSS colour string, or linear `[r, g, b, a]` in 0..1 (`a` defaults to 1). */
export type Color = string | readonly [number, number, number, number?];

/**
 * A distance curve: `nearValue` at `near` metres from the eye, `farValue`
 * at `far`, linear in between and clamped outside.
 */
export interface NearFar {
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
}

/**
 * Unsubscribes. Calling it twice is harmless.
 *
 * Every `on(...)` in the contract keeps these rules: listeners run in the
 * order they subscribed; one removed while an event is being delivered does
 * not run for it if it has not yet; one added during delivery first runs for
 * the next event; a listener that throws is reported (`Renderer` `error`,
 * or the platform's `reportError` when nothing listens for errors) and the
 * others, and the frame, still run.
 */
export type Off = () => void;

/** Gives back a hold. Calling it twice is harmless. */
export type Release = () => void;

/** A handle on something the renderer draws. */
export interface Handle {
  show: boolean;
  dispose(): void;
}

/** Opaque data Core attaches to a drawn item and gets back on a pick. */
export type Meta = unknown;

/**
 * Optional features. A renderer lists the ones it has in
 * `Renderer.capabilities`. A member's documentation names the capability
 * it depends on, in backticks, first:
 * - on an optional member (`?`), the member exists only with the capability;
 * - on a required member, the member always exists, and without the
 *   capability it answers null, an empty list or a status saying so (a
 *   query asked for depth on a renderer without `pickPosition` returns null).
 * Options guarded by a capability are ignored without it. Quality settings
 * are not capabilities: `QualityPort.knobs()` lists the ones a renderer has.
 */
export type Capability =
  /** Google photorealistic 3D tiles as the base. */
  | 'photoreal'
  /** A vector basemap (`BaseSpec.vector`), with its own labels. */
  | 'vectorBase'
  /** Heights from the finest data available, not only what is drawn. */
  | 'finestHeights'
  /** Height terrain under the globe. */
  | 'terrain'
  /** Atmosphere scattering applied to drawn models. */
  | 'modelAtmosphere'
  /** Imagery draped onto 3D tiles as well as the globe. */
  | 'imageryOnTiles'
  /** A screen-split comparison between imagery layers. */
  | 'splitSwipe'
  /** Timed imagery frames with hidden prefetch. */
  | 'imageryFrames'
  /** Wind-relief and similar shading of the globe surface. */
  | 'surfaceShading'
  /** A screen-space sector modulation pass (a sweeping sonar band). */
  | 'screenModulation'
  /** GPU frame timing through timer queries. */
  | 'gpuTiming'
  /** Depth picks against tiles and terrain. */
  | 'pickPosition'
  /** Height sampling against tiles and terrain. */
  | 'sampleHeight'
  /** Ray casts against tiles and terrain. */
  | 'rayCast'
  /** Columnar draw-set updates with dirty ranges. */
  | 'columns'
  /** Icon motion segments evaluated on the renderer's clock. */
  | 'motionSegments'
  /** glTF models. */
  | 'models'
  /** Image, video and canvas planes. */
  | 'quads'
  /** Custom meshes in a local east-north-up frame. */
  | 'meshes'
  /** Wind streamlines, scalar rasters and raised raster shells. */
  | 'fields'
  /** Stars and orbit rings in an inertial frame. */
  | 'celestial'
  /** Agents moving along polylines (traffic flow). */
  | 'agents'
  /** Screen-space clustering of icons. */
  | 'cluster'
  /** Post-processing styles. */
  | 'styles'
  /** A bloom pass. */
  | 'bloom'
  /** A sharpen pass. */
  | 'sharpen'
  /** Following with an automatically chosen frame (orbit or north-up). */
  | 'followAutodetect'
  /** A built-in quality benchmark. */
  | 'benchmark';
