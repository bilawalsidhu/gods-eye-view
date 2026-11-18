/**
 * Wind streamlines baked from a wind grid (`streamlines.js`): the paths a
 * `windStreamlines` field draws.
 */

/** A wind grid: row-major from `la1` (north) southward. */
export interface WindGrid {
  u: Float32Array;
  v: Float32Array;
  nx: number;
  ny: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
}

export interface WindPath {
  coordinates: Array<[lon: number, lat: number]>;
  speed: number;
  seed: number;
  phase: number;
}

export const WIND_PATH_LIMIT: number;
export const WIND_NARROW_PATH_LIMIT: number;
export const WIND_PATH_STEPS: number;
export const WIND_DISPLAY_HEIGHT_METERS: number;
export const WIND_CELL_DEGREES: number;

/**
 * Bake streamlines once from a wind grid; with `bounds` (degrees), seeds
 * fall inside it and paths stop at its edges.
 */
export function bakeWindStreamlines(
  grid: WindGrid,
  options?: {
    count?: number;
    steps?: number;
    stepSeconds?: number;
    bounds?: {
      west: number;
      south: number;
      east: number;
      north: number;
    } | null;
  },
): WindPath[];

/** Group baked paths by their middle coordinate. */
export function groupWindPaths(
  paths: WindPath[],
  cellDegrees?: number,
): Array<{ id: number; paths: WindPath[] }>;
