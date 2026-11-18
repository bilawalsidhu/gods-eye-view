import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The NODE loader: this test runs under node:test and asserts the committed
// bytes. `data/landSeaMask.js` is the browser half and fetches an asset URL.
import {
  loadLandSeaMaskNode as loadLandSeaMask,
  maskStateAt,
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
} from '../../server/landSeaMask.js';

const ASSET_URL = new URL(
  './local_data/gshhg_mask/land-sea-mask.bin',
  import.meta.url,
);

test('the committed mask asset is byte-exact for the frozen layout', () => {
  // 16-byte header + 2880*1440/4 payload — a different size means the layout
  // (or resolution) changed and the provenance README + tests must move too.
  assert.equal(statSync(fileURLToPath(ASSET_URL)).size, 1_036_816);
  assert.equal(
    createHash('sha256').update(readFileSync(ASSET_URL)).digest('hex'),
    '38bc7dfb353c5dcd41261e3aed2435488f7e01d345432973d369c73e3e2f08db',
    'intentional regeneration must update the asset digest and provenance README',
  );
});

test('mask spot checks: continents, oceans, lakes, poles, and Catalina', async () => {
  const mask = await loadLandSeaMask();
  assert.equal(mask.width, 2880);
  assert.equal(mask.height, 1440);

  assert.equal(maskStateAt(mask, 39.74, -104.99), MASK_LAND, 'Denver is land');
  assert.equal(maskStateAt(mask, 0, -140), MASK_WATER, 'mid-Pacific is water');
  assert.equal(
    maskStateAt(mask, 44.0, -87.0),
    MASK_WATER,
    'Lake Michigan is water (L2 carve)',
  );
  assert.equal(
    maskStateAt(mask, -85, 90),
    MASK_LAND,
    'Antarctic interior is land (L5 + seam fill)',
  );
  assert.equal(
    maskStateAt(mask, -89.99, 0),
    MASK_LAND,
    'south polar row is land',
  );
  assert.equal(
    maskStateAt(mask, 89.9, 0),
    MASK_WATER,
    'Arctic ocean near the pole is water',
  );
  assert.equal(maskStateAt(mask, 66, 179.9), MASK_LAND, 'west of the dateline');
  assert.equal(
    maskStateAt(mask, 66, -179.9),
    MASK_LAND,
    'east of the dateline',
  );
  assert.equal(maskStateAt(mask, -17.8, 178), MASK_LAND, 'Viti Levu');
  assert.equal(maskStateAt(mask, 0, 180), MASK_WATER, 'equatorial dateline');
  const catalina = maskStateAt(mask, 33.38, -118.42);
  assert.ok(
    catalina === MASK_LAND || catalina === MASK_COASTAL,
    `Catalina Island cell is land or coastal (got ${catalina})`,
  );
  // Catalina's NE shore (lon −118.288 at this latitude) crosses the 1/8° cell
  // containing the San Pedro Channel seed, so the lookup returns coastal.
  assert.equal(
    maskStateAt(mask, 33.34, -118.33),
    MASK_COASTAL,
    'San Pedro Channel seed cell is coastal',
  );
  assert.equal(
    maskStateAt(mask, 33.0, -118.8),
    MASK_WATER,
    'open water SW of Catalina',
  );
});

test('mask global statistics stay in the plausible band', async () => {
  const mask = await loadLandSeaMask();
  const counts = [0, 0, 0, 0];
  const cells = mask.width * mask.height;
  // Land per row (a coastal cell counts half), weighted by the row's share of
  // the sphere: sin(north edge) - sin(south edge), equal for every column.
  let weightedLand = 0;
  let weight = 0;
  const rad = Math.PI / 180;
  for (let row = 0; row < mask.height; row += 1) {
    const south = -90 + (row * 180) / mask.height;
    const rowWeight =
      Math.sin((south + 180 / mask.height) * rad) - Math.sin(south * rad);
    let rowLand = 0;
    for (let col = 0; col < mask.width; col += 1) {
      const i = row * mask.width + col;
      const state = (mask.data[i >> 2] >> ((i & 3) * 2)) & 3;
      counts[state] += 1;
      if (state === MASK_LAND) rowLand += 1;
      else if (state === MASK_COASTAL) rowLand += 0.5;
    }
    weightedLand += rowWeight * rowLand;
    weight += rowWeight * mask.width;
  }
  assert.equal(counts[3], 0, 'reserved state never appears');
  assert.ok(counts[MASK_COASTAL] > 0, 'coastal cells exist');
  const landFraction = (counts[MASK_LAND] + counts[MASK_COASTAL] / 2) / cells;
  assert.ok(
    landFraction > 0.25 && landFraction < 0.35,
    `land fraction ${landFraction.toFixed(4)}`,
  );
  // By area the committed mask is 0.2867 land; the cell count above reads
  // 0.3356 because the polar rows, mostly Antarctica, are as many cells as
  // the equatorial ones. A leaked fill or an inverted level moves this far
  // outside the band.
  const landAreaFraction = weightedLand / weight;
  assert.ok(
    landAreaFraction > 0.27 && landAreaFraction < 0.31,
    `land fraction by area ${landAreaFraction.toFixed(4)}`,
  );
});

// The browser loader, under node:test with `fetch` replaced. Each case
// imports its own instance of the module, since the loader memoizes.
async function withFetch(stub, run) {
  const prior = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = prior;
  }
}

test('the browser loader rejects a response that is not OK and says its status', async () => {
  const browser = await import('./landSeaMask.js?case=not-ok');
  await withFetch(
    async () => ({ ok: false, status: 404 }),
    async () => {
      await assert.rejects(
        browser.loadLandSeaMask(),
        /land\/sea mask fetch failed: HTTP 404/,
      );
    },
  );
});

test('the browser loader decodes the committed bytes once and names no cache mode', async () => {
  const browser = await import('./landSeaMask.js?case=ok');
  const bytes = readFileSync(ASSET_URL);
  const calls = [];
  await withFetch(
    async (...args) => {
      calls.push(args);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      };
    },
    async () => {
      const mask = await browser.loadLandSeaMask();
      assert.equal(mask.width, 2880);
      assert.equal(mask.height, 1440);
      assert.equal(mask.data.byteLength, (2880 * 1440) / 4);
      assert.equal(
        browser.maskStateAt(mask, 39.74, -104.99),
        browser.MASK_LAND,
        'the same bytes the Node loader reads',
      );
      assert.equal(await browser.loadLandSeaMask(), mask, 'memoized');
    },
  );
  assert.equal(calls.length, 1, 'fetched once');
  const [url, init] = calls[0];
  assert.match(
    String(url),
    /\/src\/data\/local_data\/gshhg_mask\/land-sea-mask\.bin$/,
  );
  // `force-cache` would serve a stale mask from the dev server, whose URL
  // for the file is not content-hashed.
  assert.equal(init?.cache, undefined);
});
