import { fetchText, fetchRange } from './wind/gfs.js';
import {
  nearestIfsStep,
  parseIfsIndex,
  selectLatestIfsCycle,
} from './wind/ifs.js';

// Shared by the ocean fields read from ECMWF IFS open data (sea state from
// the `wave` stream, surface currents from `oper`): one global field per
// cycle step, read by byte range and resampled with land masked. The route
// that serves them is server/providers/globalFieldRoute.js.

/**
 * Resample a north-to-south source grid with missing points onto a global
 * equirectangular grid starting at 0°E, 90°N. Each output point is the
 * bilinear blend of the valid corners around it, reweighted, so a coastal
 * cell is never pulled toward the fill value; with no valid corner it is NaN.
 * @param {{values: ArrayLike<number>, missingValue: number|null, ni: number,
 *   nj: number, lo1: number, la1: number, di: number, dj: number}} field
 * @param {number} dx - Output spacing in degrees, both axes.
 * @param {{min?: number}} [options] - Values below `min` count as missing
 *   (wave height is never negative; a current component often is).
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, values: Float32Array, valid: number, max: number}}
 */
export function resampleMaskedGrid(field, dx, { min = -Infinity } = {}) {
  const { values, missingValue, ni, nj, lo1, la1, di, dj } = field ?? {};
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 2 ||
    nj < 2 ||
    ni * nj > 2_000_000 ||
    values?.length !== ni * nj ||
    ![lo1, la1, di, dj, dx].every(Number.isFinite) ||
    di <= 0 ||
    dj <= 0 ||
    dx < 0.25 ||
    dx > 90 ||
    (missingValue !== null && !Number.isFinite(missingValue))
  )
    throw new Error('Invalid IFS grid geometry');
  const isValid = (value) =>
    Number.isFinite(value) && value !== missingValue && value >= min;
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dx) + 1;
  const out = new Float32Array(nx * ny);
  let valid = 0;
  let max = -Infinity;
  for (let y = 0; y < ny; y += 1) {
    const lat = 90 - y * dx;
    const sy = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const y0 = Math.floor(sy);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < nx; x += 1) {
      const sx = ((((x * dx - lo1) / di) % ni) + ni) % ni;
      const x0 = Math.floor(sx);
      const x1 = (x0 + 1) % ni;
      const fx = sx - x0;
      let sum = 0;
      let weight = 0;
      for (const [index, w] of [
        [y0 * ni + x0, (1 - fx) * (1 - fy)],
        [y0 * ni + x1, fx * (1 - fy)],
        [y1 * ni + x0, (1 - fx) * fy],
        [y1 * ni + x1, fx * fy],
      ]) {
        if (w > 0 && isValid(values[index])) {
          sum += values[index] * w;
          weight += w;
        }
      }
      const value = weight > 0 ? sum / weight : NaN;
      out[y * nx + x] = value;
      if (weight > 0) {
        valid += 1;
        if (value > max) max = value;
      }
    }
  }
  return {
    nx,
    ny,
    lo1: 0,
    la1: 90,
    dx,
    dy: dx,
    values: out,
    valid,
    max: valid ? max : 0,
  };
}

/**
 * Read the named GRIB messages of the newest IFS run that should be posted,
 * falling back one cycle (6 h) once. Six hours after a run its files can
 * still be missing (both streams answered 404 at 6 h 54 min on 2026-10-24),
 * and an index can be posted before its GRIB file is served, so either
 * failure moves to the previous cycle.
 * @param {{urlsFor: (cycle: {date: string, hour: number, step: number}) =>
 *   {grib: string, index: string}, params: string[], fetchImpl: Function,
 *   now: () => number, signal?: AbortSignal}} options
 * @returns {Promise<{cycle: object, messages: Record<string, Uint8Array>}>}
 */
export async function fetchIfsCycleMessages({
  urlsFor,
  params,
  fetchImpl,
  now,
  signal,
}) {
  const nowMs = now();
  for (const lagHours of [6, 12]) {
    const cycle = selectLatestIfsCycle(nowMs, {
      availabilityLagMs: lagHours * 3600_000,
    });
    const runMs = Date.UTC(
      Number(cycle.date.slice(0, 4)),
      Number(cycle.date.slice(4, 6)) - 1,
      Number(cycle.date.slice(6, 8)),
      cycle.hour,
    );
    // The `oper` and `wave` streams publish the same steps (checked
    // 2026-10-24: 3-hourly to f144, then 6-hourly to f360 on 00/12z only).
    const forecastHour = nearestIfsStep((nowMs - runMs) / 3600_000, cycle.hour);
    const urls = urlsFor({ ...cycle, step: forecastHour });
    try {
      const index = parseIfsIndex(
        (await fetchText({ url: urls.index, fetchImpl, signal })).toString(),
      );
      const messages = {};
      for (const param of params) {
        const entry = index.find((item) => item.param === param);
        if (!entry) throw new Error(`missing ${param}`);
        messages[param] = await fetchRange({
          url: urls.grib,
          start: entry.offset,
          end: entry.offset + entry.length - 1,
          fetchImpl,
          signal,
        });
      }
      return {
        cycle: {
          ...cycle,
          forecastHour,
          runIso: new Date(runMs).toISOString(),
          validIso: new Date(runMs + forecastHour * 3600_000).toISOString(),
        },
        messages,
      };
    } catch (error) {
      if (lagHours === 12 || signal?.aborted) throw error;
    }
  }
}

/** Grid id of an IFS field: run date and hour, forecast step, spacing. */
export function ifsFieldGridId({ cycle, grid }) {
  return `ifs-${cycle.date}-${cycle.hour}-f${cycle.forecastHour}-${grid.dx}`;
}
