/**
 * Things to draw: batched sets of items keyed by string id.
 *
 * The application owns every record; a set is only what it pushed. Each item may carry
 * an opaque `meta` that comes back on a pick (`Hit.meta`). There is no world
 * text here: every label goes through the application's screen-space label overlay,
 * which only needs `query.project`/`projectMany` and `query.isOccluded`.
 *
 * Moving icons follow a motion segment the renderer evaluates on its own
 * clock (`motionSegments`), so the application writes a row only when its motion or
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

/**
 * What `clampGround` / `relativeGround` clamp to. `overlay`: clamped
 * shapes' flat fills and outlines, and draped lines, are drawn on the
 * ellipsoid (height 0) over everything else, 3D tiles and terrain included,
 * which never hide them: neither draped onto the tiles nor hidden under
 * them. Only the ellipsoid hides them: what lies past its horizon from the
 * eye is not drawn (the far side of the globe never shows through it).
 * Their edges follow the surface's curve between their positions, as a
 * draped item's do. Icons, points and models clamp to an `overlay` as to
 * `both`; extruded shapes and walls stand on the surface as with `both`.
 */
export type ClampTarget = 'terrain' | 'tiles' | 'both' | 'overlay';

/**
 * `cluster`: screen-space clustering of a set's icons. Which icons cluster
 * is `clusterScreenPoints` (`src/geo/screenCluster.js`) over the set's shown
 * icons in front of the eye and above the horizon, in the set's order, each
 * boxed at its drawn size (its larger side, times its `scale`), with
 * `pixelRange` and `minimumSize`, and the last pass's clusters kept as it
 * keeps them: so the renderer forms exactly these clusters. A cluster draws one
 * icon at the cluster's position (the mean of its members') in place of its
 * members, which are not drawn: its image is `icon(count)` when given, else
 * a default badge showing the count, drawn at its seed's size. A pick on a
 * cluster answers one `Hit` per member, in the cluster's order (seed
 * first), each with that member's own `set`, `id` and `meta` and the
 * cluster's `position`: so `pick` gives the seed and `drillPick` every
 * member. Clusters are recomputed in the frames drawn after the camera
 * moves or the set changes, never on a timer.
 */
export interface ClusterSpec {
  /** Screen distance under which icons merge, CSS pixels. */
  pixelRange: number;
  /** Fewest icons that form a cluster. */
  minimumSize: number;
  /** Draws a cluster's icon from its member count. */
  icon?: (count: number) => ImageRef;
}

/**
 * `recede`: a set's items shrink and fade toward the globe's limb, as
 * `src/render/recession.js` (exported as `render/recession`) works it out,
 * so the renderer draws exactly those factors. Nearer than `startLimbRatio` of
 * the eye's distance to the limb an item is drawn as it is; from there it
 * eases (smoothstep) to `scaleFloor` times its scale and `alphaFloor` haze
 * at the limb and beyond. All of it eases back to nothing as the eye climbs
 * from `globeViewBlendStartM` to `globeViewBlendEndM` above the ellipsoid.
 * An item draws at its alpha times `max(combinedAlphaFloor, focus × haze)`,
 * that floor holding even while nothing recedes. Icons shrink and fade;
 * models only fade. Every parameter is optional, the defaults in brackets.
 */
