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
   * (for the default renderer, one hosted on Cesium ion).
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
  | { kind: 'quantizedMesh'; url: string; requestVertexNormals?: boolean }
  /**
   * The renderer's global terrain, through `CreateOptions.worldDataToken`
   * (for the default renderer, Cesium World Terrain).
   */
  | { kind: 'world'; requestVertexNormals?: boolean }
  /** A DEM image pyramid (`{z}/{x}/{y}`), heights encoded in RGB. */
  | {
      kind: 'heightmap';
      url: string;
      encoding: 'terrarium' | 'mapbox';
      maxLevel?: number;
      /** The geoid the encoded heights are relative to; omitted: the ellipsoid. */
      geoid?: 'egm96' | 'egm2008';
    }
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
  kind: 'xyz' | 'wmts' | 'arcgis' | 'world' | 'single-image' | 'canvas';
  /** `world`: aerial (the default), or aerial with labels. */
  worldStyle?: 'aerial' | 'aerialLabels';
  /** URL or URL template (`{x}`, `{y}`, `{z}`, `{s}`, `{time}`). */
  url?: string;
  /** `'canvas'` (`imageHooks`): draws one tile. */
  drawTile?: (tile: TileRequest, canvas: HTMLCanvasElement) => void;
  /** WMTS: layer, style, tile matrix set and format. */
  wmts?: {
    layer: string;
    style: string;
    tileMatrixSetId: string;
    format?: string;
  };
  subdomains?: string[];
  tiling?: TilingScheme;
  rectangle?: GeoRect;
  minLevel?: number;
  maxLevel?: number;
  tileSize?: number;
  credit?: Credit;
  /** Requests in flight at once for this layer. */
  maxConcurrentRequests?: number;
  /** HTTP statuses retried rather than treated as missing. */
  retryStatuses?: number[];
  /**
   * Fetches a tile in place of the renderer, with the URL it would fetch.
   * Every renderer calls it, before its own decoding (in a worker, say).
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
   * again on a later frame. `fetchTile`'s `defer` does the same anywhere.
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
 * A timed source: frames as URLs (one template per time), or video tiles
 * in segments, each a template whose tiles are videos spanning `start` to
 * `end` (epoch ms), a time within shown by its offset into the segment's
 * videos. Outside every segment, the nearest segment end is shown.
 */
export type TimedSource =
  | { kind: 'frames'; frames: TimedUrl[] }
  | {
      kind: 'video';
      segments: Array<{ url: string; start: number; end: number }>;
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
   * Core reads that from what it set, with no event for it.
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
   * `imageryFrames`: the frame the layer's clock now shows (by its time)
   * has been drawn. Fires once each time the shown frame changes, never
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
 * The sky. A renderer whose sun, moon or fog are not separate from its
 * atmosphere follows `atmosphere` for them and reports them as it draws them.
 */
export interface SkySettings {
  atmosphere: boolean;
  atmosphereTuning?: {
    brightness?: number;
    hueShift?: number;
    saturation?: number;
  };
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

export interface SurfaceShading {
  kind: 'relief';
  /** Elevation-like field to shade, row-major, `width × height`. */
  values: Float32Array;
  width: number;
  height: number;
  rectangle: GeoRect;
  strength: number;
}

export interface LoadProgress {
  tilesPending: number;
  imageryPending: number;
  terrainPending: number;
}

export type SettleKind = 'base' | 'tiles' | 'terrain' | 'imagery';

export interface GlobePort {
  /** Switch the whole base at once; resolves when the new base has settled. */
  setBase(base: BaseSpec): Promise<BaseStatus>;
  /** `photoreal`: on, off or a new token route. */
  setPhotoreal(spec: PhotorealSpec | null): Promise<PhotorealStatus>;
  setTerrain(spec: TerrainSpec | null): Promise<void>;
  /** Show or hide the globe surface (hidden under photoreal). */
  setGlobeVisible(visible: boolean): void;
  /** `surfaceShading`. */
  setSurfaceShading?(shading: SurfaceShading | null): void;
  /** `clouds`: the renderer's volumetric clouds, or none. */
  setClouds?(clouds: { coverage: number } | null): void;
  /** `water`: the renderer's own water surface on the oceans, on or off. */
  setWater?(enabled: boolean): void;
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
  /** Whether that part of the base has finished loading what is in view. */
  isSettled(kind: SettleKind): boolean;
  on(event: 'progress', cb: (progress: LoadProgress) => void): Off;
}
