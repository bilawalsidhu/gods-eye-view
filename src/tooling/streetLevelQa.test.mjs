import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createApplicationStreetLevel } from '../app/layers/streetLevel.js';
import {
  fixtureTile,
  EXPECTED_PROVIDERS,
  isCollapsed,
  PARK,
  STRICT_ALLOWED_SKIPS,
  strictViolations,
} from '../../scripts/qa-street-level.mjs';
import {
  answerMapillaryRequest,
  describeCall,
  metresApart,
  PHOTO_LINE,
  PHOTO_SEQUENCE_ID,
  photoImages,
  THUMB_HOST,
} from '../../scripts/fixtures/street-level/mapillaryGraph.mjs';
import { redact } from '../../scripts/qa-browserEvidence.mjs';

// The press helpers wait for paint; Node has no frames, so a tick stands in.
globalThis.requestAnimationFrame ??= (callback) =>
  setTimeout(() => callback(Date.now()), 0);

test('the harness expects exactly the providers the app registers, in chip order', () => {
  // Any method a provider asks its source for is a no-op: only ids matter.
  const source = new Proxy({}, { get: () => () => {} });
  const layer = createApplicationStreetLevel({
    surface: null,
    sources: { mapillary: source },
  });
  assert.deepEqual([...EXPECTED_PROVIDERS], [...layer.providerIds]);
});

test('a panel reads as collapsed only with the collapsed class', () => {
  assert.equal(isCollapsed(['panel-collapsible', 'collapsed']), true);
  assert.equal(isCollapsed(['panel-collapsible']), false);
});

