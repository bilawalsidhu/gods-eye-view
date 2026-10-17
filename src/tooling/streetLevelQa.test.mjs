import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
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
import {
  answerKartaViewRequest,
  describeKartaViewCall,
  KV_LINE,
  KV_OLD_STREET,
  KV_SEQUENCE_ID,
  kartaViewPhotos,
  resetKartaViewFixture,
} from '../../scripts/fixtures/street-level/kartaView.mjs';
import {
  maskedSegments,
  tileSegments,
} from '../layers/streetLevel/providers/kartaview/decode.js';
import { lonToTileX, latToTileY } from '../layers/streetLevel/tileMath.js';
import {
  normalizePhoto,
  resizedImageUrl,
} from '../layers/streetLevel/providers/kartaview/policy.js';

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

/* ── Header press-and-verify shared with the panel gate ───────────────── */

/**
 * A page stand-in that runs page functions in Node against a fake document.
 * The hit check always sees the header; `presses` says where each pointerdown
 * lands ('header', 'other', 'moved' or 'none').
 */
function fakePanelPage({ presses = [], floating = false, stuck = false } = {}) {
  const state = { floating, downs: 0, last: null, dragging: false, shift: 0 };
  const listeners = [];
  const node = (tagName, id, classes, inHeader) => ({
    tagName,
    id,
    classList: classes,
    closest: (selector) =>
      inHeader && selector.includes('.panel-header') ? {} : null,
  });
  const header = node('DIV', '', ['panel-title'], true);
  const other = node('SECTION', 'weather-panel', ['panel'], false);
  const rect = (left, top, width, height) => () => ({
    left,
    top,
    width,
    height,
  });
  const document = {
    querySelector: () => ({ getBoundingClientRect: rect(120, 210, 100, 20) }),
    getElementById: () => ({
      getBoundingClientRect: () => rect(100, 200 + state.shift, 300, 400)(),
      classList: {
        contains: (name) => name === 'panel-floating' && state.floating,
      },
    }),
    elementFromPoint: () => header,
  };
  const window = {
    addEventListener: (type, listener) => listeners.push(listener),
  };
  const inPage = (fn, ...args) => {
    const saved = { document: globalThis.document, window: globalThis.window };
    Object.assign(globalThis, { document, window });
    try {
      return fn(...args);
    } finally {
      Object.assign(globalThis, saved);
    }
  };
  const evaluate = async (fn, ...args) => inPage(fn, ...args);
  const press = () => {
    state.last = presses[state.downs++] ?? 'header';
    // 'none': the pointerdown never reaches the page.
    if (state.last === 'none') return;
    const target = state.last === 'header' ? header : other;
    // 'moved': the panel's layout shifted just before the press landed.
    if (state.last === 'moved') state.shift = -116;
    for (const listener of listeners.splice(0)) inPage(listener, { target });
    state.shift = 0;
  };
  return {
    state,
    evaluate,
    async waitForFunction(fn, options, ...args) {
      for (let i = 0; i < 3; i++) {
        if (await evaluate(fn, ...args)) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
    mouse: {
      async move() {},
      async down() {
        press();
        state.dragging = true;
      },
      async up() {
        if (state.dragging && state.last === 'header' && !stuck)
          state.floating = true;
        state.dragging = false;
      },
      async click(x, y, { clickCount }) {
        if (clickCount === 1) press();
        else if (state.last === 'header' && !stuck) state.floating = false;
      },
    },
  };
}

test('a header press is retried only when it provably missed the header', async () => {
  const { pressMissed } = await import('../../scripts/qa-panelDrag.mjs');
  assert.equal(pressMissed({ done: true, pressed: null }), false);
  assert.equal(
    pressMissed({ done: false, pressed: { inHeader: true } }),
    false,
  );
  assert.equal(
    pressMissed({ done: false, pressed: { inHeader: false } }),
    true,
  );
  // No recorded press is a failure, not a miss to retry.
  assert.equal(pressMissed({ done: false, pressed: null }), false);
});

test('a lift whose press the rail moved off the header is retried, then lifts', async () => {
  const { liftPanelByHeader, describePress } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ presses: ['other', 'header'] });
  const notes = [];
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: (line) => notes.push(line),
    pauseMs: 0,
  });
  assert.equal(attempt.done, true);
  assert.equal(page.state.downs, 2);
  assert.equal(notes.length, 2, 'a note and a GitHub warning');
  assert.match(notes[0], /missed the street-level-panel header/);
  assert.match(notes[0], /section#weather-panel\.panel/, 'names what it hit');
  assert.match(notes[0], /pre-press hit check passed/);
  assert.match(notes[0], /stillness (held|timed out)/);
  assert.match(
    notes[0],
    /panel box at hit check 100,200 300x400 -> at press 100,200 300x400/,
  );
  assert.match(notes[1], /^::warning title=Panel press retried::retry 1\/2/);
  assert.match(describePress(attempt), /in header: true, after 1 retry$/);
});

