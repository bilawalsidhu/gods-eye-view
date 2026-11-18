/**
 * @file Browser loader for the bundled 2-bit land/sea mask asset.
 *
 * One shared memoized instance is available to future browser consumers.
 * No application consumer is wired yet. The fetch follows ordinary HTTP
 * caching: a build's URL is content-hashed and cached as the server says,
 * while `vite dev` serves the file under its own unhashed name, where
 * `force-cache` would keep serving a mask that has since been regenerated.
 *
 * BROWSER ONLY. The Node byte source lives in `server/landSeaMask.js` over
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

// Vite rewrites this `new URL(..., import.meta.url)` form to the emitted,
// content-hashed asset URL.
const MASK_URL = new URL(
  './local_data/gshhg_mask/land-sea-mask.bin',
  import.meta.url,
);

/** @returns {Promise<ArrayBuffer>} Raw asset bytes. */
async function fetchMaskBytes() {
  const res = await fetch(MASK_URL);
  if (!res.ok)
    throw new Error(`land/sea mask fetch failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Load and decode the bundled land/sea mask. Success is memoized for the
 * session; failures back off per data/retryableLoad, so callers may retry.
 *
 * @type {() => Promise<{width: number, height: number, data: Uint8Array}>}
 */
export const loadLandSeaMask = createRetryableLoader(async () =>
  decodeMaskBuffer(await fetchMaskBytes()),
);
