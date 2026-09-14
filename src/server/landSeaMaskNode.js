/**
 * @file Node-side loader for the bundled 2-bit land/sea mask asset.
 *
 * The same asset, the same codec, a different byte source. `data/landSeaMask.js`
 * is the BROWSER loader and fetches the Vite-emitted asset URL; this one reads
 * the committed file off disk for the dev/preview server's ocean-field tier
 * (`server/ocean/waterCells.js`) and for the unit tests that assert the
 * committed bytes.
 *
 * WHY THEY ARE SEPARATE FILES. They used to be one module branching on an
 * `isNode` check, with a dynamic `import('node:fs')` inside the branch. Vite
 * externalizes `node:*` for the browser and only WARNS, so that import survived
 * into the browser build; upstream removed the same pattern from two other data
 * modules in `6d83bb6` and fenced it off with `browserModuleBoundary.test.mjs`.
 * The import-attribute trick that fixed those two is for JSON and does not apply
 * to a binary asset, so the honest fix is one module per runtime over a shared
 * pure codec. Nothing under `src/data/` may import a Node builtin; `src/server/`
 * is reached only from `vite.config.js` and never from the browser entry, which
 * that guard now asserts in both directions.
 *
 * @module server/landSeaMaskNode
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createRetryableLoader } from '../data/retryableLoad.js';
import { decodeMaskBuffer } from '../data/landSeaMaskCodec.js';

export {
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
  MASK_WIDTH,
  MASK_HEIGHT,
  maskStateAt,
} from '../data/landSeaMaskCodec.js';

/** @const {URL} The committed asset, resolved relative to this module. */
export const MASK_FILE_URL = new URL('../data/local_data/gshhg_mask/land-sea-mask.bin', import.meta.url);

/** @returns {Promise<ArrayBuffer>} Raw asset bytes read from disk. */
async function readMaskBytes() {
  const bytes = await readFile(fileURLToPath(MASK_FILE_URL));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Load and decode the bundled land/sea mask under Node.
 *
 * Memoized on success for the process; failures back off per
 * `data/retryableLoad`, so a caller may retry. Shape-identical to the browser
 * loader's result, so `server/ocean/waterCells.js` and the tests consume one
 * mask type regardless of which runtime produced it.
 *
 * @type {() => Promise<{width: number, height: number, data: Uint8Array}>}
 */
export const loadLandSeaMaskNode = createRetryableLoader(
  async () => decodeMaskBuffer(await readMaskBytes()),
);
