import { decodeWindGribMessage } from './wind/decode.js';
import { ifsObjectUrls } from './wind/ifs.js';
import {
  createIfsFieldRoute,
  fetchIfsCycleMessages,
  resampleMaskedGrid,
} from './ifsOcean.js';

// ECMWF IFS open data, `oper` stream: eastward and northward surface sea water
// velocity (`sve`, `svn`, m/s) from the coupled ocean model, on the same 0.25°
// grid and cycles as the wind fields. CC BY 4.0, keyless. Land has no value
// (ecCodes fills it with missingValue). Each message is about 0.6 MB.
const UNITS = 'm s**-1';
/** 0.5° keeps the Gulf Stream and Kuroshio resolved at 2 × 720 × 361 floats (~2 MB). */
const TARGET_DX = 0.5;

/**
 * Fetch and decode the IFS surface current valid closest to now.
 * @param {{fetchImpl?: Function, now?: Function, decodeImpl?: Function,
 *   signal?: AbortSignal, targetDx?: number}} [options]
 * @returns {Promise<{cycle: object, grid: object}>} `grid.u` and `grid.v` share
 *   one geometry and one land mask; `grid.max` is the largest speed.
 */
export async function fetchIfsSurfaceCurrents({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  signal,
  targetDx = TARGET_DX,
} = {}) {
  const { cycle, messages } = await fetchIfsCycleMessages({
    urlsFor: ifsObjectUrls,
    params: ['sve', 'svn'],
    fetchImpl,
    now,
    signal,
  });
  const east = await decodeImpl(messages.sve);
  const north = await decodeImpl(messages.svn);
  signal?.throwIfAborted();
  if (
    east?.shortName !== 'sve' ||
    north?.shortName !== 'svn' ||
    east.units !== UNITS ||
    north.units !== UNITS
  )
    throw new Error('Unexpected ocean-current field');
  const u = resampleMaskedGrid(east, targetDx);
  const v = resampleMaskedGrid(north, targetDx);
  if (u.nx !== v.nx || u.ny !== v.ny)
    throw new Error('Mismatched ocean-current grids');
  // A point is sea only where both components are; one-sided coast cells
  // would draw flow along a single axis.
  let valid = 0;
  let max = 0;
  for (let i = 0; i < u.values.length; i += 1) {
    if (Number.isNaN(u.values[i]) || Number.isNaN(v.values[i])) {
      u.values[i] = NaN;
      v.values[i] = NaN;
      continue;
    }
    valid += 1;
    max = Math.max(max, Math.hypot(u.values[i], v.values[i]));
  }
  if (!valid) throw new Error('Empty ocean-current field');
  // One buffer, u then v, so the route serves both in a single response.
  const values = new Float32Array(u.values.length * 2);
  values.set(u.values, 0);
  values.set(v.values, u.values.length);
  return {
    cycle,
    grid: {
      nx: u.nx,
      ny: u.ny,
      lo1: u.lo1,
      la1: u.la1,
      dx: u.dx,
      dy: u.dy,
      values,
      valid,
      max,
    },
  };
}

/** Bounded, single-flight, global surface-current snapshot for dev and preview. */
export function oceanCurrentsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  load = fetchIfsSurfaceCurrents,
} = {}) {
  return createIfsFieldRoute({
    name: 'ocean-currents',
    path: '/api/ocean-currents',
    errorCode: 'ocean_currents_unavailable',
    load,
    describe: ({ grid }) => ({
      field: {
        kind: 'surface-sea-water-velocity',
        units: 'm/s',
        components: ['u', 'v'],
      },
      oceanCells: grid.valid,
      maxSpeed: Math.round(grid.max * 100) / 100,
    }),
    gridOf: ({ grid }) => grid.values,
    fetchImpl,
    now,
    decodeImpl,
  });
}
