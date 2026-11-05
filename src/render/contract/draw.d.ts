/**
 * Things to draw: batched sets of items keyed by string id.
 *
 * Core owns every record; a set is only what Core pushed. Each item may carry
 * an opaque `meta` that comes back on a pick (`Hit.meta`). There is no world
 * text here: every label goes through Core's screen-space label overlay,
 * which only needs `query.project`/`projectMany` and `query.isOccluded`.
 *
 * Moving icons follow a motion segment the renderer evaluates on its own
 * clock (`motionSegments`), so Core writes a row only when its motion or
 * style changes, not every frame.
 */
import type {
  Color,
  Ecef,
  GeoRect,
  Handle,
  Meta,
  NearFar,
  Off,
  Position,
  Quaternion,
  ScreenXY,
  Vec3,
} from './common';

/** How an item's height is read. */
export type HeightMode = 'absolute' | 'clampGround' | 'relativeGround';

/** What `clampGround` / `relativeGround` clamp to. */
export type ClampTarget = 'terrain' | 'tiles' | 'both';

export interface ClusterSpec {
  /** Screen distance under which icons merge. */
  pixelRange: number;
  /** Fewest icons that form a cluster. */
  minimumSize: number;
  /** Draws a cluster's icon from its member count. */
  icon?: (count: number) => ImageRef;
}

/** Options of a whole set; the mutable ones can change later through `setOptions`. */
export interface SetSpec {
  /**
   * Unique among the renderer's live sets (making a second set with a live
   * id throws; a disposed set's id can be used again); returned as `Hit.set`.
   */
  id: string;
  /** Hide items beyond the ellipsoid's horizon, for sets drawn without depth test. */
  horizonCull?: boolean;
  /** `cluster`: screen-space clustering (icons only). */
  cluster?: ClusterSpec | null;
  blend?: 'opaque' | 'translucent' | 'additive';
  /** Draw order between sets that do not depth-test against each other. */
  drawOrder?: number;
  /** `false`: the set never takes part in picks. */
  pickable?: boolean;
  /**
   * Height queries (`query.sampleHeight` and the rest) see this set as
   * ground. Off by default: queries answer from tiles and terrain alone.
   */
  includeInHeightQueries?: boolean;
  /** What clamped items clamp to. */
  clampTo?: ClampTarget;
  /**
   * `motionSegments` or `orbits`: the clock motion segments and orbits are
   * evaluated on.
   * `live` (the default) is wall time minus `delayMs`, as a live feed is
   * drawn a little behind real time; `scene` is the frame port's scene time.
   */
  motionClock?: { kind: 'live'; delayMs?: number } | { kind: 'scene' };
  show?: boolean;
}

/** Common to items placed at one position. */
export interface Placed {
  id: string;
  pos: Position;
  height?: HeightMode;
  meta?: Meta;
  show?: boolean;
  /** `false`: this item never takes part in picks. */
  pickable?: boolean;
  scaleByDistance?: NearFar;
  fadeByDistance?: NearFar;
  /** Shown only at eye distances in `[near, far)`, metres. */
  displayRange?: [near: number, far: number];
  /**
   * Items in different sets that share a `lodGroup` are one thing drawn at
   * different detail (a model near, an icon far), each shown over its own
   * `displayRange`. A renderer may draw the group as one entity; a pick on
   * it names the member shown at that distance (`Hit.set`, `Hit.id`) and
   * reports the group (`Hit.lodGroup`).
   */
  lodGroup?: string;
  /** Draw over depth within this many metres of the eye (`Infinity`: always). */
  disableDepthTest?: number;
}

/** An image an icon draws: a URL, a slot in a shared atlas, or generated. */
export type ImageRef =
  | string
  | { atlas: string; slot: string }
  | { svg: string }
  | { blob: Blob }
  | { canvas: HTMLCanvasElement | OffscreenCanvas; key: string };

/**
 * How an icon moves between updates, on its set's `motionClock`. Times are
 * epoch ms. Sending an item a new segment replaces its old one, whatever the
 * times (an earlier or equal `t0` included).
 * - hold: stays at `pos`.
 * - lerp: straight in space from `from` (at `t0`) to `to` (at `t1`), holding
 *   at both ends; the course runs from `course0Deg` by `courseSlopeDeg`
 *   across the segment.
 * - arc: a constant-rate turn in the plane tangent to the ellipsoid at `fix`
 *   (its east and north axes), from `fix` at `t0`, at `speedMps` along
 *   `trackDeg` turning at `turnRateDps` (under 1e-4 rad/s is straight), and
 *   climbing along the fix's up axis at `climbMps` (default 0). The elapsed
 *   time is clamped to `[minDtS, maxDtS]`; a negative `minDtS` runs the same
 *   path backward before `t0` (a warm-up), `maxDtS` is how long it coasts.
 * The drawn course eases onto a new one over the item's `courseBlendMs`; an
 * item that also has `courseGlide` eases at its rate instead, on a renderer
 * with the `courseGlide` capability.
 */