export interface RecedeSpec {
  /** Where receding starts, as a share of the limb's distance [0.5]. */
  startLimbRatio?: number;
  /** The scale an item reaches at the limb [0.45]; icons only. */
  scaleFloor?: number;
  /** The haze an item reaches at the limb [0.35]. */
  alphaFloor?: number;
  /** The least `focus × haze` draws with [0.2]. */
  combinedAlphaFloor?: number;
  /** Eye height above the ellipsoid where receding starts to ease off, metres [3,500,000]. */
  globeViewBlendStartM?: number;
  /** Eye height from which nothing recedes, metres [4,500,000]. */
  globeViewBlendEndM?: number;
  /** The radius of the sphere the limb is measured on, metres [6,378,137]. */
  earthRadiusM?: number;
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
  /** `cluster`: screen-space clustering (icons only; see `ClusterSpec`). */
  cluster?: ClusterSpec | null;
  /**
   * Icons and models: the items recede toward the limb (`RecedeSpec`; `{}`
   * for the defaults). Omitted or `null`: they do not. Changes live.
   */
  recede?: RecedeSpec | null;
  /**
   * How the set's items blend with what is drawn. Omitted: opaque parts
   * opaque with depth writes, items with alpha under 1 alpha-blended without
   * depth writes. `opaque`: every item opaque, its alpha ignored (taken as
   * 1), with depth writes (icons and points keep every part they draw,
   * unblended). `translucent`: every item alpha-blended without depth
   * writes, even at alpha 1. `additive`: each item's colour times its alpha
   * added to what is drawn, without depth writes and still depth-tested.
   * For every kind of set; `setOptions({blend})` takes effect from the next
   * frame, and models do not load again.
   */
  blend?: 'opaque' | 'translucent' | 'additive';
  /**
   * Among sets that do not depth-test against each other (items drawn with
   * `disableDepthTest`), a higher one draws over a lower one whatever order
   * they were made in; equal ones keep that order. `pick` and `drillPick`
   * name them topmost first. Default 0.
   */
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
   * `motionSegments`: the clock motion segments are evaluated on.
   * `live` (the default) is wall time minus `delayMs`, as a live feed is
   * drawn a little behind real time; `scene` is the frame port's scene time.
   */
  motionClock?:
    | {
        kind: 'live';
        delayMs?: number;
        /**
         * Who asks for the frames moving rows need: the set itself, one after
         * another while a row moves (the default), or its `owner`, at the
         * rate the rows move on screen. An owner's set may also draw a
         * change written in place on the owner's next frame without asking
         * for one (the owner writes as a frame begins).
         */
        frames?: 'set' | 'owner';
      }
    | { kind: 'scene' };
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
 * The drawn course turns onto a new one at once; an item with `courseGlide`
 * eases at its rate instead, on a renderer with the `courseGlide` capability.
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
  /** Degrees clockwise from north. */
  course?: number;
  /**
   * `screen`: upright on screen, rotated by `rotation`;
   * `course`: rotated on screen along `course` (or the motion's course);
   * `axis`: its up along `alignedAxis` as projected on screen, then
   * rotated by `rotation`.
   */
  rotationMode?: 'screen' | 'course' | 'axis';
  /**
   * Radians counter-clockwise on screen, for `rotationMode: 'screen'` and
   * `'axis'`.
   */
  rotation?: number;
  /** ECEF axis for `rotationMode: 'axis'`. */
  alignedAxis?: Vec3;
  /** CSS pixels, y down. */
  pixelOffset?: ScreenXY;
  /** `pixelOffset` grows and shrinks with `scaleByDistance`, as the icon does. */
  offsetScalesByDistance?: boolean;
  anchor?: 'center' | 'bottom' | 'top';
  /** Swap to `near` when drawn larger than `switchPx`. */
  imageLod?: { near: ImageRef; switchPx: number };
  /** A larger invisible pick target, CSS pixels. */
  pickProxy?: { size: [width: number, height: number] };
  /**
   * Emphasis for a focused item, 0..1, 1 = none: the alpha is multiplied by
   * it (in a set that recedes, as `RecedeSpec` says).
   */
  focus?: number;
}

export interface PointItem extends Placed {
  pixelSize: number;
  color: Color;
  outlineColor?: Color;
  outlineWidth?: number;
}

export type LineStyle =
  | {
      kind: 'solid';
      color: Color;
      /**
       * An edge `widthPx` wide in all, half of it on each side, inside the
       * line's width (a line 8 px wide with an outline of 4 has 2 px of
       * outline each side and 4 px of `color` between), drawn in the same
       * pass as the line: a translucent edge does not darken where it meets
       * the line. Its colour changes in place.
       */
      outline?: { color: Color; widthPx: number };
    }
  | { kind: 'glow'; color: Color; power: number; taper?: number }
  | { kind: 'dash'; color: Color; length: number; pattern16?: number }
  | { kind: 'arrow'; color: Color }
  | { kind: 'pattern'; image: ImageRef; repeat: number }
  | { kind: 'flow'; color: Color; repeat: number; duty: number; speed: number }
  | {
      /**
       * Draped lines only. `color` from fraction `at` of the line's length
       * to its end, `behind` from its start to `at` (the other way round
       * with `reverse`); `at` outside 0..1 draws it all in `color`. With a
       * `rim`, the outer `widthFraction` of the width in all (half each
       * side) draws each colour's red, green and blue times `shade`, its
       * alpha kept. `at`, `reverse` and the colours change in place.
       */
      kind: 'split';
      color: Color;
      behind: Color;
      at: number;
      reverse?: boolean;
      rim?: { shade: number; widthFraction: number };
    };

