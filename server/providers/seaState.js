import { decodeWindGribMessage } from './wind/decode.js';
import {
  createIfsFieldRoute,
  fetchIfsCycleMessages,
  resampleMaskedGrid,
} from './ifsOcean.js';

// ECMWF IFS open data, wave stream: significant height of combined wind waves
// and swell (`swh`, metres) on the same 0.25° grid and cycles as the `oper`
// fields the wind layer reads. CC BY 4.0, keyless. Land has no value: the
// message carries a bitmap and ecCodes fills those points with missingValue.
const IFS_BASE = 'https://data.ecmwf.int/forecasts';
/** 0.5° keeps coastlines readable and the grid at 720 × 361 floats (~1 MB). */
const TARGET_DX = 0.5;

/**
 * IFS wave-stream GRIB2 and `.index` URLs for one cycle and step.
 * @param {{date: string, hour: number, step?: number}} cycle
 * @returns {{grib: string, index: string}}
 */
export function ifsWaveObjectUrls({ date, hour, step = 0 }) {
  const hh = String(hour).padStart(2, '0');
  const stem = `${IFS_BASE}/${date}/${hh}z/ifs/0p25/wave/${date}${hh}0000-${step}h-wave-fc`;
  return { grib: `${stem}.grib2`, index: `${stem}.index` };
}

/**
 * Fetch and decode the IFS significant wave height valid closest to now.
 * @param {{fetchImpl?: Function, now?: Function, decodeImpl?: Function,
 *   signal?: AbortSignal, targetDx?: number}} [options]
 */
export async function fetchIfsWaveHeight({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  signal,
  targetDx = TARGET_DX,
} = {}) {
  const { cycle, messages } = await fetchIfsCycleMessages({
    urlsFor: ifsWaveObjectUrls,
    params: ['swh'],
    fetchImpl,
    now,
    signal,
  });
  const field = await decodeImpl(messages.swh);
  signal?.throwIfAborted();
  if (field?.shortName !== 'swh' || field.units !== 'm')
    throw new Error('Unexpected sea-state field');
  const grid = resampleMaskedGrid(field, targetDx, { min: 0 });
  if (!grid.valid) throw new Error('Empty sea-state field');
  return { cycle, grid };
}

/** Bounded, single-flight, global significant-wave-height snapshot for dev and preview. */
export function seaStateProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  load = fetchIfsWaveHeight,
} = {}) {
  return createIfsFieldRoute({
    name: 'sea-state',
    path: '/api/sea-state',
    errorCode: 'sea_state_unavailable',
    load,
    describe: ({ grid }) => ({
      field: { kind: 'significant-wave-height', units: 'm' },
      oceanCells: grid.valid,
      maxValue: Math.round(grid.max * 100) / 100,
    }),
    gridOf: ({ grid }) => grid.values,
    fetchImpl,
    now,
    decodeImpl,
  });
}