export type MotionSegment =
  | { kind: 'hold'; courseDeg?: number }
  | {
      kind: 'lerp';
      from: Ecef;
      to: Ecef;
      t0: number;
      t1: number;
      course0Deg?: number;
      courseSlopeDeg?: number;
    }
  | {
      kind: 'arc';
      fix: Ecef;
      t0: number;
      minDtS: number;
      maxDtS: number;
      speedMps: number;
      trackDeg: number;
      turnRateDps: number;
      /** Metres per second along the fix's up axis. */
      climbMps?: number;
    };

export interface CourseGlide {
  fromCourseDeg: number;
  t0: number;
  /** Degrees per second; 0 or less holds `fromCourseDeg`. */
  rateDps: number;
}

export interface IconItem extends Placed {
  image: ImageRef;
  /** Drawn size in CSS pixels. */
  size: [width: number, height: number];
  color?: Color;
  alpha?: number;
  scale?: number;
  /** `motionSegments`: motion on the renderer's clock. */
  motion?: MotionSegment;
  /** `courseGlide`: ease the drawn course at a rate, from `fromCourseDeg`. */
  courseGlide?: CourseGlide;
  /**
   * Ease the drawn course onto a new one over this long; 0 or omitted turns
   * at once. Every renderer has it; with the `courseGlide` capability an
   * item's `courseGlide`, when it has one, is used instead.
   */
  courseBlendMs?: number;
  /** Degrees clockwise from north. */
  course?: number;
  /**
   * `screen`: upright on screen, rotated by `rotation`;
   * `course`: rotated on screen along `course` (or the motion's course);
   * `axis`: rotated about `alignedAxis`.
   */
  rotationMode?: 'screen' | 'course' | 'axis';
  /** Radians counter-clockwise on screen, for `rotationMode: 'screen'`. */
  rotation?: number;
  /** ECEF axis for `rotationMode: 'axis'`. */
  alignedAxis?: Vec3;
  pixelOffset?: ScreenXY;
  /** Offset toward the eye, metres in eye space. */
  eyeOffset?: Vec3;
  anchor?: 'center' | 'bottom' | 'top';
  /** Swap to `near` when drawn larger than `switchPx`. */
  imageLod?: { near: ImageRef; switchPx: number };
  /** A larger invisible pick target, CSS pixels. */
  pickProxy?: { size: [width: number, height: number] };
  /** Fade and shrink toward the globe's limb. */
  recede?: boolean;
  /** Emphasis factor for a focused item, 1 = none. */
  focus?: number;
}

export interface PointItem extends Placed {
  pixelSize: number;
  color: Color;
  outlineColor?: Color;
  outlineWidth?: number;
}

export type LineStyle =
  | { kind: 'solid'; color: Color }
  | { kind: 'glow'; color: Color; power: number; taper?: number }
  | {
      kind: 'dash';
      color: Color;
      gapColor?: Color;
      length: number;
      pattern16?: number;
    }
  | { kind: 'arrow'; color: Color }
  | { kind: 'pattern'; image: ImageRef; repeat: number }
  | { kind: 'flow'; color: Color; repeat: number; duty: number; speed: number };

