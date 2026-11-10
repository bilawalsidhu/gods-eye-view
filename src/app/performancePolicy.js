export const PERFORMANCE_STORAGE_KEY = 'gev:performance-mode:v1';

export function readPerformanceMode({
  search = globalThis.location?.search || '',
  storage,
} = {}) {
  const requested = new URLSearchParams(search).get('performance');
  if (requested === 'low' || requested === 'standard') return requested;
  try {
    return (storage ?? globalThis.localStorage)?.getItem(
      PERFORMANCE_STORAGE_KEY,
    ) === 'low'
      ? 'low'
      : 'standard';
  } catch {
    return 'standard';
  }
}

export const LOW_RESOURCE_BUDGET = Object.freeze({
  fps: 30,
  fleetIntervalMs: 100,
  resolutionScale: 0.6,
  overlayPixelRatio: 1,
  msaaSamples: 1,
  globeTiles: 24,
  globeError: 4,
  tileCacheBytes: 64 * 1024 * 1024,
  tileOverflowBytes: 16 * 1024 * 1024,
  tileError: 32,
});