/**
 * `lineAgeFade`: a line that fades with the age of its points, drawn by the
 * renderer on the scene clock (`frame.setTime`), so a line whose points stay
 * where they are is not sent again as time passes. A point's recency is
 * `1 - clamp((now - time) / windowMs, 0, 1)`, its time running evenly
 * between neighbouring positions, so the fade is smooth along the line, not
 * stepped at its points. The line's colour (its style's, or a segment's from
 * `segmentColors`) draws at its alpha times
 * `mix(alphaFloor, 1, smoothstep(0, 1, recency))`, and with
 * `squaredAlphaFloor` times `mix(squaredAlphaFloor, 1, recency²)` as well;
 * with `widthFloor` it draws `widthPx` times `mix(widthFloor, 1, recency)`
 * wide, about its path. A point at or past the window draws at the floors, a
 * point at or after now at full strength. New `times` with new positions are
 * an ordinary update.
 *
 * `lineTimeWindow`: with `showMs`, only the part of the line within `showMs`
 * of now is drawn, cut along it where its interpolated time crosses: parts
 * whose time is after now, or before `now - showMs`, are not drawn (nor
 * picked). The cut follows the scene clock as the fade does, so a moving
 * object's trail can be its whole track, sent once: drawn from `showMs` ago
 * up to where the object is now. A renderer without the capability ignores
 * `showMs` and draws the whole line.
 */
export interface LineAgeFade {
  /** Each position's time, epoch ms on the scene clock: one per position. */
  times: number[] | Float64Array;
  /** The age a point fades over, ms; positive. */
  windowMs: number;
  /** A fully aged point's alpha multiplier, 0..1. */
  alphaFloor: number;
  /** A second alpha multiplier's floor, eased by recency squared, 0..1. */
  squaredAlphaFloor?: number;
  /** A fully aged point's width multiplier, 0..1 [1, no narrowing]. */
  widthFloor?: number;
  /**
   * `lineTimeWindow`: draw only the part of the line from `showMs` before
   * now up to now, ms; positive (`Infinity`: up to now, however old).
   * [absent: the whole line]
   */
  showMs?: number;
}

/**
 * `lineBreaks`: a line drawn as several runs, so many lines in one style can
 * be one item (thousands of moving objects' trails sent as one line, say),
 * and the renderer handles one item instead of thousands. Each break is the
 * index `i` of a position that starts a new run (`0 < i < positions.length`,
 * strictly increasing): the segment from position `i - 1` to `i` is not
 * drawn (nor picked), and the line does not join across it, each run having
 * two ends of its own, capped and joined as a line of its own would be.
 * `segmentColors` and `segmentShow` stay one a pair of neighbouring
 * positions (`j`: from position `j` to `j + 1`), so a pair across a break
 * has an entry that is ignored; `ageFade.times` stays one a position; and
 * `revealFraction` runs along the runs, in order, as one length (the gaps
 * between them have none). A renderer without the capability is never sent
 * `breaks`: its lines are sent one item a run instead.
 */
export type LineBreaks = number[] | Uint32Array;

