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
  /** Fall back to an ion-hosted copy when Google refuses. */
  ionFallback?: boolean;
}

export interface PhotorealStatus {
  /** Which route is drawing, or `'none'` when photoreal is off or failed. */
  route: 'google' | 'ion' | 'none';
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
  | { kind: 'ion'; assetId: number }
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

export interface ImagerySpec {
  kind: 'xyz' | 'wmts' | 'arcgis' | 'bing' | 'single-image' | 'canvas';
  /** URL or URL template (`{x}`, `{y}`, `{z}`, `{s}`, `{time}`). */
  url?: string;
  /** `'canvas'`: draws one tile. */
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
  /** Changes a tile's image before it is drawn. */
  tileTransform?: (
    tile: TileRequest,
    image: ImageBitmap,
  ) => ImageBitmap | Promise<ImageBitmap>;
  /**
   * Decides each tile request: call `issue()` to fetch it, or return
   * `undefined` to defer it and be asked again on a later frame.
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

export interface ImageryLayer {
  alpha: number;
  show: boolean;
  /** Which side of the split this layer shows on. */
  split: 'none' | 'left' | 'right';
  /** What it drapes onto. `'active'` follows whichever base is showing. */
  drapeOn: 'globe' | 'tiles' | 'both' | 'active';
  /** `imageryFrames`: a timed sequence, prefetched hidden. */
  setFrames?(
    frames: TimedUrl[],
    options?: { mode?: 'nearest' | 'blend'; prefetch?: number },
  ): void;
  /** `imageryFrames`: which time to show. */
  setFrameTime?(ms: number): void;
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
  readonly imagery: {
    add(spec: ImagerySpec, index?: number): ImageryLayer;
    list(): ImageryLayer[];
    /** What imagery drapes onto now. */
    host(): 'globe' | 'tiles' | 'both';
    onHostChange(cb: (host: 'globe' | 'tiles' | 'both') => void): Off;
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
