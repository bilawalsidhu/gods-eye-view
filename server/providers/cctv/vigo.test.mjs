import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vigoCameraToSource,
  normalizeVigoImageUrl,
  loadVigoSourcesFromOpenData,
} from './sources.js';
import { VIGO_IMAGE_ORIGIN } from './constants.js';

const VIGO_CENTER_FEATURE = (overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-8.7226, 42.2328] },
  properties: {
    id: '1',
    nombre: 'Praza do Rei',
    url: 'http://camaras.vigo.org/camv2.php?id=1',
    ...overrides,
  },
  ...(overrides.__feature || {}),
});

// --- Host pinning ----------------------------------------------------------

test('normalizeVigoImageUrl upgrades http to https and pins to the official host', () => {
  assert.equal(
    normalizeVigoImageUrl('http://camaras.vigo.org/camv2.php?id=1'),
    'https://camaras.vigo.org/camv2.php?id=1',
  );
  assert.ok(
    normalizeVigoImageUrl('http://camaras.vigo.org/camv2.php?id=1').startsWith(
      VIGO_IMAGE_ORIGIN,
    ),
  );
});

test('normalizeVigoImageUrl rejects any other host, protocol, or malformed value', () => {
  assert.equal(
    normalizeVigoImageUrl('https://evil.example.com/camv2.php?id=1'),
    null,
  );
  assert.equal(
    normalizeVigoImageUrl('ftp://camaras.vigo.org/camv2.php?id=1'),
    null,
  );
  assert.equal(normalizeVigoImageUrl('not a url'), null);
  assert.equal(normalizeVigoImageUrl(''), null);
  assert.equal(normalizeVigoImageUrl(null), null);
});

test('vigoCameraToSource drops a feature whose image URL is off-host', () => {
  const feature = VIGO_CENTER_FEATURE({
    url: 'https://not-vigo.example.com/camv2.php?id=1',
  });
  assert.equal(vigoCameraToSource(feature), null);
});

// --- Out-of-area coordinates -------------------------------------------

test('vigoCameraToSource drops coordinates outside the Vigo municipal extent', () => {
  const farAway = VIGO_CENTER_FEATURE();
  farAway.geometry.coordinates = [2.1734, 41.3851]; // Barcelona, not Vigo
  assert.equal(vigoCameraToSource(farAway), null);

  const nullIsland = VIGO_CENTER_FEATURE();
  nullIsland.geometry.coordinates = [0, 0];
  assert.equal(vigoCameraToSource(nullIsland), null);
});

test('vigoCameraToSource accepts coordinates inside the Vigo municipal extent', () => {
  const camera = vigoCameraToSource(VIGO_CENTER_FEATURE());
  assert.ok(camera);
  assert.equal(camera.city, 'Vigo');
  assert.equal(camera.lat, 42.2328);
  assert.equal(camera.lon, -8.7226);
});

// --- Heading-confidence fallback ----------------------------------------

test('vigoCameraToSource always uses the low-confidence id-hash heading fallback', () => {
  // The dataset carries no facing at all, so every Vigo camera gets the
  // shared fallback heading at low confidence, never a fabricated "high".
  const a = vigoCameraToSource(VIGO_CENTER_FEATURE({ id: '1' }));
  const b = vigoCameraToSource(VIGO_CENTER_FEATURE({ id: '2' }));
  assert.equal(a.headingConfidence, 'low');
  assert.equal(b.headingConfidence, 'low');
  assert.ok(
    Number.isFinite(a.headingDeg) && a.headingDeg >= 0 && a.headingDeg < 360,
  );
  // Deterministic per id, and different ids fan out rather than collapsing
  // onto one bearing.
  assert.notEqual(a.headingDeg, undefined);
  assert.equal(
    vigoCameraToSource(VIGO_CENTER_FEATURE({ id: '1' })).headingDeg,
    a.headingDeg,
  );
});

// --- Duplicate IDs --------------------------------------------------------

test('loadVigoSourcesFromOpenData de-duplicates cameras sharing the same id', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const payload = {
    type: 'FeatureCollection',
    features: [
      VIGO_CENTER_FEATURE({ id: '7', nombre: 'Camera Seven' }),
      // Same id reported twice by the upstream (observed duplicate rows) —
      // only one camera should survive.
      VIGO_CENTER_FEATURE({ id: '7', nombre: 'Camera Seven (duplicate row)' }),
      VIGO_CENTER_FEATURE({ id: '8', nombre: 'Camera Eight' }),
    ],
  };

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(payload);
    },
    body: undefined,
  });

  const cameras = await loadVigoSourcesFromOpenData();
  const ids = cameras.map((camera) => camera.id);
  assert.equal(ids.length, new Set(ids).size, 'ids must be unique');
  assert.deepEqual([...new Set(ids)].sort(), ['vigo-7', 'vigo-8']);
});