export interface LineItem {
  id: string;
  /** ECEF positions, or packed `x, y, z` triples. */
  positions: Ecef[] | Float64Array;
  widthPx: number;
  /** `3d`: straight in space; `geodesic`: along the ellipsoid; `draped`: on the surface. */
  mode: '3d' | 'geodesic' | 'draped';
  clampTo?: ClampTarget;
  style: LineStyle;
  /** Colour where the line is behind the surface; `null` hides those parts. */
  depthFailColor?: Color | null;
  /** Per-segment colours; changing them does not rebuild the line. */
  segmentColors?: Color[];
  segmentShow?: boolean[];
  /** Draw only the first fraction of the line, 0..1. */
  revealFraction?: number;
  /** Positions are in a frame rotating with the sky (orbits). */
  frame?: 'fixed' | 'inertial';
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

/** A shape's fill. */
export type Fill =
  | Color
  | { image: ImageRef; repeat?: [number, number] }
  | { preset: 'radialRim'; color: Color; rimColor: Color; rimWidth: number };

/** Declarative animation the renderer runs (no per-frame callbacks). */
export interface Pulse {
  property: 'radius' | 'alpha';
  from: number;
  to: number;
  periodMs: number;
  /** Repeat count; omitted repeats forever. */
  repeat?: number;
}

/** A radius that follows the camera's height above the ground. */
export interface RadiusByCameraHeight {
  byCameraHeight: { factor: number; min: number; max: number };
}

export type ShapeGeometry =
  | { kind: 'polygon'; rings: Position[][]; perPositionHeight?: boolean }
  | {
      kind: 'ellipse';
      center: Position;
      semiMajor: number | RadiusByCameraHeight;
      semiMinor: number | RadiusByCameraHeight;
      /** Radians counter-clockwise from north to the semi-major axis. */
      rotation?: number;
      /** Only part of the ellipse, radians from north. */
      arc?: { start: number; end: number };
    }
  /** `height`: metres above the ellipsoid, for a rectangle not clamped. */
  | { kind: 'rectangle'; rect: GeoRect; height?: number }
  | {
      kind: 'box';
      center: Position;
      dimensions: Vec3;
      orientation?: Quaternion;
    }
  | {
      kind: 'wall';
      positions: Position[];
      minimumHeights?: number[];
      maximumHeights?: number[];
    };

export interface ShapeItem {
  id: string;
  geometry: ShapeGeometry;
  fill?: Fill | null;
  outline?: Color | null;
  outlineWidth?: number;
  /** Draw the outline only. Clamped outlines are drawn as draped lines. */
  outlineOnly?: boolean;
  /** Height of the extruded face, metres above the ellipsoid (not above the shape). */
  extrudeHeight?: number;
  height?: 'absolute' | 'clampGround';
  clampTo?: ClampTarget;
  /** Classify what is inside the volume (tint the tiles it covers). */
  classifyVolume?: boolean;
  /** Pull toward the eye, metres, to win depth against coplanar surfaces. */
  depthBias?: number;
  animate?: Pulse;
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

/**
 * A glTF model. Every renderer draws one the same way: glTF is Y-up and is
 * turned to Z-up before `orientation` applies; `minPixelSize` is measured at
 * the model's bounding-sphere distance from the eye; `colorBlend` mixes the
 * tint into the shaded colour and never changes the model's alpha.
 */
export interface ModelItem extends Placed {
  url: string;
  orientation: { heading: number; pitch: number; roll: number };
  scale?: number;
  minPixelSize?: number;
  maxPixelSize?: number;
  maxScale?: number;
  /** Can change live. */
  shading?: 'pbr' | 'unlit' | 'thermal';
  tint?: Color;
  colorBlend?: { mode: 'highlight' | 'replace' | 'mix'; amount?: number };
  environmentMap?: boolean;
}

/** A plane showing an image, a video or a canvas. */
export interface QuadItem {
  id: string;
  center: Position;
  orientation: Quaternion;
  /** Metres. */
  size: [width: number, height: number];
  source:
    | { image: ImageRef }
    | { video: HTMLVideoElement }
    | { canvas: HTMLCanvasElement | OffscreenCanvas };
  alpha?: number;
  outline?: { color: Color; widthPx: number } | null;
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

/** Custom geometry in a local east-north-up frame at `origin`. */
export interface MeshItem {
  id: string;
  origin: Ecef;
  /** Packed `east, north, up` metres. */
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  color: Color;
  /** Unlit, with back faces drawn. */
  flat?: boolean;
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

export type FieldSpec =
  | {
      kind: 'windStreamlines';
      id: string;
      /** Row-major `u` and `v` in m/s on a `width × height` grid over `rectangle`. */
      u: Float32Array;
      v: Float32Array;
      width: number;
      height: number;
      rectangle: GeoRect;
      pathBudget: number;
      steps: number;
      style: { color: Color; widthPx: number; speedFactor?: number };
      /** Draw height, metres; omitted drapes on the surface. */
      heightM?: number;
    }
  | {
      kind: 'scalarRaster';
      id: string;
      values: Float32Array;
      width: number;
      height: number;
      rectangle: GeoRect;
      /** Colour ramp: value stops in ascending order. */
      ramp: Array<{ value: number; color: Color }>;
      alpha?: number;
    }
  | {
      kind: 'rasterShell';
      id: string;
      /** A raster on a sphere raised above the ground. */
      image: ImageRef;
      rectangle: GeoRect;
      heightM: number;
      liftM?: number;
      /** Full detail inside this rectangle only. */
      detailWindow?: GeoRect;
      alpha?: number;
    };

export interface FieldHandle extends Handle {
  update(patch: Partial<FieldSpec>): void;
}

export type CelestialSpec =
  | {
      kind: 'stars';
      id: string;
      /**
       * Packed stars; omitted draws the renderer's own catalogue (one it
       * streams, say), down to `magnitudeLimit`, or no stars when it has
       * none.
       */
      catalogue?: Float32Array;
      magnitudeLimit?: number;
    }
  | {
      kind: 'orbitRings';
      id: string;
      /** Each ring: packed `x, y, z` in the inertial frame, metres. */
      rings: Float64Array[];
      color: Color;
      widthPx: number;
    };

/**
 * `orbits`: a satellite from its elements. The renderer propagates it with
 * SGP4 on its set's `motionClock` and draws the marker and, optionally, its
 * ring. Without the capability Core propagates and draws the positions
 * itself as icons and lines.
 */
export interface OrbitItem {
  id: string;
  /** A two-line element set. */
  tle: [line1: string, line2: string];
  marker:
    | { image: ImageRef; size: [width: number, height: number] }
    | { pixelSize: number; color: Color };
  /** The orbit's ring over `periods` orbits (default 1), in the inertial frame. */
  ring?: { color: Color; widthPx: number; periods?: number } | null;
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
  /** As on `Placed`. */
  displayRange?: [near: number, far: number];
  lodGroup?: string;
}

/** `agents`: dots moving along polylines (traffic flow). */
export interface AgentPathItem {
  id: string;
  positions: Ecef[] | Float64Array;
  /** Agents on this path. */
  count: number;
  speedMps: number;
  /** 0 flows freely; 1 stopped; between creeps. */
  congestion?: number;
  color: Color;
  pixelSize: number;
  fadeByDistance?: NearFar;
  meta?: Meta;
}

/**
 * Columnar update for large sets (`columns`). Column `i` of each array is
 * row `ids[i]`. `dirty` limits the upload to these index runs.
 */
export interface Columns {
  ids: readonly string[];
  /** Packed ECEF `x, y, z`. */
  positions?: Float64Array;
  /** Degrees clockwise from north. */
  courses?: Float32Array;
  /**
   * 0 hides a row. A hidden row keeps its motion state (where it is on its
   * segment, its eased course), so showing it again resumes, not restarts.
   */
  shown?: Uint8Array;
  scales?: Float32Array;
  alphas?: Float32Array;
  /** Packed `r, g, b, a`, 0..255. */
  colors?: Uint8Array;
  meta?: readonly Meta[];
  dirty?: ReadonlyArray<{ start: number; end: number }>;
}

export interface DrawSet<T> {
  readonly id: string;
  /** Replace every item. */
  set(items: T[]): void;
  /** Add or replace items by id. */
  upsert(items: T[]): void;
  remove(ids: string[]): void;
  clear(): void;
  /** `columns`. */
  setColumns?(columns: Columns): void;
  /** Change the mutable set options. */
  setOptions(options: Partial<Omit<SetSpec, 'id'>>): void;
  /** Items in the set. */
  size(): number;
  show: boolean;
  /** `models`: a model has loaded and is posed. */
  on(event: 'ready', cb: (id: string) => void): Off;
  dispose(): void;
}

export interface DrawPort {
  icons(spec: SetSpec): DrawSet<IconItem>;
  points(spec: SetSpec): DrawSet<PointItem>;
  lines(spec: SetSpec): DrawSet<LineItem>;
  shapes(spec: SetSpec): DrawSet<ShapeItem>;
  /** `models`. */
  models?(spec: SetSpec): DrawSet<ModelItem>;
  /** `quads`. */
  quads?(spec: SetSpec): DrawSet<QuadItem>;
  /** `meshes`. */
  meshes?(spec: SetSpec): DrawSet<MeshItem>;
  /** `fields`. */
  field?(spec: FieldSpec): FieldHandle;
  /** `celestial`: drawn in an inertial frame rotated by sidereal time. */
  celestial?(spec: CelestialSpec): Handle;
  /** `agents`. */
  agents?(spec: SetSpec): DrawSet<AgentPathItem>;
  /** `orbits`. */
  orbits?(spec: SetSpec): DrawSet<OrbitItem>;
  /**
   * Whether clamped items (`clampTo: 'tiles' | 'both'`, draped lines and
   * shapes) are draped onto the 3D tiles now (`draped`), or drawn over them
   * and hidden past the ellipsoid's horizon (`overlay`), the fallback a
   * renderer uses where it cannot drape. Without tiles in the base it is
   * `draped`: clamping to terrain or the ellipsoid always drapes.
   */
  clampState(): 'draped' | 'overlay';
  /** Fires when `clampState()` changes (not on subscribing). */
  on(event: 'clampState', cb: (state: 'draped' | 'overlay') => void): Off;
  /** Register an atlas of images icons refer to by slot. */
  atlas(id: string, images: Record<string, ImageRef>): void;
}