export interface LineItem {
  id: string;
  /** ECEF positions, or packed `x, y, z` triples. */
  positions: Ecef[] | Float64Array;
  /**
   * `lineBreaks`: the positions that start a new run of the line
   * (`LineBreaks`). [absent or empty: one run]
   */
  breaks?: LineBreaks;
  widthPx: number;
  /**
   * `3d`: straight in space; `geodesic`: along the ellipsoid; `draped`: on
   * the surface. Where the renderer cannot drape at all, it draws `draped` lines
   * and clamped shapes as in `overlay`, and `clampState()` says `overlay`.
   */
  mode: '3d' | 'geodesic' | 'draped';
  clampTo?: ClampTarget;
  style: LineStyle;
  /**
   * How the parts behind the surface draw, solid or dashed; omitted or
   * `null` hides them. Ignored on draped lines, which are never behind it.
   */
  depthFail?:
    | { kind: 'solid'; color: Color }
    | Extract<LineStyle, { kind: 'dash' }>
    | null;
  /** Per-segment colours; changing them does not rebuild the line. */
  segmentColors?: Color[];
  segmentShow?: boolean[];
  /** Draw only the first fraction of the line, 0..1. */
  revealFraction?: number;
  /** `lineAgeFade`: fade the line with the age of its points (`LineAgeFade`). */
  ageFade?: LineAgeFade;
  /** Positions are in a frame rotating with the sky (orbits). */
  frame?: 'fixed' | 'inertial';
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

/**
 * A shape's fill: a colour, or an image stretched over the shape's extent
 * (`repeat` times across and up). A canvas image sent again with a new
 * `key` is new content.
 */
export type Fill = Color | { image: ImageRef; repeat?: [number, number] };

/**
 * Declarative animation the renderer runs (no per-frame callbacks): the
 * fill's and outline's alpha swings between `from` and `to` and back every
 * `periodMs`, forever.
 */
export interface Pulse {
  property: 'alpha';
  from: number;
  to: number;
  periodMs: number;
}

export type ShapeGeometry =
  | { kind: 'polygon'; rings: Position[][]; perPositionHeight?: boolean }
  | {
      kind: 'ellipse';
      center: Position;
      /** Metres. */
      semiMajor: number;
      semiMinor: number;
      /** Radians counter-clockwise from north to the semi-major axis. */
      rotation?: number;
    }
  /**
   * `height`: metres above the ellipsoid, for a rectangle not clamped.
   * `rotation`: radians counter-clockwise, turning the rectangle about its
   * centre in longitude and latitude (as a KML ground overlay turns); an
   * image fill turns with it.
   */
  | { kind: 'rectangle'; rect: GeoRect; height?: number; rotation?: number }
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
  /**
   * Shaded by the renderer's fixed light (true) or flat colour (false).
   * Omitted: lit for extruded shapes, flat otherwise. A renderer
   * may draw clamped shapes, which drape on the surface, flat whatever it
   * says.
   */
  lit?: boolean;
  animate?: Pulse;
  meta?: Meta;
  show?: boolean;
  pickable?: boolean;
}

/**
 * A glTF model. The renderer draws one this way: glTF is Y-up and is
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
  /**
   * The model's glTF (GLB) bytes, loaded already: the renderer draws it from
   * these and never fetches `url`, which stays its identity (an update that
   * keeps the `url` keeps the model, whatever bytes it carries), so models
   * loaded up front are never fetched mid-session. A renderer reads models
   * compressed with `EXT_meshopt_compression` and `KHR_mesh_quantization`.
   */
  gltf?: Uint8Array;
  /**
   * Per-axis multipliers on top of `scale`, along the model's own glTF axes
   * (`x`, `y`, `z` as authored, before the Y-up turn): a model stretched
   * wider or taller than its length scale. `minPixelSize` and
   * `maxPixelSize` measure `scale` alone. Can change live.
   */
  axisScale?: [x: number, y: number, z: number];
  /**
   * For a model whose meshes carry a `_TINT` vertex attribute (0..1): a
   * colour painted where it marks the model, drawn colour = colour ×
   * mix(1, maskColor, _TINT), `maskColor` read as sRGB (its alpha unused).
   * Applied under `pbr` and `unlit` shading, not under `thermal`. Never sent
   * for a model without the attribute. Can change live.
   */
  maskColor?: Color;
  /**
   * `belowOrigin`: only the part of the model above the horizontal plane
   * through `pos` is drawn (a hull above its waterline, where the globe
   * would not hide what lies below it). Can change live.
   */
  clip?: 'belowOrigin';
  /**
   * Transforms of the model's named glTF nodes (an articulated model's
   * joints): each a column-major 4×4 matrix in the node's parent frame that
   * replaces the node's own transform. A node whose name leaves the map goes
   * back to its authored pose; names the model lacks are ignored. Applied
   * once the model is ready, on a renderer with the `modelNodes`
   * capability; elsewhere the model draws as authored. Can change live.
   */
  nodes?: Readonly<Record<string, ArrayLike<number>>>;
  /**
   * Emphasis for a focused model, 0..1, 1 = none: the tint's alpha is
   * multiplied by it (in a set that recedes, as `RecedeSpec` says). Can
   * change live.
   */
  focus?: number;
  /**
   * `modelParts`: how the model's moving parts are posed. Applies to a
   * model whose mesh carries a `_PART` vertex attribute (each vertex's part
   * index) and whose root node's glTF `extras.parts` is its part table;
   * ignored for any other. Omitted, or without the capability, the model is
   * drawn whole, at rest, as its file draws it. Can change live, without
   * loading the model again.
   */
  parts?: ModelPartState;
}

/**
 * A model's part state (`ModelItem.parts`), each member by part name; a
 * part not named is at rest, and a name the model's part table lacks is
 * ignored. The maths is `render/modelParts`'s `partMatrices`: about each
 * part's pivot, its deploy fraction first, then its spin, then its pose,
 * then its parent part's whole motion.
 */
