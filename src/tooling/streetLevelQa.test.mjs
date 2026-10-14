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