test('a press in the header that does not lift fails at once, naming the target', async () => {
  const { liftPanelByHeader, describePress } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ stuck: true });
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: () => assert.fail('no retry'),
    pauseMs: 0,
  });
  assert.equal(attempt.done, false);
  assert.equal(page.state.downs, 1);
  assert.match(describePress(attempt), /on div\.panel-title, in header: true/);
});

test('presses that keep missing stop after the retries and report the miss', async () => {
  const { liftPanelByHeader, PRESS_RETRIES } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ presses: ['other', 'other', 'other', 'other'] });
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: () => {},
    pauseMs: 0,
  });
  assert.equal(attempt.done, false);
  assert.equal(page.state.downs, PRESS_RETRIES + 1);
  assert.equal(attempt.pressed.inHeader, false);
});

test('a header double-click docks, waiting on the docked state', async () => {
  const { dockPanelByDoubleClick } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ floating: true, presses: ['other', 'header'] });
  const attempt = await dockPanelByDoubleClick(page, 'street-level-panel', {
    log: () => {},
    pauseMs: 0,
  });
  assert.equal(attempt.done, true);
  assert.equal(page.state.floating, false);
  assert.equal(page.state.downs, 2, 'the missed first press was retried');
});

test('both panel gates press the header through the shared helper', () => {
  for (const script of ['qa-street-level.mjs', 'qa-panel-resize.mjs']) {
    const source = fs.readFileSync(
      new URL(`../../scripts/${script}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /from '\.\/qa-panelDrag\.mjs'/, script);
    assert.match(source, /liftPanelByHeader\(page, PANEL_ID/, script);
    assert.match(source, /dockPanelByDoubleClick\(page, PANEL_ID/, script);
  }
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
    ['no Google 3D', 'no Google key', 'fixtures only'],
  );
  assert.deepEqual(
    strictViolations([
      { reason: 'no Google 3D', label: 'terrain' },
      { reason: 'no Google key', label: 'street view' },
      { reason: 'fixtures only', label: 'keyless page' },
      { reason: 'no Mapillary key', label: 'the keyed steps' },
      { reason: 'Google key refused', label: 'street view' },
    ]),
    [
      { reason: 'no Mapillary key', label: 'the keyed steps' },
      { reason: 'Google key refused', label: 'street view' },
    ],
  );
});

test('a press that records no pointerdown fails at once, without a retry', async () => {
  const { liftPanelByHeader, describePress } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ presses: ['none', 'header'] });
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: () => assert.fail('no retry'),
    pauseMs: 0,
  });
  assert.equal(attempt.done, false);
  assert.equal(attempt.pressed, null);
  assert.equal(page.state.downs, 1);
  assert.match(describePress(attempt), /no pointerdown reached the page/);
});

test('QA_FAIL_ON_RETRY turns a retry into a failure that says why', async () => {
  const { liftPanelByHeader, failOnRetryDefault } =
    await import('../../scripts/qa-panelDrag.mjs');
  assert.equal(failOnRetryDefault({ QA_FAIL_ON_RETRY: '1' }, []), true);
  assert.equal(failOnRetryDefault({}, ['--fail-on-retry']), true);
  assert.equal(failOnRetryDefault({}, []), false);
  const page = fakePanelPage({ presses: ['other', 'header'] });
  await assert.rejects(
    liftPanelByHeader(page, 'street-level-panel', {
      dx: -400,
      dy: 80,
      log: () => {},
      pauseMs: 0,
      failOnRetry: true,
    }),
    /QA_FAIL_ON_RETRY=1 .*missed the street-level-panel header.*pre-press hit check passed/,
  );
  assert.equal(page.state.downs, 1);
});

test('QA_FAIL_ON_RETRY retries, with a warning, a miss the panel moving explains', async () => {
  const { liftPanelByHeader, panelMoved } =
    await import('../../scripts/qa-panelDrag.mjs');
  assert.equal(panelMoved({ left: 0, top: 382 }, { left: 0, top: 266 }), true);
  assert.equal(panelMoved({ left: 0, top: 382 }, { left: 1, top: 383 }), false);
  const page = fakePanelPage({ presses: ['moved', 'header'] });
  const lines = [];
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: (line) => lines.push(line),
    pauseMs: 0,
    failOnRetry: true,
  });
  assert.equal(attempt.done, true, 'the second press lifted it');
  assert.equal(page.state.downs, 2);
  assert.ok(
    lines.some((line) =>
      /::warning title=Panel press retried::.*-> at press 100,84/.test(line),
    ),
    lines.join('\n'),
  );
});

test('both gates save failure evidence and fail on render-loop errors', () => {
  for (const script of ['qa-street-level.mjs', 'qa-panel-resize.mjs']) {
    const source = fs.readFileSync(
      new URL(`../../scripts/${script}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /saveFailureArtifacts\(/, script);
    assert.match(source, /hookRenderErrors\(/, script);
    assert.match(source, /readRenderErrors\(/, script);
    assert.match(source, /--fail-on-retry/, script);
  }
});

test('CI runs the gates hermetically against a production build, strict, with evidence', () => {
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
  assert.match(
    gate,
    /QA_FAIL_ON_RETRY: '1'/,
    'a missed header press fails CI now that the rail settles',
  );
});

test('KartaView fixtures draw the drive, answer nearest first, and refuse the storage host the API names', () => {
  const body = (answer) => JSON.parse(answer.body);
  const lat = (KV_LINE.south + KV_LINE.north) / 2;
  const x = lonToTileX(KV_LINE.lon, 14);
  const y = latToTileY(lat, 14);
  const tile = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/tiles/${x}/${y}/14.json`,
  });
  assert.equal(tile.known, true);
  assert.ok(body(tile).lines.length >= 1);
  const empty = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/tiles/${x + 3}/${y}/14.json`,
  });
  assert.deepEqual(body(empty).lines, []);
  const nearUrl = `https://api.kartaview.org/2.0/photo/?lat=${lat}&lng=${KV_LINE.lon + 0.0001}&zoomLevel=18&itemsPerPage=10`;
  resetKartaViewFixture();
  // The first lookup is rate-limited, readable cross-origin; the retry answers.
  const limited = answerKartaViewRequest({ method: 'GET', url: nearUrl });
  assert.equal(limited.status, 429);
  assert.equal(limited.known, true);
  assert.equal(limited.headers['Retry-After'], '0');
  assert.match(limited.headers['Access-Control-Expose-Headers'], /Retry-After/);
  const near = answerKartaViewRequest({ method: 'GET', url: nearUrl });
  assert.equal(near.status, 200);
  const records = body(near).result.data;
  assert.ok(records.length > 1);
  assert.ok(Number(records[0].distance) <= Number(records[1].distance));
  const photo = normalizePhoto(records[0]);
  assert.match(photo.urls.view, /^https:\/\/storage2\.openstreetcam\.org\//);
  assert.equal(
    answerKartaViewRequest({ method: 'GET', url: photo.urls.view }).known,
    true,
  );
  // Every odd photo is archived: its file answers 409, an even one the image.
  const photos = kartaViewPhotos();
  const storageAnswer = (index) =>
    answerKartaViewRequest({
      method: 'GET',
      url: normalizePhoto(
        body(
          answerKartaViewRequest({
            method: 'GET',
            url: `https://api.kartaview.org/2.0/photo/${photos[index].id}`,
          }),
        ).result.data,
      ).urls.view,
    });
  assert.equal(photos[3].archived, true);
  assert.equal(storageAnswer(3).status, 409);
  assert.equal(storageAnswer(3).known, true);
  assert.equal(photos[4].archived, false);
  assert.equal(storageAnswer(4).status, 200);
  assert.equal(storageAnswer(4).contentType, 'image/jpeg');
  // The image proxy still serves an archived photo: the 360° step opens one.
  const pano = photos.find((p) => p.isPano);
  assert.equal(pano.archived, true);
  const panoRecord = body(
    answerKartaViewRequest({
      method: 'GET',
      url: `https://api.kartaview.org/2.0/photo/${pano.id}`,
    }),
  ).result.data;
  assert.equal(
    answerKartaViewRequest({
      method: 'GET',
      url: resizedImageUrl(normalizePhoto(panoRecord).urls.pano, [1024, 512]),
    }).status,
    200,
  );
  assert.equal(
    answerKartaViewRequest({ method: 'GET', url: records[0].fileurlLTh }).known,
    false,
    'the storage1 address the API gives is not where the photo is',
  );
  const page = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/${KV_SEQUENCE_ID}/photos?page=1&itemsPerPage=1000`,
  });
  assert.equal(body(page).result.data.length, kartaViewPhotos().length);
  assert.ok(kartaViewPhotos().some((p) => p.isPano));
  assert.equal(
    describeKartaViewCall(
      'GET',
      new URL('https://api.kartaview.org/2.0/photo/77000001'),
    ),
    'GET api.kartaview.org/2.0/photo/{id}',
  );
});

test('Panoramax fixtures: two sequences on one street, searches honour sequence and filters, unknown calls are flagged', async () => {
  const {
    answerPanoramaxRequest,
    describePanoramaxCall,
    PNX_LINE,
    PNX_SEQUENCES,
    panoramaxHdDownloads,
    panoramaxPictures,
    panoramaxTile,
    resetPanoramaxFixture,
  } = await import('../../scripts/fixtures/street-level/panoramax.mjs');
  const { decodeCoverageTile, decodePictures } =
    await import('../layers/streetLevel/providers/panoramax/decode.js');
  const { normalizeItem } =
    await import('../layers/streetLevel/providers/panoramax/policy.js');
  resetPanoramaxFixture();
  const pictures = panoramaxPictures();
  assert.deepEqual(
    [...new Set(pictures.map((p) => p.sequenceId))],
    [...PNX_SEQUENCES],
  );
  assert.ok(pictures.some((p) => p.isPano));
  // Coverage: both lines in a z14 tile on the street; cones in z15.
  const z = 14;
  const x = lonToTileX((PNX_LINE.west + PNX_LINE.east) / 2, z);
  const y = latToTileY(PNX_LINE.lat, z);
  const lines = decodeCoverageTile(panoramaxTile(z, x, y), { x, y, z });
  assert.deepEqual(
    lines.sequences.map((s) => s.id).sort(),
    [...PNX_SEQUENCES].sort(),
  );
  const t15 = {
    x: lonToTileX(pictures[20].lon, 15),
    y: latToTileY(PNX_LINE.lat, 15),
    z: 15,
  };
  assert.ok(
    decodePictures(panoramaxTile(15, t15.x, t15.y), t15, PNX_SEQUENCES[0])
      .length > 0,
  );
  // A search for one sequence near the street gives only its pictures, nearest first.
  const at = pictures[30];
  const ask = (query) =>
    JSON.parse(
      answerPanoramaxRequest({
        method: 'GET',
        url: `https://api.panoramax.xyz/api/search?${query}`,
      }).body,
    ).features.map(normalizeItem);
  const own = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-50&limit=5&collections=${PNX_SEQUENCES[1]}`,
  );
  assert.ok(own.length > 0);
  assert.ok(own.every((p) => p.sequenceId === PNX_SEQUENCES[1]));
  assert.equal(own[0].nextId && typeof own[0].nextId, 'string');
  const panos = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-200&limit=50&filter=field_of_view%3D360`,
  );
  assert.ok(panos.length > 0 && panos.every((p) => p.isPano));
  assert.deepEqual(
    ask(
      `place_position=${at.lon},${at.lat}&place_distance=0-200&limit=50&datetime=2024-01-01T00:00:00.000Z/..`,
    ).every((p) => p.sequenceId === PNX_SEQUENCES[0]),
    true,
    'the second sequence is older',
  );
  // A box has every picture in it, those looking away included; a place
  // search leaves out pictures the point is behind (all look east).
  const d = 0.0002;
  const boxed = ask(
    `bbox=${at.lon - d},${at.lat - d},${at.lon + d},${at.lat + d}&limit=100`,
  );
  assert.ok(
    boxed.some((p) => p.lon < at.lon) && boxed.some((p) => p.lon > at.lon),
  );
  const placed = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-30&limit=50`,
  );
  assert.ok(placed.length > 0);
  assert.ok(
    placed.every((p) => p.lon <= at.lon + 1e-7),
    'none it is behind',
  );
  const one = ask(`ids=${at.id}&limit=1`);
  assert.equal(one[0].id, at.id);
  // Its pictures, and only those, are served; HD downloads are counted.
  const file = (name) =>
    answerPanoramaxRequest({
      method: 'GET',
      url: `https://panoramax.openstreetmap.fr/derivates/${name}`,
    });
  assert.equal(file(`${at.id}/sd.jpg`).status, 200);
  assert.equal(file(`${at.id}/hd.jpg`).status, 200);
  assert.equal(panoramaxHdDownloads(), 1);
  assert.equal(file('nope/sd.jpg').known, false);
  const unknown = answerPanoramaxRequest({
    method: 'GET',
    url: 'https://api.panoramax.xyz/api/collections/x/items',
  });
  assert.equal(unknown.known, false);
  assert.equal(
    describePanoramaxCall(
      'GET',
      new URL('https://api.panoramax.xyz/api/map/14/1/2.mvt'),
    ),
    'GET api.panoramax.xyz/api/map/{z}/{x}/{y}.mvt',
  );
});

