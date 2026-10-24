import { readWindBody } from '../../sources/windBody.js';
import { parseAirTemperatureManifest } from './model.js';

/** Bounded same-origin acquisition; the binary is signed int16 LE, Celsius × 100. */
export function createAirTemperatureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 45_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Air temperature request timed out')),
        timeoutMs,
      );
      const active = controller.signal;
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/air-temperature/manifest', {
          signal: active,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok)
          throw new Error(`Air temperature HTTP ${response.status}`);
        const manifest = parseAirTemperatureManifest(
          JSON.parse(
            new TextDecoder().decode(
              await readWindBody(response, 16_384, active),
            ),
          ),
        );
        if (manifest.unavailable) return manifest;
        const count = manifest.grid.nx * manifest.grid.ny;
        const gridResponse = await fetchImpl(manifest.gridUrl, {
          signal: active,
          redirect: 'error',
        });
        if (!gridResponse.ok)
          throw new Error(`Air temperature HTTP ${gridResponse.status}`);
        const bytes = await readWindBody(gridResponse, count * 2, active);
        if (bytes.byteLength !== count * 2)
          throw new Error('Malformed air temperature grid');
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        const values = Float32Array.from(
          { length: count },
          (_, i) => view.getInt16(i * 2, true) * manifest.grid.scale,
        );
        return {
          ...manifest,
          scalar: {
            kind: 'temperature',
            units: manifest.units,
            level: manifest.level,
            values,
          },
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