export interface ModelPartState {
  /**
   * Degrees a second about the part's axis, which the renderer advances
   * itself on its own clock each frame: a turning rotor costs the
   * application no write per frame. A change of rate goes on from the angle
   * reached, without a jump; a part that stops spinning stays where it is.
   */
  spin?: Record<string, number>;
  /**
   * 0 (stowed, the table's first limit) to 1 (deployed, its second): a
   * hinge or deploy part turned, a slide or separable part moved along its
   * axis, that far between its limits. Clamped to 0..1.
   */
  deploy?: Record<string, number>;
  /** Each part's pose, on top of its spin and deploy fraction. */
  poses?: Record<string, PartPose>;
}

/**
 * One part's pose about its pivot, in the model's own frame (in its glTF:
 * forward −X, up +Y, right −Z). A hinge or deploy part's turn about its
 * axis stays within its limits, as does a slide part's travel; the rest of
 * every part's motion is free. A number that is not finite counts as 0.
 */
export interface PartPose {
  /** Metres along the model's right, forward and up. */
  offsetM?: [right: number, forward: number, up: number];
  /** Degrees clockwise seen from above, as a heading. Applied first. */
  yawDeg?: number;
  /** Degrees nose up. Applied after the yaw. */
  pitchDeg?: number;
  /** Degrees clockwise looking forward. Applied last. */
  rollDeg?: number;
  /** Not drawn, nor any part riding it. */
  hidden?: boolean;
  /**
   * Drawn in a highlight colour: `true` for the renderer's own, or a
   * colour. Anything else, or a colour the renderer cannot read, draws no
   * highlight. Not inherited by the parts riding it.
   */
  highlight?: boolean | Color;
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
      /** 0..1, changeable without a rebuild (fade by height). */
      alpha?: number;
      /** Draw the paths still, dimmed. */
      paused?: boolean;
    }
  | {
      /**
       * A raster on a sphere raised above the ground. Shells draw in
       * ascending `heightM`, alpha-blended and unlit; they are never picked
       * and never in height queries. Changing `liftM` or `alpha` never
       * rebuilds. An `update` that changes `image`, `rectangle` or `detail`
       * keeps drawing what it drew until the new content can be drawn whole.
       */
      kind: 'rasterShell';
      id: string;
      image: ImageRef;
      rectangle: GeoRect;
      heightM: number;
      liftM?: number;
      /**
       * A sharper image drawn in place of `image` inside its own
       * `rectangle`, never blended with it; null or omitted: none.
       */
      detail?: { image: ImageRef; rectangle: GeoRect } | null;
      alpha?: number;
      /** What the raster shows, as imagery's `shows`. */
      shows?: string;
    };

export interface FieldHandle extends Handle {
  update(patch: Partial<FieldSpec>): void;
  /**
   * `fields`: what the spec or the last `update` asked for is drawn now.
   * Once per such change; never while hidden. Changes made before one is
   * drawn (the spec and updates, or updates while hidden) are told once,
   * when the latest is drawn.
   */
  on(event: 'drawn', cb: () => void): Off;
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
  /**
   * `models`: a model's url failed to load (`message` says why), once per
   * failed load. The item stays in the set, drawing what it drew before (a
   * new item draws nothing); a renderer may try the url again when the item
   * is next updated. Removing the item and adding it again tries at once.
   * Optional: where the renderer cannot tell a failure it may never fire it, so
   * a fallback must not wait on it.
   */
  on(event: 'loadFailed', cb: (id: string, message: string) => void): Off;
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
  /**
   * Whether clamped items (`clampTo: 'tiles' | 'both'`, draped lines and
   * shapes; never `overlay` ones, always drawn over the tiles) are draped
   * onto the 3D tiles now (`draped`), or drawn over them
   * and hidden past the ellipsoid's horizon (`overlay`), the fallback a
   * renderer uses where it cannot drape. Without tiles in the base it is
   * `draped`: clamping to terrain or the ellipsoid always drapes, on a
   * renderer that can drape at all (one that cannot is always `overlay`).
   */
  clampState(): 'draped' | 'overlay';
  /** Fires when `clampState()` changes (not on subscribing). */
  on(event: 'clampState', cb: (state: 'draped' | 'overlay') => void): Off;
  /** Register an atlas of images icons refer to by slot. */
  atlas(id: string, images: Record<string, ImageRef>): void;
}
