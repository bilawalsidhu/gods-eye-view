import { readWindBody } from '../../sources/windBody.js';
import { decodeFieldGrid } from '../wind/fieldDecode.js';

export const OCEAN_GRID_URL =
  /^\/api\/ocean\/currents\/grid\/currents-[\w.,-]+\.bin$/;
const GLOBAL_BOX = { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 };

/** The grid must start within a cell of the box's west and north edges and span it. */
function consistent(grid, bbox) {
  const lonSpan = (((bbox.lonMax - bbox.lonMin) % 360) + 360) % 360 || 360;
  const lonStart = (((grid.lo1 - bbox.lonMin) % 360) + 360) % 360;
  return (
    Math.min(lonStart, 360 - lonStart) <= grid.dx + 1e-9 &&
    Math.abs(grid.la1 - bbox.latMax) <= grid.dy + 1e-9 &&
    Math.abs(grid.nx * grid.dx - lonSpan) <= grid.dx + 1e-9 &&
    Math.abs((grid.ny - 1) * grid.dy - (bbox.latMax - bbox.latMin)) <=
      grid.dy + 1e-9
  );
}

/** Create a bounded, cancellable source for the same-origin ocean-current provider. */
export function createOceanCurrentsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  // A cold globe build can take a minute server-side; outlast it.
  timeoutMs = 90_000,
} = {}) {
  return {
    async getSnapshot({ signal, box = null } = {}) {
      const request = box ?? GLOBAL_BOX;
      const query = `latMin=${request.latMin}&latMax=${request.latMax}&lonMin=${request.lonMin}&lonMax=${request.lonMax}`;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Ocean current request timed out')),
        timeoutMs,
      );
      const active = controller.signal;
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(
          `/api/ocean/currents/manifest?${query}`,
          { signal: active, cache: 'no-store', redirect: 'error' },
        );
        if (!response.ok)
          throw new Error(`Ocean current HTTP ${response.status}`);
        const manifest = JSON.parse(
          new TextDecoder().decode(
            await readWindBody(response, 16_384, active),
          ),
        );
        if (manifest?.unavailable) return manifest;
        const grid = manifest?.grid;
        const bbox = manifest?.bbox;
        if (
          manifest?.field !== 'ocean-currents' ||
          !['global', 'regional'].includes(manifest.tier) ||
          !grid ||
          !Number.isInteger(grid.nx) ||
          !Number.isInteger(grid.ny) ||
          grid.nx < 1 ||
          grid.ny < 1 ||
          grid.nx * grid.ny > 1_000_000 ||
          ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
          grid.dx <= 0 ||
          grid.dy <= 0 ||
          !bbox ||
          ![bbox.latMin, bbox.latMax, bbox.lonMin, bbox.lonMax].every(
            Number.isFinite,
          ) ||
          !consistent(grid, bbox) ||
          !Number.isFinite(manifest.noData) ||
          !manifest.speed ||
          ![manifest.speed.medianMs, manifest.speed.p95Ms].every(
            Number.isFinite,
          ) ||
          !OCEAN_GRID_URL.test(manifest.gridUrl)
        )
          throw new Error('Malformed ocean current manifest');
        const expectedBytes = grid.nx * grid.ny * 8;
        const gridResponse = await fetchImpl(manifest.gridUrl, {
          signal: active,
          redirect: 'error',
        });
        if (!gridResponse.ok)
          throw new Error(`Ocean current HTTP ${gridResponse.status}`);
        const bytes = await readWindBody(gridResponse, expectedBytes, active);
        if (bytes.byteLength !== expectedBytes)
          throw new Error('Malformed ocean current grid');
        const [u, v] = decodeFieldGrid(grid, bytes);
        return { ...manifest, u, v };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
