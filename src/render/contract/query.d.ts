/**
 * Questions about what is on screen.
 *
 * Picks, projection and rays are synchronous and answer against the last
 * presented frame. Heights have a synchronous cache-only form that may
 * return null, and asynchronous forms that load what they need.
 *
 * Picks, depth picks and rays answer against the scene as drawn before
 * effects: a style that moves pixels does not move what is picked, so the application
 * maps a pointer through its own style before it picks.
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
  /**
   * The pickable draw-set items under the pointer, nearest first, each once:
   * never the surface (`surface` is always false) and never anything that is
   * not a draw-set item. `limit`, a whole number of 0 or more, bounds the
   * work as well as the answer: the renderer stops at `limit` hits and
   * looks through at most `max(limit, 16)` things of any kind under the pointer that its picks
   * see (tiles, unpickable items it still picks, its own), so it may return
   * fewer than `limit` when more lie above them. Omitted: every item, at
   * whatever cost.
   */
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
  /** Null while the canvas has no size (hidden, not laid out yet). */
  pickRay(x: number, y: number): Ray | null;
  /** Screen position, or null behind the eye (off-screen points still answer). */
  project(position: Ecef): ScreenXY | null;
  /**
   * Packed `x, y, z` in → packed `x, y` out, CSS pixels; NaN for points
   * behind the eye. For the label overlay's per-frame pass.
   */
  projectMany(source: Float64Array, out: Float32Array): void;
  /** Hidden by the ellipsoid's horizon from the current eye. */
  isOccluded(position: Ecef): boolean;
  /**
   * `occlusionTest`: a test of many points against the depth of the frames
   * drawn, for overlays that leave out what something stands in front of.
   * Each call makes a new one; its owner destroys it.
   */
  occlusionTest?(): OcclusionTest;
  /** `sampleHeight`: cached height now, or null when not loaded. */
  sampleHeightNow(point: LonLat, options?: HeightOptions): number | null;
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

/**
 * One point under test (`OcclusionTest.add`): the test's owner keeps it and
 * reads the answer from it. The test sets `pending` when it takes the point,
 * and when the answer comes clears `pending`, sets `answered` and, when
 * something drawn stood in front of the point, sets `lastHiddenAt` to
 * `OcclusionTest`'s clock as of the frame it was tested against.
 */
export interface OcclusionPoint {
  pending: boolean;
  answered: boolean;
  lastHiddenAt: number;
  /** When the owner queued it, on the same clock. */
  queuedAt: number;
}

/**
 * Tests points against the depth of the frames as drawn, without waiting
 * for the GPU: an answer may come a frame or two after its test.
 */
export interface OcclusionTest {
  /**
   * `'async'` while answers come a frame or two after their test, `'sync'`
   * while they come at once, `'off'` while nothing can be tested (no depth
   * to test against): every point is then to be taken as seen.
   */
  readonly mode: 'async' | 'sync' | 'off';
  /** How many points it takes in one frame; Infinity when unbounded. */
  readonly maxPerFrame: number;
  /** Open a frame, collecting the answers that have come; `now` dates them. */
  beginFrame(now: number): void;
  /**
   * Test `point`, at `position`, against this frame: hidden when a surface
   * drawn stands in front of it by more than a small margin, which grows as
   * the view looks along the ground rather than down on it. False when it
   * cannot take one more this frame.
   */
  add(point: OcclusionPoint, position: Ecef): boolean;
  /** Close the frame: start the tests taken. */
  endFrame(): void;
  /** Drop every test under way. */
  reset(): void;
  destroy(): void;
}
