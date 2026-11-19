/**
 * The base world: photorealistic tiles or a globe with terrain and imagery,
 * the sky, and what drapes onto them.
 */
import type { Credit } from './credits';
import type { GeoRect, Off } from './common';

export interface PhotorealSpec {
  provider: 'google';
  key?: string;
  /** Renews a session token; called again when the token expires. */
  token?: () => Promise<string>;
  /**
   * Fall back to the renderer's copy of the same tiles when Google refuses
   * (for the default renderer, one served from Cesium ion).
   */
  fallback?: boolean;
}

export interface PhotorealStatus {
  /** Which route is drawing, or `'none'` when photoreal is off or failed. */
  route: 'google' | 'fallback' | 'none';
  error?: { code: string; message: string };
}

/**
 * Heights everywhere in the contract are physical (metres above the
 * ellipsoid, unexaggerated): absolute positions, `HeightSample.height`,
 * `clampToSurface`. Only drawing follows the exaggerated surface:
 * `clampGround` and `relativeGround` items sit on the ground as drawn.
 */
export type TerrainSpec = (
  | { kind: 'ellipsoid' }
  /**
   * The renderer's global terrain, through `CreateOptions.worldDataToken`
   * (for the default renderer, Cesium World Terrain).
   */
  | { kind: 'world'; requestVertexNormals?: boolean }
  /**
   * Quantized-mesh terrain (Cesium's tile format) in the folder `url`,
   * holding `layer.json` and its tiles; heights above the ellipsoid.
   */
  | { kind: 'quantizedMesh'; url: string; requestVertexNormals?: boolean }
) & {
  /** Vertical exaggeration of the drawn terrain; default 1. */
  exaggeration?: number;
};

export type TilingScheme = 'webMercator' | 'geographic';

/** One tile request, as an admission hook sees it. */
export interface TileRequest {
  x: number;
  y: number;
  level: number;
}

/**
 * What a tile fetch answered: the bytes to decode, `missing` (no tile
 * there; draw the parent's), or `defer` (ask again on a later frame).
 */
export type TileFetch =
  | { bytes: ArrayBuffer; contentType?: string }
  | { missing: true }
  | { defer: true };

export interface ImagerySpec {
  /**
   * `world`: the renderer's global imagery through
   * `CreateOptions.worldDataToken` (for the default renderer, Cesium ion's
   * world imagery), in `worldStyle`. `canvas`: `imageHooks`.
   */
  kind: 'xyz' | 'world' | 'single-image' | 'canvas';
  /** `world`: aerial (the default), or aerial with labels. */
  worldStyle?: 'aerial' | 'aerialLabels';
  /** URL or URL template (`{x}`, `{y}`, `{z}`, `{s}`, `{time}`). */
  url?: string;
  /** `'canvas'` (`imageHooks`): draws one tile. */
  drawTile?: (tile: TileRequest, canvas: HTMLCanvasElement) => void;
  subdomains?: string[];
  tiling?: TilingScheme;
  rectangle?: GeoRect;
  minLevel?: number;
  maxLevel?: number;
  /**
   * Drawn nowhere the surface is coarser than `minLevel`, rather than made
   * from `minLevel` tiles there: for a layer whose `minLevel` tiles are too
   * many to fetch far out.
   */
  hiddenBelowMinLevel?: boolean;
  tileSize?: number;
  credit?: Credit;
  /** Requests in flight at once for this layer. */
  maxConcurrentRequests?: number;
  /** HTTP statuses retried rather than treated as missing. */
  retryStatuses?: number[];
  /**
   * Fetches a tile in place of the renderer, with the URL it would fetch.
   * The renderer calls it, before its own decoding (in a worker, say).
   */
  fetchTile?: (request: {
    tile: TileRequest;
    url: string;
    signal: AbortSignal;
  }) => Promise<TileFetch>;
  /** `imageHooks`: changes a tile's decoded image before it is drawn. */
  tileTransform?: (
    tile: TileRequest,
    image: ImageBitmap,
  ) => ImageBitmap | Promise<ImageBitmap>;
  /**
   * `imageHooks`: decides each tile request on the main thread: call
   * `issue()` to fetch it, or return `undefined` to defer it and be asked
   * again on a later frame. Layers given the same function share its waits:
   * while one of their tiles is in flight, its settling is that frame. `fetchTile`'s `defer` does the same anywhere.
   * With both, `admit` decides first and an issued request goes through
   * `fetchTile`; each defers on its own.
   */
  admit?: (
    tile: TileRequest,
    issue: () => Promise<unknown> | undefined,
  ) => Promise<unknown> | undefined;
  /** Draw order among imagery layers; higher draws on top. */
  zOrder?: number;
}

