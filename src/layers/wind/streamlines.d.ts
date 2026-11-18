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
  /** False for a grid over part of the globe: it is never read outside itself. */
  periodic?: boolean;
  /** A sample equal to this in `u` or `v` is missing. */
  noData?: number;
  /** The grid's own extent, degrees: bake bounds when none are given. */
  bbox?: FieldBox | null;
}

/** A field's extent in degrees; `lonMax` west of `lonMin` crosses the antimeridian. */
export interface FieldBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/** Bake bounds in degrees, east of west; east may run past 180°. */
export interface BakeBounds {
  west: number;
  south: number;
  east: number;
  north: number;
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
 * The bound on one path step, degrees: 0.75 on a global grid, a 64th of the
 * longer side of a regional one.
 */
export function fieldStepCap(
  grid: Pick<WindGrid, 'nx' | 'ny' | 'dx' | 'dy'>,
): number;

/** A field's `bbox` as bake bounds; null without one. */
export function boundsOfBox(bbox?: FieldBox | null): BakeBounds | null;

/**
 * Bake streamlines once from a wind grid; with `bounds` (degrees), seeds
 * fall inside it and paths stop at its edges. Left undefined, the grid's own
 * `bbox` gives them. `maxCount` raises the seed ceiling above
 * `WIND_PATH_LIMIT`; `calmCutoffMs` (0.15 m/s) ends paths in slow flow;
 * `maxStepDegrees` bounds one step (0.75° on a global grid).
 */
export function bakeWindStreamlines(
  grid: WindGrid,
  options?: {
    count?: number;
    maxCount?: number;
    steps?: number;
    stepSeconds?: number;
    calmCutoffMs?: number;
    maxStepDegrees?: number;
    bounds?: BakeBounds | null;
  },
): WindPath[];

/**
 * Summed path length in degrees (longitude scaled by cos latitude) over
 * `spanDeg`; 0 for no paths or no span.
 */
export function measureLineCoverage(paths: WindPath[], spanDeg: number): number;

/** Group baked paths by their middle coordinate. */
export function groupWindPaths(
  paths: WindPath[],
  cellDegrees?: number,
): Array<{ id: number; paths: WindPath[] }>;
