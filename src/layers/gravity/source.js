import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { decodeLandMaskRuns } from './landMask.js';

const CELLS = 360 * 180;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the same-origin index of monthly GRACE/GRACE-FO solutions. */
export function validateGravityIndex(value) {
  const grid = value?.grid;
  if (
    value?.schemaVersion !== 1 ||
    grid?.nx !== 360 ||
    grid?.ny !== 180 ||
    grid?.lo1 !== -179.5 ||
    grid?.la1 !== 89.5 ||
    grid?.dx !== 1 ||
    grid?.dy !== 1 ||
    !(value.scaleCm > 0) ||
    !Number.isInteger(value.noData) ||
    !Array.isArray(value.solutions) ||
    value.solutions.length === 0 ||
    value.solutions.some(
      (solution) =>
        !DAY.test(solution?.id) ||
        !DAY.test(solution?.start) ||
        !DAY.test(solution?.end) ||
        solution.end <= solution.start,
    ) ||
    value.solutions.some(
      (solution, index) =>
        index > 0 && solution.id <= value.solutions[index - 1].id,
    )
  )
    throw new Error('Malformed gravity index');
  return value;
}

/** Monthly mass-change fields from the local /api/gravity proxy. */
export function createGravitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  async function request(path, { signal } = {}, read) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Gravity request timed out')),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(path, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 503) {
        const body = await readResponseJsonCapped(
          response,
          10_000,
          controller.signal,
        ).catch(() => null);
        const error = new Error(body?.error || 'Gravity record unavailable');
        error.code = body?.code || 'GRAVITY_UNAVAILABLE';
        error.retryable = true;
        throw error;
      }
      if (!response.ok) throw new Error(`Gravity HTTP ${response.status}`);
      return await read(response, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async getIndex(options) {
      return validateGravityIndex(
        await request('/api/gravity/index', options, (response, signal) =>
          readResponseJsonCapped(response, 1_000_000, signal),
        ),
      );
    },
    /** One solution as stored counts, row 0 north, column 0 at 180°W. */
    async getField(id, options) {
      if (!DAY.test(id)) throw new Error('Unknown gravity solution');
      const bytes = await request(
        `/api/gravity/field?id=${id}`,
        options,
        (response, signal) =>
          readResponseBytesCapped(response, CELLS * 2, signal),
      );
      if (bytes.byteLength !== CELLS * 2)
        throw new Error('Malformed gravity field');
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const field = new Int16Array(CELLS);
      for (let i = 0; i < CELLS; i++) field[i] = view.getInt16(i * 2, true);
      return field;
    },
    /** CSR's 0.25° land mask, decoded: one byte per cell, 1 for land. */
    async getLandMask(options) {
      const bytes = await request(
        '/api/gravity/landmask',
        options,
        (response, signal) =>
          readResponseBytesCapped(response, 200_000, signal),
      );
      return decodeLandMaskRuns(bytes);
    },
    /** One cell's value in cm for every solution, in index order. */
    async getCell(lat, lon, options) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        throw new Error('Invalid gravity cell');
      const query = new URLSearchParams({
        lat: lat.toFixed(3),
        lon: lon.toFixed(3),
      });
      const body = await request(
        `/api/gravity/cell?${query}`,
        options,
        (response, signal) => readResponseJsonCapped(response, 100_000, signal),
      );
      if (
        !Number.isFinite(body?.lat) ||
        !Number.isFinite(body?.lon) ||
        !Array.isArray(body.values) ||
        body.values.some((value) => value !== null && !Number.isFinite(value))
      )
        throw new Error('Malformed gravity cell');
      return { lat: body.lat, lon: body.lon, values: body.values };
    },
  };
}