export interface TimedUrl {
  /** Epoch ms the frame shows. */
  time: number;
  url: string;
}

/**
 * A tile of a `decoded` source at one slot: its finished image, `missing`
 * (no tile there; draw the parent's), or `defer` (ask again on a later
 * frame). The renderer owns the image once answered: it draws it as it is
 * (its alpha too) and may close it once drawn.
 */
export type DecodedTile =
  { image: ImageBitmap } | { missing: true } | { defer: true };

/** What a `decoded` source is asked for: one tile at one slot. */
export interface DecodedTileRequest {
  tile: TileRequest;
  /** The slot, as `slotAt` or `prefetch` named it. */
  slot: number;
  /** Aborted once the renderer no longer wants the tile. */
  signal: AbortSignal;
  /** `shown`: the slot the clock shows; `prefetch`: one held ahead. */
  urgency: 'shown' | 'prefetch';
}

/**
 * A timed source: frames as URLs (one template per time), or video tiles
 * in segments, each a template whose tiles are videos spanning `start` to
 * `end` (epoch ms), a time within shown by its offset into the segment's
 * videos. Outside every segment, the nearest segment end is shown.
 *
 * `decoded` (`imageryDecoded`): tiles the application makes itself and hands
 * over as finished images. Its slots are times (epoch ms): `slotAt` names
 * the slot a time shows (`null`: none, and nothing is drawn), `prefetch` the
 * slots to hold ahead of it, nearest first. The renderer asks `tile` for the
 * tiles each held slot draws, in the layer's tiling, and only draws what it
 * is given. It shows the nearest slot only (`mode` is not read); the
 * `prefetch` option caps how many of the source's slots it holds ahead.
 */
export type TimedSource =
  | { kind: 'frames'; frames: TimedUrl[] }
  | {
      kind: 'video';
      segments: Array<{ url: string; start: number; end: number }>;
    }
  | {
      kind: 'decoded';
      slotAt(time: number): number | null;
      prefetch?(time: number): number[];
      tile(request: DecodedTileRequest): Promise<DecodedTile>;
    };

export interface ImageryLayer {
  alpha: number;
  show: boolean;
  /** Which side of the split this layer shows on. */
  split: 'none' | 'left' | 'right';
  /**
   * What it drapes onto: the globe's surface (terrain or the ellipsoid),
   * objects (3D tiles and models; `imageryOnTiles`), or all of them. The
   * default `all` drapes on whichever is drawn, so under photoreal it is
   * on the tiles. Without `imageryOnTiles`, `objects` drapes on nothing and
   * `all` on the surface. So nothing drapes while the globe is hidden and
   * either photoreal's route is `none` or there is no `imageryOnTiles`:
   * The application reads that from what it set, with no event for it.
   */
  drapeOn: 'surface' | 'objects' | 'all';
  /** Shaded by the sun like the surface (the default), or drawn unlit. */
  lit: boolean;
  /**
   * `imageryFrames`: a timed source, prefetched hidden. `clock: 'scene'`
   * (the default) shows the frame for the frame port's scene time;
   * `'own'` shows the one `setFrameTime` names.
   */
  setFrames?(
    source: TimedSource,
    options?: {
      mode?: 'nearest' | 'blend';
      prefetch?: number;
      clock?: 'scene' | 'own';
    },
  ): void;
  /** `imageryFrames`: which time to show, on the `own` clock. */
  setFrameTime?(ms: number): void;
  /**
   * `imageryFrames`: the frame the layer's clock now shows (by its time;
   * a `decoded` source's by its slot) has been drawn. Fires once each time the shown frame changes, never
   * for frames only prefetched.
   */
  on(event: 'frameReady', cb: (time: number) => void): Off;
  on(
    event: 'tileError',
    cb: (error: { tile: TileRequest; status?: number }) => void,
  ): Off;
  raise(): void;
  lower(): void;
  remove(): void;
}

