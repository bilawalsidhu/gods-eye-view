/**
 * @file Browser loader for the bundled 2-bit land/sea mask asset.
 *
 * ONE shared memoized instance serves both ocean click gating and the drift
 * beaching fallback — the decoded mask is never copied or transferred, so the
 * ~1 MB payload exists once per session. The asset is content-hashed by Vite,
 * so it is fetched with `force-cache`.
 *
 * BROWSER ONLY. The Node byte source lives in `server/landSeaMaskNode.js` over
 * the same pure codec. This module used to branch on an `isNode` check and pull
 * in the fs builtin dynamically inside that branch; Vite externalizes the Node
 * builtins for the browser and only warns, so that import reached the browser
 * build. Upstream removed the identical pattern from two other data modules in
 * `6d83bb6` and added `browserModuleBoundary.test.mjs` to keep it out.
 *
 * @module data/landSeaMask
 */

import { createRetryableLoader } from './retryableLoad.js';
import { decodeMaskBuffer } from './landSeaMaskCodec.js';

export {
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
  MASK_WIDTH,
  MASK_HEIGHT,
  maskStateAt,
} from './landSeaMaskCodec.js';

// Vite rewrites this to the emitted, content-hashed asset URL
// (assetsInclude: ['**/*.bin']).
const MASK_URL = new URL('./local_data/gshhg_mask/land-sea-mask.bin', import.meta.url);

/** @returns {Promise<ArrayBuffer>} Raw asset bytes. */
async function fetchMaskBytes() {
  const res = await fetch(MASK_URL, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`land/sea mask fetch failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Load and decode the bundled land/sea mask. Success is memoized for the
 * session; failures back off per data/retryableLoad, so callers may retry.
 *
 * @type {() => Promise<{width: number, height: number, data: Uint8Array}>}
 */
export const loadLandSeaMask = createRetryableLoader(
  async () => decodeMaskBuffer(await fetchMaskBytes()),
);
