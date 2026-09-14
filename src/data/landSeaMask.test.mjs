import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The NODE loader: this test runs under node:test and asserts the committed
// bytes. `data/landSeaMask.js` is the browser half and fetches an asset URL.
import {
  loadLandSeaMaskNode as loadLandSeaMask,
  maskStateAt, MASK_WATER, MASK_LAND, MASK_COASTAL,
} from '../server/landSeaMaskNode.js';

const ASSET_URL = new URL('./local_data/gshhg_mask/land-sea-mask.bin', import.meta.url);

test('the committed mask asset is byte-exact for the frozen layout', () => {
  // 16-byte header + 2880*1440/4 payload — a different size means the layout
  // (or resolution) changed and the provenance README + tests must move too.
  assert.equal(statSync(fileURLToPath(ASSET_URL)).size, 1_036_816);
});

test('mask spot checks: continents, oceans, lakes, poles, and Catalina', async () => {
  const mask = await loadLandSeaMask();
  assert.equal(mask.width, 2880);
  assert.equal(mask.height, 1440);

  assert.equal(maskStateAt(mask, 39.74, -104.99), MASK_LAND, 'Denver is land');
  assert.equal(maskStateAt(mask, 0, -140), MASK_WATER, 'mid-Pacific is water');
  assert.equal(maskStateAt(mask, 44.0, -87.0), MASK_WATER, 'Lake Michigan is water (L2 carve)');
  assert.equal(maskStateAt(mask, -85, 90), MASK_LAND, 'Antarctic interior is land (L5 + seam fill)');
  assert.equal(maskStateAt(mask, -89.99, 0), MASK_LAND, 'south polar row is land');
  assert.equal(maskStateAt(mask, 89.9, 0), MASK_WATER, 'Arctic ocean near the pole is water');
  const catalina = maskStateAt(mask, 33.38, -118.42);
  assert.ok(
    catalina === MASK_LAND || catalina === MASK_COASTAL,
    `Catalina Island cell is land or coastal (got ${catalina})`,
  );
  // Catalina's NE shore (lon −118.288 at this latitude) crosses the 1/8° cell
  // containing the San Pedro Channel seed — coastal is the honest state, and
  // clicks there deliberately take the probe-fallback path.
  assert.equal(maskStateAt(mask, 33.34, -118.33), MASK_COASTAL, 'San Pedro Channel seed cell is coastal');
  assert.equal(maskStateAt(mask, 33.0, -118.8), MASK_WATER, 'open water SW of Catalina');
});

test('mask global statistics stay in the plausible band', async () => {
  const mask = await loadLandSeaMask();
  const counts = [0, 0, 0, 0];
  const cells = mask.width * mask.height;
  for (let i = 0; i < cells; i += 1) {
    counts[(mask.data[i >> 2] >> ((i & 3) * 2)) & 3] += 1;
  }
  assert.equal(counts[3], 0, 'reserved state never appears');
  assert.ok(counts[MASK_COASTAL] > 0, 'coastal cells exist');
  const landFraction = (counts[MASK_LAND] + counts[MASK_COASTAL] / 2) / cells;
  assert.ok(landFraction > 0.25 && landFraction < 0.35, `land fraction ${landFraction.toFixed(4)}`);
});