export interface BaseSpec {
  photoreal?: PhotorealSpec | null;
  /** `vectorBase`: a vector basemap from a style document. */
  vector?: { styleUrl: string } | null;
  terrain?: TerrainSpec | null;
  imagery?: ImagerySpec[];
  credit?: Credit;
}

export interface BaseStatus {
  photoreal: PhotorealStatus;
  imagery: ImageryLayer[];
  settled: boolean;
}

/**
 * The sky. These switch parts of it on and off; they do not say how it
 * looks. How the sky, the atmosphere over the ground, distance haze, the
 * lighting and the tone mapping and exposure of the frame look is the
 * renderer's own, and no check compares colours. With `atmosphere`, `fog`
 * and `lighting` off and clear weather, the renderer applies none of its
 * look: what is drawn shows its own colours. Where the renderer's sun, moon
 * or fog are not separate from its atmosphere, it follows `atmosphere` for them and reports them as it draws them.
 */
export interface SkySettings {
  atmosphere: boolean;
  stars: boolean;
  /** Milky Way brightness, 0..1. */
  milkyWay: number;
  sun: boolean;
  moon: boolean;
  /** Distance fog, separate from atmosphere on models. */
  fog: boolean;
  /** Sun lighting of the globe and models. */
  lighting: boolean;
}

/**
 * `weather`: the conditions drawn around the view. Each strength is 0..1,
 * 0 drawing none of it; all are 0 at first. Clouds are a layer above the
 * ground that the camera can fly into and above; fog and haze thin what is
 * seen with distance, fog close in, haze far off; rain and snow fall around
 * the eye below the clouds and are not drawn from above them. A renderer
 * fades what makes no sense at the camera's height (rain from orbit) by
 * itself. None of it is picked or answers height queries. The application sets the
 * conditions observed at the view, which the user can override.
 *
 * The renderer draws these in its own way, as well as it can; the
 * strengths say what is observed, not how it is drawn. Clouds and
 * precipitation are where scene time (`frame.time()`) puts them, drifting
 * with `wind`: the same scene time draws the same sky, and moving scene time
 * moves them. Where the sun lights the globe (`SkySettings.lighting`),
 * clouds shade the ground and models under them.
 */
export interface WeatherSettings {
  /**
   * The fraction of the sky the clouds cover, as observed: 0 clear, about
   * 0.5 scattered to broken, 1 overcast. Under scattered cloud the ground
   * shows between the clouds, from below and from above.
   */
  clouds: number;
  /** Fog: 1 is about 500 m visibility or less. */
  fog: number;
  /** Haze. */
  haze: number;
  /** Rain. */
  rain: number;
  /** Snow. */
  snow: number;
  /** What the clouds and precipitation drift with. */
  wind: {
    /** Metres per second. */
    speedMps: number;
    /** Where the wind blows from, degrees clockwise from north. */
    fromDeg: number;
  };
}

/**
 * View-lit shading of the drawn terrain's own relief (the ellipsoid's
 * curvature where terrain has no normals); darkens only, at most
 * `strength` opacity.
 */
export type SurfaceShading = { kind: 'hillshade'; strength: number };

