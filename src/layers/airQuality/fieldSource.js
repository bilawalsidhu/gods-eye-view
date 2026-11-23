import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { FIELD_IDS, readFieldManifest } from './field.js';

// Failures stay English data for the console: the card says only that the
// model field is unavailable.

const MAX_MANIFEST_BYTES = 256 * 1024;
/** Whether this platform's typed arrays are little-endian, as the grids are. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Little-endian 16-bit values, whatever the platform's byte order. */
function uint16Of(bytes) {
  if (LITTLE_ENDIAN) return new Uint16Array(bytes.slice().buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Uint16Array(bytes.byteLength / 2);
  for (let i = 0; i < values.length; i++)
    values[i] = view.getUint16(i * 2, true);
  return values;
}

/**
 * The model field Core's own server serves from a local folder of baked
 * grids (`AIR_QUALITY_FIELD_DIR`, `server/providers/airQualityField.js`), as
 * a `fieldSource` (`field.js`). Unset, the server says the field is not
 * configured, this source rejects with `code: 'not_configured'`, and the
 * layer shows stations only. Same-origin, bounded and cancellable.
 * @param {{fetchImpl?: typeof fetch, base?: string, timeoutMs?: number}} [options]
 */
export function createLocalAirQualityFieldSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/air-quality/field',
  timeoutMs = 45_000,
} = {}) {
  let manifest = null;
  /** Run `job(signal)` under the caller's signal and a deadline. */
  const bounded = async (signal, job) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Air-quality field request timed out')),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      return await job(controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  const get = async (url, signal, options = {}) => {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      ...options,
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`Air-quality field HTTP ${response.status}`),
        { status: response.status },
      );
    return response;
  };
  const notConfigured = () =>
    Object.assign(new Error('Model field not configured'), {
      code: 'not_configured',
    });
  const source = {
    /** The folder's manifest; a static folder holds one run, whatever `atMs`. */
    async getManifest({ signal } = {}) {
      return bounded(signal, async (active) => {
        let response;
        try {
          response = await get(`${base}/manifest`, active, {
            cache: 'no-store',
          });
        } catch (error) {
          // A server without the route has no field to give.
          if (error?.status === 404) throw notConfigured();
          throw error;
        }
        const body = await readResponseJsonCapped(
          response,
          MAX_MANIFEST_BYTES,
          active,
        );
        if (body?.unavailable === true) {
          if (body.code === 'not_configured') throw notConfigured();
          throw Object.assign(new Error('Model field unavailable'), {
            code: 'unavailable',
          });
        }
        manifest = readFieldManifest(body);
        return manifest;
      });
    },
    /** Every grid of `step`: global, and Europe where the manifest has it. */
    async getStep(step, { signal, run } = {}) {
      if (!manifest || (run && run !== manifest.run))
        await source.getManifest({ signal });
      const held = manifest;
      if (run && run !== held.run)
        throw new Error('Air-quality field run no longer available');
      if (!held.global.steps.includes(step))
        throw new Error('Air-quality field has no such step');
      const folder = String(step).padStart(3, '0');
      const query = `run=${encodeURIComponent(held.run)}`;
      return bounded(signal, async (active) => {
        const region = async (name, { width, height }) => {
          const bytes = width * height * 2;
          const grids = await Promise.all(
            FIELD_IDS.map(async (id) => {
              const response = await get(
                `${base}/grid/${name}/${folder}/${id}.u16?${query}`,
                active,
              );
              const body = await readResponseBytesCapped(
                response,
                bytes,
                active,
              );
              if (body.byteLength !== bytes)
                throw new Error('Malformed air-quality field');
              return [id, uint16Of(body)];
            }),
          );
          return Object.fromEntries(grids);
        };
        const inset = held.europe?.steps.includes(step) ? held.europe : null;
        const [global, europe] = await Promise.all([
          region('global', held.global),
          inset ? region('europe', inset) : null,
        ]);
        return { global, ...(europe ? { europe } : {}) };
      });
    },
  };
  return source;
}
