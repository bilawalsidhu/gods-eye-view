/**
 * Questions about what is on screen.
 *
 * Picks, projection and rays are synchronous and answer against the last
 * presented frame. Heights have a synchronous cache-only form that may
 * return null, and asynchronous forms that load what they need.
 */
import type { Ecef, LonLat, Meta, Ray, ScreenXY } from './common';

/** One thing under the pointer. */
export interface Hit {
  /** The draw set's id. */
  set: string;
  /** The item's id. */
  id: string;
  /** The item's `meta`, as it was given; absent when the item had none. */
  meta?: Meta;
  /** The item's `lodGroup`, when it has one: the thing it is a detail level of. */
  lodGroup?: string;
  /** The map itself (tiles or globe), rather than a drawn item. */
  surface: boolean;
  /** Where the hit is, when the renderer knows it. */
  position?: Ecef;
}

export interface PickWindow {
  /** Pick window, CSS pixels; default 3 × 3. */
  width?: number;
  height?: number;
  /**
   * What the pick is for. A hover pick may skip costly exact tests (a
   * point-in-polygon on a large fill) that a select pick must make.
   */
  purpose?: 'hover' | 'select';
}

export interface HeightOptions {
  /**
   * `surface`: tiles where they are drawn, otherwise terrain. Sets drawn
   * with `includeInHeightQueries` count under `surface` and `tiles`, never
   * under `terrain`.
   */
  against?: 'surface' | 'terrain' | 'tiles';
  /** Set ids to see through, of those drawn with `includeInHeightQueries`. */
  exclude?: string[];
}

export interface HeightSample {
  /** Metres above the ellipsoid. */
  height: number;
  /** 1 for the most detailed data, lower for a coarser level. */
  confidence: number;
  /** `set`: a draw set drawn with `includeInHeightQueries`. */
  source: 'tiles' | 'terrain' | 'ellipsoid' | 'set';
  /** The detail answered from: what is drawn now, or (`finestHeights`) the finest available. */
  lod: 'visible' | 'finest';
  /** Edge length of the tile answered from, metres, when known. */
  tileSizeM?: number;
}

export interface QueryPort {
  pick(x: number, y: number, window?: PickWindow): Hit | null;
  drillPick(
    x: number,
    y: number,
    options?: PickWindow & { limit?: number },
  ): Hit[];
  /** `pickPosition`: depth under the pointer, against tiles and terrain. */
  pickPosition(x: number, y: number): Ecef | null;
  pickEllipsoid(x: number, y: number): Ecef | null;
  /** Where a ray meets the globe surface (not tiles). */
  pickGlobe(ray: Ray): Ecef | null;
  pickRay(x: number, y: number): Ray;
  /** Screen position, or null behind the eye (off-screen points still answer). */
  project(position: Ecef): ScreenXY | null;
  /**
   * Packed `x, y, z` in → packed `x, y` out, CSS pixels; NaN for points
   * behind the eye. For the label overlay's per-frame pass.
   */
  projectMany(source: Float64Array, out: Float32Array): void;
  /** Hidden by the ellipsoid's horizon from the current eye. */
  isOccluded(position: Ecef): boolean;
  /** `sampleHeight`: cached height now, or null when not loaded. */
  sampleHeightNow(point: LonLat, options?: HeightOptions): number | null;
  /**
   * `sampleHeight`: cached heights for many points at once: packed `lon, lat`
   * degrees in, one height per point out (NaN when not loaded). Core makes
   * its per-frame height reads through this, once a frame.
   */
  sampleHeightNowMany(
    points: Float64Array,
    out: Float64Array,
    options?: HeightOptions,
  ): void;
  /**
   * `sampleHeight`: heights, loading as needed; null per miss.
   * `mostDetailed` (`finestHeights`) waits for the finest data.
   */
  sampleHeight(
    points: LonLat[],
    options?: HeightOptions & { mostDetailed?: boolean },
  ): Promise<Array<HeightSample | null>>;
  /** `sampleHeight`: positions moved onto the surface; null per miss. */
  clampToSurface(
    positions: Ecef[],
    options?: HeightOptions,
  ): Promise<Array<Ecef | null>>;
  /** `rayCast`: first surface hit along a ray. */
  rayCast(
    ray: Ray,
    options?: HeightOptions & { maxDistance?: number },
  ): Promise<Ecef | null>;
}