/** The alpha of a fixture PNG (8-bit RGBA, unfiltered rows, as it writes them). */
function fixturePngAlpha(bytes) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const idat = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      alpha[y * width + x] = rows[y * (width * 4 + 1) + 1 + x * 4 + 3];
  return { width, height, alpha };
}

test('KartaView fixtures filter like KartaView: PNG tiles by view and upload date, the photo search by projection', () => {
  const body = (answer) => JSON.parse(answer.body);
  const z = 14;
  const x = lonToTileX(KV_LINE.lon, z);
  const y = latToTileY((KV_LINE.south + KV_LINE.north) / 2, z);
  assert.equal(x, lonToTileX(KV_OLD_STREET.lon, z), 'both streets in a tile');
  const base = `https://api.kartaview.org/2.0/sequence/tiles/${x}/${y}/${z}`;
  const segments = tileSegments(
    body(answerKartaViewRequest({ method: 'GET', url: `${base}.json` })),
  );
  const lons = (kept) => [...new Set(kept.map((segment) => segment[0][0]))];
  const keptFor = (query) => {
    const answer = answerKartaViewRequest({
      method: 'GET',
      url: `${base}.png?${query}`,
    });
    assert.equal(answer.contentType, 'image/png');
    assert.equal(answer.known, true);
    return lons(
      maskedSegments(segments, fixturePngAlpha(answer.body), { x, y, z }),
    );
  };
  assert.deepEqual(
    lons(segments).sort(),
    [KV_LINE.lon, KV_OLD_STREET.lon].sort(),
  );
  assert.deepEqual(keptFor('fieldOfView=360'), [KV_LINE.lon]);
  assert.deepEqual(keptFor('fieldOfView=plane').sort(), lons(segments).sort());
  const lastYear = new Date(Date.now() - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.deepEqual(keptFor(`startDate=${lastYear}`), [KV_LINE.lon]);
  assert.deepEqual(keptFor('startDate=2099-01-01'), []);
  assert.equal(
    describeKartaViewCall('GET', new URL(`${base}.png?fieldOfView=360`)),
    'GET api.kartaview.org/2.0/sequence/tiles/{x}/{y}/{z}.png?fieldOfView',
  );
  // The photo search: 360° only, and nothing uploaded after the drive.
  resetKartaViewFixture();
  const search = (extra) => {
    answerKartaViewRequest({
      method: 'GET',
      url: 'https://api.kartaview.org/2.0/photo/?lat=0&lng=0',
    });
    return body(
      answerKartaViewRequest({
        method: 'GET',
        url: `https://api.kartaview.org/2.0/photo/?lat=${KV_LINE.south + 0.002}&lng=${KV_LINE.lon}&zoomLevel=18&itemsPerPage=10${extra}`,
      }),
    ).result.data;
  };
  const panos = search('&projection=SPHERE');
  assert.ok(panos.length > 0);
  assert.ok(panos.every((record) => record.projection === 'SPHERE'));
  assert.deepEqual(search('&startDate=2099-01-01'), []);
});
