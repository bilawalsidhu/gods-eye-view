import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import { requestWithDeadline } from '../../sources/requestDeadline.js';
import { FIELD_IDS, readFieldManifest } from './field.js';

// Failures stay English data for the console: the card says only that the
// model field is unavailable.

const MAX_MANIFEST_BYTES = 256 * 1024;
/** Transfer allowance at 1 Mbit/s, in bytes per millisecond. */
const MIN_STEP_BYTES_PER_MS = 125;

/**
 * The model field Core's own server serves from a local folder of baked
 * grids (`AIR_QUALITY_FIELD_DIR`, `server/providers/airQualityField.js`), as
 * a `fieldSource` (`field.js`). Unset, the server says the field is not
 * configured, this source rejects with `code: 'not_configured'`, and the
 * layer shows stations only. Same-origin, bounded and cancellable.
 * Steps get the base timeout plus time for their bytes at 1 Mbit/s.
 * @param {{fetchImpl?: typeof fetch, base?: string, timeoutMs?: number}} [options]
 */
export function createLocalAirQualityFieldSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/air-quality/field',
  timeoutMs = 45_000,
} = {}) {
  let manifest = null;
  let everRead = false;
  const get = async (url, signal, options = {}) => {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      ...options,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(
        new Error(`Air-quality field HTTP ${response.status}`),
        { status: response.status },
      );
    }
    return response;
  };
  const notConfigured = () =>
    Object.assign(new Error('Model field not configured'), {
      code: 'not_configured',
    });
  const source = {
    /**
     * The folder's manifest; a static folder holds one run, whatever `atMs`.
     * Before the first read a missing route or HTML page means no field.
     */
    async getManifest({ signal } = {}) {
      return requestWithDeadline(
        async (active) => {
          let body;
          try {
            const response = await get(`${base}/manifest`, active, {
              cache: 'no-store',
            });
            body = await readResponseJsonCapped(
              response,
              MAX_MANIFEST_BYTES,
              active,
            );
          } catch (error) {
            if (
              !everRead &&
              (error?.status === 404 || error instanceof SyntaxError)
            )
              throw notConfigured();
            throw error;
          }
          if (body?.unavailable === true) {
            if (body.code === 'not_configured') throw notConfigured();
            throw Object.assign(new Error('Model field unavailable'), {
              code: 'unavailable',
            });
          }
          manifest = readFieldManifest(body);
          everRead = true;
          return manifest;
        },
        { signal, timeoutMs },
      );
    },
    /** Every grid of `step`: global, and Europe where the manifest has it. */
    async getStep(step, { signal, run } = {}) {
      if (!manifest || (run && run !== manifest.run))
        await source.getManifest({ signal });
      const held = manifest;
      if (run && run !== held.run)
        throw Object.assign(
          new Error('Air-quality field run no longer available'),
          { code: 'run_changed' },
        );
      if (!held.global.steps.includes(step))
        throw new Error('Air-quality field has no such step');
      const inset = held.europe?.steps.includes(step) ? held.europe : null;
      const stepBytes =
        FIELD_IDS.length *
        2 *
        (held.global.width * held.global.height +
          (inset ? inset.width * inset.height : 0));
      const folder = String(step).padStart(3, '0');
      const query = `run=${encodeURIComponent(held.run)}`;
      return requestWithDeadline(
        async (active) => {
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
                // All supported clients read uint16 in the grid’s little-endian order.
                return [id, new Uint16Array(body.slice().buffer)];
              }),
            );
            return Object.fromEntries(grids);
          };
          try {
            const [global, europe] = await Promise.all([
              region('global', held.global),
              inset ? region('europe', inset) : null,
            ]);
            return { global, ...(europe ? { europe } : {}) };
          } catch (error) {
            if (error?.status !== 409) throw error;
            if (manifest === held) manifest = null;
            throw Object.assign(
              new Error('Air-quality field run no longer available'),
              { code: 'run_changed' },
            );
          }
        },
        { signal, timeoutMs: timeoutMs + stepBytes / MIN_STEP_BYTES_PER_MS },
      );
    },
  };
  return source;
}
