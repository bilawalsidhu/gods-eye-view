/**
 * The vector base painter (`index.js`): a MapLibre style's vector tiles
 * painted as raster tiles, Cesium-free.
 */

/** The fetch the painter calls. */
export type VectorFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** A loaded style, as `paintVectorTile` paints it. */
export interface VectorStyle {
  url: string;
  style: object;
  sources: Record<
    string,
    {
      tiles: string[];
      minzoom: number;
      maxzoom: number;
      scheme: 'xyz' | 'tms';
      attribution?: string;
    }
  >;
  layers: object[];
  background: { color: string; opacity: number } | null;
  /** Each layer the painter cannot draw, with why. */
  skipped: Array<{ id: string; reason: string }>;
  /** Each vector source's attribution (markup). */
  attribution: string[];
  tiles: Map<string, Promise<object>>;
}

/** Layer types the painter draws. */
export const PAINTED_TYPES: readonly string[];
/** A painted tile's side, CSS pixels. */
export const STYLE_TILE_SIZE: number;

/**
 * Load a style document and the TileJSON its vector sources name; rejects
 * for a document that is no style, or a source that fails to load.
 */
export function loadVectorStyle(
  styleUrl: string,
  fetch?: VectorFetch,
  options?: { signal?: AbortSignal },
): Promise<VectorStyle>;

/** Paint Web Mercator tile `z`/`x`/`y` of `style`. */
export function paintVectorTile(
  style: VectorStyle,
  z: number,
  x: number,
  y: number,
  options?: {
    size?: number;
    fetch?: VectorFetch;
    signal?: AbortSignal;
    canvas?: (size: number) => HTMLCanvasElement | OffscreenCanvas;
  },
): Promise<HTMLCanvasElement | OffscreenCanvas>;

/** What a style asks for that the painter does not draw. */
export class Unsupported extends Error {}
/** A style expression, compiled. */
export function compileExpression(expr: unknown): (feature: object) => unknown;
/** A layer's `filter`, compiled (none: every feature). */
export function compileFilter(filter: unknown): (feature: object) => boolean;
/** A layout or paint value, compiled. */
export function compileValue(
  value: unknown,
  options?: { array?: boolean; interpolated?: boolean },
): (feature: object) => unknown;
/** A CSS colour as `[r, g, b, a]` (0..255, alpha 0..1), or null. */
export function parseColor(
  text: unknown,
): [r: number, g: number, b: number, a: number] | null;