test('the harness only runs its browser flow when executed directly', () => {
  const source = fs.readFileSync(
    new URL('../../scripts/qa-street-level.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
  );
  assert.match(source, /PUPPETEER_EXECUTABLE_PATH/);
  assert.match(source, /--url/);
});

test('fixture tiles give the hermetic gate something real to filter', async () => {
  const { decodeCoverageTile } =
    await import('../layers/streetLevel/providers/mapillary/decode.js');
  const now = Date.UTC(2026, 9, 1);
  const street = decodeCoverageTile(fixtureTile(14, 2662, 6286, now), {
    x: 2662,
    y: 6286,
    z: 14,
  });
  const grid = street.sequences.filter((s) => s.id !== PHOTO_SEQUENCE_ID);
  assert.equal(grid.length, 8);
  const pano = grid.filter((s) => s.isPano).length;
  assert.ok(pano > 0 && pano < 8, '360° and flat both present');
  const year = 365 * 86_400_000;
  const old = grid.filter((s) => now - s.capturedAt > year).length;
  assert.ok(old > 0 && old < 8, 'recent and older both present');
  const orbit = decodeCoverageTile(fixtureTile(3, 1, 3, now), {
    x: 1,
    y: 3,
    z: 3,
  });
  assert.ok(orbit.overview.length > 0, 'overview points from orbit');
  assert.equal(fixtureTile(8, 1, 1, now).length, 0, 'nothing in between');
});

/* ── The real status route probe ─────────────────────────────────────── */

test('the gate requires the server’s real Mapillary status route', async () => {
  const { assertRealStatusRoute } =
    await import('../../scripts/qa-street-level.mjs');
  const asked = [];
  const answer = (body, init) => async (url) => {
    asked.push(url);
    return typeof body === 'string'
      ? new Response(body, init)
      : Response.json(body, init);
  };
  assert.deepEqual(
    await assertRealStatusRoute(
      'http://localhost:4173',
      answer({ configured: false }),
    ),
    { configured: false },
  );
  assert.deepEqual(asked, ['http://localhost:4173/api/mapillary/status']);
  for (const [why, fetchImpl] of [
    [
      'an unregistered route (the API 404)',
      answer({ error: 'Unknown API route' }, { status: 404 }),
    ],
    [
      'the SPA fallback',
      answer('<!doctype html><title>GEV</title>', {
        headers: { 'content-type': 'text/html' },
      }),
    ],
    ['a malformed status', answer({ configured: 'yes' })],
    [
      'an unreachable server',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])
    await assert.rejects(
      assertRealStatusRoute('http://localhost:4173', fetchImpl),
      /api\/mapillary\/status/,
      why,
    );
});

/* ── Hermetic photo flow: the photo line and the Graph fixtures ────────── */

test('the photo sequence runs through the parked view, clipped to each tile it crosses', async () => {
  const { decodeCoverageTile } =
    await import('../layers/streetLevel/providers/mapillary/decode.js');
  const { lonToTileX, latToTileY } =
    await import('../layers/streetLevel/tileMath.js');
  const x = lonToTileX(PHOTO_LINE.lon, 14);
  const rows = new Set(
    [PHOTO_LINE.south, PHOTO_LINE.north].map((lat) => latToTileY(lat, 14)),
  );
  assert.ok(rows.size > 1, 'the line crosses a tile edge');
  let south = Infinity;
  let north = -Infinity;
  for (const y of rows) {
    const line = decodeCoverageTile(fixtureTile(14, x, y), {
      x,
      y,
      z: 14,
    }).sequences.find((s) => s.id === PHOTO_SEQUENCE_ID);
    assert.ok(line, `tile 14/${x}/${y} carries the photo line`);
    for (const [lon, lat] of line.parts[0]) {
      assert.ok(Math.abs(lon - PHOTO_LINE.lon) < 1e-4);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  assert.ok(Math.abs(south - PHOTO_LINE.south) < 1e-4);
  assert.ok(Math.abs(north - PHOTO_LINE.north) < 1e-4);
  // Far away there is no photo line, only the grid.
  const elsewhere = decodeCoverageTile(fixtureTile(14, 100, 100), {
    x: 100,
    y: 100,
    z: 14,
  });
  assert.equal(
    elsewhere.sequences.some((s) => s.id === PHOTO_SEQUENCE_ID),
    false,
  );
  // The parked camera looks down onto the line.
  assert.equal(PARK.lon, PHOTO_LINE.lon);
  assert.ok(PARK.lat > PHOTO_LINE.south && PARK.lat < PHOTO_LINE.north);
});

test('the fixture photos: one sequence, 360° and flat, close enough for any nearest lookup on the line', () => {
  const images = photoImages(Date.UTC(2026, 9, 1));
  assert.ok(images.length >= 3);
  assert.ok(images.some((image) => image.isPano));
  assert.ok(images.some((image) => !image.isPano));
  for (let i = 1; i < images.length; i++) {
    const gap = metresApart(images[i - 1], images[i]);
    // Above the cones' 3 m thinning, and at most 50 m apart: any point on
    // the line has a photo within the Graph API's 50 m radius.
    assert.ok(gap > 3 && gap < 50, `gap ${gap}`);
  }
  assert.equal(new Set(images.map((image) => image.id)).size, images.length);
});

const graph = (path, params) =>
  `https://graph.mapillary.com/${path}?${new URLSearchParams({ access_token: 'MLY|0|qa-fixture', ...params })}`;
const answer = (url, method = 'GET') => {
  const out = answerMapillaryRequest({ method, url });
  return {
    ...out,
    json: out.contentType === 'application/json' ? JSON.parse(out.body) : null,
  };
};

test('the Graph fixtures answer the provider’s nearest and sequence lookups', () => {
  const images = photoImages();
  const middle = images[Math.floor(images.length / 2)];
  const near = answer(
    graph('images', {
      lat: String(middle.lat + 0.0001),
      lng: String(middle.lon),
      radius: '50',
      limit: '8',
      fields: 'id,geometry,is_pano,captured_at,sequence',
    }),
  );
  assert.equal(near.status, 200);
  assert.ok(near.json.data.length > 0);
  assert.ok(near.json.data.some((record) => record.id === middle.id));
  for (const record of near.json.data) {
    assert.deepEqual(Object.keys(record).sort(), [
      'captured_at',
      'geometry',
      'id',
      'is_pano',
      'sequence',
    ]);
    assert.equal(record.sequence, PHOTO_SEQUENCE_ID);
  }
  const far = answer(
    graph('images', { lat: '0', lng: '0', radius: '50', fields: 'id' }),
  );
  assert.deepEqual(far.json.data, [], 'nothing outside the radius');
  const sequence = answer(
    graph('images', {
      sequence_ids: PHOTO_SEQUENCE_ID,
      fields: 'id,geometry,compass_angle,captured_at,is_pano',
      limit: '2000',
    }),
  );
  assert.equal(sequence.json.data.length, images.length);
  assert.deepEqual(
    answer(graph('images', { sequence_ids: 'other', fields: 'id' })).json.data,
    [],
  );
});

test('the Graph fixtures answer every call MapillaryJS makes to open a photo', () => {
  const [first, second] = photoImages();
  const spatial = answer(
    graph('images', {
      image_ids: `${first.id},${second.id}`,
      fields:
        'id,computed_geometry,geometry,sequence,camera_type,computed_rotation,thumb_1024_url,thumb_2048_url,width,height,merge_cc,sfm_cluster,mesh,creator,captured_at',
    }),
  );
  assert.equal(spatial.status, 200);
  assert.equal(spatial.headers['Access-Control-Allow-Origin'], '*');
  const [pano, flat] = spatial.json.data;
  assert.equal(pano.camera_type, 'spherical');
  assert.equal(flat.camera_type, 'perspective');
  assert.equal(pano.merge_cc, null, 'unmerged: no mesh request');
  assert.equal(pano.sfm_cluster, null, 'no cluster request');
  assert.equal(pano.computed_rotation.length, 3);
  assert.equal(new URL(pano.thumb_2048_url).hostname, THUMB_HOST);
  assert.equal(
    answer(graph('images', { s2: '9749618446378729472', fields: 'id' })).json
      .data.length,
    0,
  );
  assert.deepEqual(
    answer(graph('image_ids', { sequence_id: PHOTO_SEQUENCE_ID })).json.data[0],
    { id: first.id },
  );
  assert.deepEqual(
    answer(graph(`${first.id}/tiles`, { z: '11', fields: 'url,z,x,y' })).json,
    { data: [] },
  );
  const photo = answer(pano.thumb_2048_url);
  assert.equal(photo.status, 200);
  assert.equal(photo.contentType, 'image/jpeg');
  assert.deepEqual([...photo.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const preflight = answer(graph('images', { image_ids: first.id }), 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers['Access-Control-Allow-Headers'],
    /Authorization/,
  );
});

test('a Mapillary call no fixture covers is answered but flagged unknown', () => {
  for (const url of [
    graph('images', { bbox: '0,0,1,1' }),
    graph('map_features', { fields: 'id' }),
    'https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/1/1',
  ]) {
    const out = answer(url);
    assert.equal(out.known, false, url);
    assert.ok(out.status >= 400);
  }
});

test('answered calls are named without the token', () => {
  const call = describeCall(
    'GET',
    new URL(graph('9100000000000/tiles', { z: '11', fields: 'url' })),
  );
  assert.equal(call, 'GET graph.mapillary.com/{imageId}/tiles?fields&z');
  assert.doesNotMatch(call, /MLY|access_token/);
  assert.equal(
    describeCall(
      'GET',
      new URL('https://qa-fixture.mapillary.com/thumb/9100000000016.jpg'),
    ),
    'GET qa-fixture.mapillary.com/thumb/{imageId}.jpg',
  );
});

test('evidence never carries a Mapillary token', () => {
  assert.equal(
    redact(
      'GET https://graph.mapillary.com/images?access_token=MLY|123|abc&fields=id',
    ),
    'GET https://graph.mapillary.com/images?access_token=REDACTED&fields=id',
  );
  assert.equal(
    redact('token MLY|123|abc in a log'),
    'token MLY|REDACTED in a log',
  );
  assert.equal(
    redact(
      'https://tile.googleapis.com/v1/3dtiles/x.glb?session=s1&key=AIzaSyBexampleexampleexampleexample00',
    ),
    'https://tile.googleapis.com/v1/3dtiles/x.glb?session=s1&key=REDACTED',
  );
  assert.equal(
    redact('loaded with AIzaSyBexampleexampleexampleexample00 inline'),
    'loaded with AIza…REDACTED inline',
  );
});

test('--strict accepts only the documented skips', () => {
  assert.deepEqual(
    [...STRICT_ALLOWED_SKIPS],
    ['no Google 3D', 'fixtures only'],
  );
  assert.deepEqual(
    strictViolations([
      { reason: 'no Google 3D', label: 'terrain' },
      { reason: 'fixtures only', label: 'keyless page' },
      { reason: 'no Mapillary key', label: 'the keyed steps' },
    ]),
    [{ reason: 'no Mapillary key', label: 'the keyed steps' }],
  );
});

test('the gate saves failure evidence and fails on render-loop errors', () => {
  const source = fs.readFileSync(
    new URL('../../scripts/qa-street-level.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /saveFailureArtifacts\(/);
  assert.match(source, /hookRenderErrors\(/);
  assert.match(source, /readRenderErrors\(/);
});

test('CI runs the gate hermetically against a production build, strict, with evidence', () => {
  const ci = fs.readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const job = ci.slice(ci.indexOf('street-level-browser:'));
  const gate = job.slice(0, job.indexOf('\n  windows-onboarding:'));
  // The dummy token is baked into the bundle at build time and the preview
  // server's status route reads it at run time: both steps carry it.
  assert.match(
    gate,
    /MAPILLARY_CLIENT_TOKEN: 'MLY\|0\|qa-fixture'\s+run: npm run build/,
  );
  assert.match(
    gate,
    /MAPILLARY_CLIENT_TOKEN: 'MLY\|0\|qa-fixture'\s+run: \|\s+npx vite preview --port 4173 --strictPort/,
  );
  assert.doesNotMatch(gate, /npx vite --port/);
  assert.equal(
    (gate.match(/MAPILLARY_CLIENT_TOKEN: 'MLY\|0\|qa-fixture'/g) || []).length,
    2,
  );
  assert.match(gate, /qa:street-level:fixtures -- --strict/);
  assert.match(
    gate,
    /if: failure\(\)[\s\S]*actions\/upload-artifact@[0-9a-f]{40}/,
  );
  assert.match(gate, /path: qa-artifacts\//);
});