export interface LoadProgress {
  tilesPending: number;
  imageryPending: number;
  terrainPending: number;
}

/**
 * `surface`: what `against: 'surface'` heights answer from has loaded what
 * is in view: the terrain while the globe is shown, otherwise the drawn
 * tiles; false when neither is drawn.
 */
export type SettleKind = 'base' | 'tiles' | 'terrain' | 'imagery' | 'surface';

export interface GlobePort {
  /**
   * Switch the whole base at once; resolves when the new base has settled.
   * The last call wins: one a later `setBase` (or the renderer's disposal)
   * overtakes before its base changes (its vector style still loading)
   * changes nothing and resolves with `imagery: []`, `settled: false` and the
   * photoreal status as it stands, never rejecting.
   *
   * `settled` describes the moment the call resolves: true when its base is
   * still the one drawn (no later call has changed the base since) and has
   * settled. A later call only changes the base once its style has loaded,
   * so for a call A overtaken by a call B:
   * - A resolves before B changes the base (B's style still loading): A's
   *   base is the one drawn, so `settled: true`; B then replaces it and
   *   answers for itself.
   * - B changes the base before A resolves: `settled: false`.
   * - B's style fails (B rejects): the base stays A's, so A resolves with
   *   `settled: true` whenever it resolves.
   * Only the latest call's answer says what is drawn once every call is done.
   */
  setBase(base: BaseSpec): Promise<BaseStatus>;
  /** `photoreal`: on, off or a new token route. */
  setPhotoreal(spec: PhotorealSpec | null): Promise<PhotorealStatus>;
  setTerrain(spec: TerrainSpec | null): Promise<void>;
  /** Show or hide the globe surface (hidden under photoreal). */
  setGlobeVisible(visible: boolean): void;
  /**
   * `globeVisibility`: whether the globe surface is shown now, as
   * `setGlobeVisible` or whoever last set it left it. For code that only holds
   * the scene and must know whether the surface it drapes on or samples is
   * drawn.
   */
  isGlobeVisible?(): boolean;
  /**
   * `surfaceIdentity`: a number that changes whenever what heights answer
   * against changes (base, terrain or photoreal route swapped, the globe
   * shown or hidden) and never otherwise (not on camera moves or tile
   * loads). The application keys cached surface heights by it.
   */
  surfaceVersion?(): number;
  /** `surfaceShading`. */
  setSurfaceShading?(shading: SurfaceShading | null): void;
  readonly imagery: {
    /**
     * Without `imageHooks`, a spec with `tileTransform`, `admit` or kind
     * `canvas` throws, rather than drawing tiles the hooks were meant to
     * change.
     */
    add(spec: ImagerySpec, index?: number): ImageryLayer;
    list(): ImageryLayer[];
    /** `splitSwipe`: split position, a fraction of the canvas's CSS width. */
    getSplit?(): number;
    /** `splitSwipe`: move the split to `x01` of the canvas's CSS width. */
    setSplit?(x01: number): void;
  };
  readonly sky: {
    get(): SkySettings;
    set(settings: Partial<SkySettings>): void;
  };
  /**
   * `weather`. `set` keeps each strength it is not given or given as no
   * number, clamps the others to 0..1, and asks for a frame. `wind` is taken
   * whole: a speed below 0 or missing is 0, the direction is wrapped into
   * [0, 360) and a missing one is 0. `get` answers a copy of what was set;
   * at first every strength and the wind speed are 0 (`CLEAR_WEATHER` in
   * `src/render/weather.js`, whose `mergeWeather` is these rules).
   */
  readonly weather?: {
    get(): WeatherSettings;
    set(settings: Partial<WeatherSettings>): void;
  };
  /** Whether that part of the base has finished loading what is in view. */
  isSettled(kind: SettleKind): boolean;
  on(event: 'progress', cb: (progress: LoadProgress) => void): Off;
}
