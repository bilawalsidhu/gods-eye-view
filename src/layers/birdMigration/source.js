import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { isScanTime, parseManifest, parseMotion } from './wire.js';

/** Same-origin manifest and motion; the proxy may hold a motion request while it reduces. */
export function createBirdMigrationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  manifestTimeoutMs = 15_000,
  motionTimeoutMs = 40_000,
} = {}) {
  async function read(path, maxBytes, timeoutMs, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Bird migration request timed out')),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(path, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(`Bird migration HTTP ${response.status}`);
      return await readResponseJsonCapped(
        response,
        maxBytes,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async getManifest({ signal } = {}) {
      return parseManifest(
        await read(
          '/api/migration/manifest',
          16_384,
          manifestTimeoutMs,
          signal,
        ),
      );
    },
    async getMotion(time, { signal } = {}) {
      if (!isScanTime(time)) throw new TypeError('Invalid bird migration tick');
      return parseMotion(
        await read(
          `/api/migration/motion?time=${encodeURIComponent(time)}`,
          512 * 1024,
          motionTimeoutMs,
          signal,
        ),
        time,
      );
    },
  };
}
