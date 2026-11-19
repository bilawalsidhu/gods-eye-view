import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  DEFAULT_ICELAND_MAX_SOURCES,
  ICELAND_CAMERAS_URL,
  ICELAND_IMAGE_ORIGIN,
  ICELAND_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import { fetchWithinHost } from '../../server/providers/cctv/media.js';
import { isLikelyIcelandCoordinate } from '../../server/providers/cctv/normalize.js';
import {
  icelandCameraToSource,
  icelandHeadingFromDescription,
  loadIcelandSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** One row shaped like the live `vefmyndavelar2014_1` payload. */
const row = (over = {}) => ({
  Maelist_nr: 7001,
  Myndavel: 'Hellisheiði',
  Vegheiti: 'Hringvegur',
  NrVegur: '1',
  Skyring: 'Hellisheiði séð til vesturs',
  Slod: `${ICELAND_IMAGE_ORIGIN}hellisheidi_1.jpg`,
  PntX: 395000,
  PntY: 390000,
  Breidd: 64.0136,
  Lengd: -21.4,
  ...over,
});

/** A live response body plus a flag that flips when the stream is cancelled. */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('an Iceland row maps to a source on the pinned frame directory', () => {
  const source = icelandCameraToSource(row());
  assert.equal(source.id, 'is-vegagerdin-hellisheidi_1');
  assert.equal(source.name, 'Hellisheiði séð til vesturs');
  assert.equal(source.city, 'Iceland');
  assert.equal(source.cityId, 'iceland');
  assert.equal(source.provider, 'Vegagerðin (IRCA)');
  assert.equal(source.lat, 64.0136);
  assert.equal(source.lon, -21.4);
  assert.equal(source.headingDeg, 270);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.pitchDeg, -24);
  assert.equal(source.fovDeg, 56);
  assert.equal(source.rangeM, 210);
  assert.equal(source.mountHeightM, 10);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'iceland-vegagerdin');
  assert.equal(source.code, 'HELLISHEIÐI');
  assert.match(source.license, /CC BY 4\.0/);
  assert.ok(source.url.startsWith(ICELAND_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
});

test('a view that states no facing takes the low-confidence id-hash pose', () => {
  const source = icelandCameraToSource(
    row({
      Skyring: 'Hellisheiði séð niður á veg',
      Slod: `${ICELAND_IMAGE_ORIGIN}hellisheidi_2.jpg`,
    }),
  );
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.headingDeg % 22.5, 0);
  assert.equal(
    source.headingDeg,
    icelandCameraToSource(
      row({ Slod: `${ICELAND_IMAGE_ORIGIN}hellisheidi_2.jpg` }),
    ).headingDeg,
    'the fallback depends on the id, not on the text',
  );
});

test('the label collapses the feed’s doubled spaces and repeated words', () => {
  assert.equal(
    icelandCameraToSource(
      row({ Skyring: 'Strandarheiði séð niður á veg til  til austurs' }),
    ).name,
    'Strandarheiði séð niður á veg til austurs',
  );
  const label = (Skyring) => icelandCameraToSource(row({ Skyring })).name;
  // Repeats of words with Icelandic letters collapse too.
  assert.equal(
    label('Hellisheiði séð séð til austurs'),
    'Hellisheiði séð til austurs',
  );
  assert.equal(label('Brú á á Jökulsá'), 'Brú á Jökulsá');
  // A word ending in a letter the next word starts with is not a repeat.
  for (const text of [
    'Þverá Árnessýslu',
    'brú Úlfarsá',
    'Vesturlandsvegur við Elliðaá Ártúnsbrekku',
  ])
    assert.equal(label(text), text);
});

test('a row with no label, station or station number is named by its frame', () => {
  const source = icelandCameraToSource(
    row({ Skyring: '', Myndavel: '', Maelist_nr: undefined }),
  );
  assert.equal(source.name, 'Vegagerðin hellisheidi_1');
});

test('only an explicit facing sets a heading', () => {
  const cases = [
    ['Hellisheiði séð til vesturs', 270],
    ['Holtavörðuheiði til norðurs', 0],
    ['Klettsháls í suður', 180],
    ['Arnarneshæð séð austur', 90],
    ['Bústaðabrú séð norður Kringlumýrarbraut', 0],
    ['Staður séð til norðausturs', 45],
    ['Staður séð til suðausturs', 135],
    ['Staður séð í suðvestur', 225],
    ['Staður séð til norðvesturs', 315],
    ['STAÐUR SÉÐ TIL VESTURS', 270],
    ['Brú séð til austurs og Selfoss', 90], // "og" then a place, not a facing
    ['Staður séð til austurs og Vesturlandsvegur', 90],
  ];
  for (const [text, heading] of cases) {
    assert.equal(icelandHeadingFromDescription(text), heading, text);
  }
  for (const text of [
    '',
    null,
    'Gautsdalur niður á veg',
    'Miklabraut austur', // a road direction, not a facing
    'Biskupsháls - norður',
    'Hringtorg norðan Selfoss',
    'Norðurárdalur niður á veg', // a place name that contains a cardinal
    'Staður séð til suðurlands', // a longer word, not "suður"
    'Staður séð til norðurs og til suðurs', // two facings: ambiguous
    'Staður séð til austurs og vesturs', // the second facing shares "til"
    'Staður séð í norður og suður',
    'Staður séð í norður og í suður',
    'Norðfjarðargöng séð til Eskifjarðar',
  ]) {
    assert.ok(Number.isNaN(icelandHeadingFromDescription(text)), String(text));
  }
});

test('rows off the pinned directory, or with unusable frames or places, are dropped', () => {
  const bad = [
    { Slod: 'https://example.com/vgdata/vefmyndavelar/a_1.jpg' },
    { Slod: 'http://www.vegagerdin.is/vgdata/vefmyndavelar/a_1.jpg' },
    { Slod: 'https://user:pw@www.vegagerdin.is/vgdata/vefmyndavelar/a_1.jpg' },
    { Slod: 'https://www.vegagerdin.is:8443/vgdata/vefmyndavelar/a_1.jpg' },
    { Slod: 'https://www.vegagerdin.is/vgdata/other/a_1.jpg' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/../x/a_1.jpg' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/a%2Fb_1.jpg' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/a_1.php' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/a_1' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/' },
    { Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/a b_1.jpg' },
    { Slod: '' },
    { Slod: null },
    { Breidd: 0, Lengd: 0 },
    { Breidd: null, Lengd: null },
    { Breidd: '64.01', Lengd: '-21.4' },
    { Breidd: '64.01' }, // each coordinate must be a number on its own
    { Lengd: '-21.4' },
    { Breidd: 59.9, Lengd: 10.7 }, // Oslo
    { Breidd: 64.01, Lengd: 21.4 }, // wrong hemisphere
  ];
  for (const over of bad) {
    assert.equal(icelandCameraToSource(row(over)), null, JSON.stringify(over));
  }
  assert.equal(icelandCameraToSource(null), null);
  assert.equal(icelandCameraToSource({}), null);
  assert.equal(isLikelyIcelandCoordinate(64.1466, -21.9426), true);
  assert.equal(isLikelyIcelandCoordinate(66.3, -14.0), true);
});

test('the Iceland loader reads the list with redirects refused and keeps the nearest cameras', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  withEnv(t, { CCTV_ICELAND_MAX_SOURCES: '8' });
  const rows = Array.from({ length: 12 }, (_, i) =>
    row({
      Maelist_nr: 8000 + i,
      Slod: `${ICELAND_IMAGE_ORIGIN}far_${i}.jpg`,
      Skyring: `Far ${i}`,
      Breidd: 66.2,
      Lengd: -15.9 + i * 0.01,
    }),
  );
  // Reykjavík cameras come last in the feed but first in the priority order.
  // A frame the feed repeats keeps its last row, as the other packs do.
  rows.push(row({ Slod: `${ICELAND_IMAGE_ORIGIN}rvk_1.jpg`, Skyring: 'Old' }));
  rows.push(
    row({
      Slod: `${ICELAND_IMAGE_ORIGIN}rvk_1.jpg`,
      Skyring: 'Kringlumýrarbraut',
      Breidd: 64.1466,
      Lengd: -21.9426,
    }),
  );
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return json(rows);
  });
  const sources = await loadIcelandSourcesFromOpenData();
  assert.deepEqual(seen, [[ICELAND_CAMERAS_URL, 'manual']]);
  assert.equal(sources.length, 8);
  assert.equal(sources[0].id, 'is-vegagerdin-rvk_1');
  assert.equal(sources[0].name, 'Kringlumýrarbraut');
  assert.equal(sources[0].lat, 64.1466);
  assert.equal(
    new Set(sources.map((s) => s.id)).size,
    sources.length,
    'a frame the feed repeats collapses to one camera',
  );
  assert.equal(sources.available, 13);
});

test('the default Iceland cap is DEFAULT_ICELAND_MAX_SOURCES', async (t) => {
  t.mock.method(console, 'log', () => {});
  withEnv(t, { CCTV_ICELAND_MAX_SOURCES: undefined });
  const rows = Array.from(
    { length: DEFAULT_ICELAND_MAX_SOURCES + 40 },
    (_, i) => row({ Slod: `${ICELAND_IMAGE_ORIGIN}cam_${i}.jpg` }),
  );
  t.mock.method(globalThis, 'fetch', async () => json(rows));
  assert.equal(
    (await loadIcelandSourcesFromOpenData()).length,
    DEFAULT_ICELAND_MAX_SOURCES,
  );
});

test('CCTV_ICELAND_MAX_SOURCES is clamped to 8..600 and ignored when not a number', async (t) => {
  t.mock.method(console, 'log', () => {});
  withEnv(t, { CCTV_ICELAND_MAX_SOURCES: undefined });
  const rows = Array.from({ length: 650 }, (_, i) =>
    row({ Slod: `${ICELAND_IMAGE_ORIGIN}cam_${i}.jpg` }),
  );
  t.mock.method(globalThis, 'fetch', async () => json(rows));
  for (const [value, expected] of [
    ['0', 8],
    ['3', 8],
    ['1000', 600],
    ['abc', DEFAULT_ICELAND_MAX_SOURCES],
  ]) {
    process.env.CCTV_ICELAND_MAX_SOURCES = value;
    assert.equal(
      (await loadIcelandSourcesFromOpenData()).length,
      expected,
      value,
    );
  }
});

test('a redirect on the Iceland frame host stays inside vefmyndavelar/', async () => {
  const frame = `${ICELAND_IMAGE_ORIGIN}hellisheidi_1.jpg`;
  const redirectTo = (location) => async (url) =>
    url === frame
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('frame', { headers: { 'content-type': 'image/jpeg' } });
  for (const location of [
    '/vgdata/other/x.jpg',
    '/vgdata/vefmyndavelar/../x.jpg',
    '/',
  ])
    assert.equal(
      await fetchWithinHost(frame, {}, redirectTo(location)),
      null,
      location,
    );
  const followed = await fetchWithinHost(
    frame,
    {},
    redirectTo('/vgdata/vefmyndavelar/hellisheidi_1b.jpg'),
  );
  assert.equal(await followed.text(), 'frame');
});

test('the Iceland loader fails soft on HTTP errors, bad payloads and network errors', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('x', { status: 503 }),
  );
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => json({ rows: [] }));
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>', { status: 200 }),
  );
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
});

test('the Iceland catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const redirected = streamingResponse({
    status: 302,
    headers: {
      location: 'http://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1',
    },
  });
  t.mock.method(globalThis, 'fetch', async () => redirected.response);
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 500 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the error body is cancelled');

  const valid = JSON.stringify([row()]);
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(valid, {
      headers: { 'content-length': String(ICELAND_MAX_CATALOG_BYTES + 1) },
    });
  });
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const padded = valid + ' '.repeat(ICELAND_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(padded));
          controller.close();
        },
      }),
    );
  });
  assert.deepEqual(await loadIcelandSourcesFromOpenData(), []);
});

test('CCTV catalog merges Iceland cameras and CCTV_ICELAND_ENABLED=0 skips the request', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-catalog-iceland-'),
  );
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  withEnv(t, {
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_PREFER_AUSTIN: undefined,
    CCTV_MAX_SOURCES: undefined,
    CCTV_CALTRANS_DISTRICTS: undefined,
    CCTV_TFL_ENABLED: undefined,
    CCTV_ICELAND_ENABLED: undefined,
    CCTV_ICELAND_MAX_SOURCES: undefined,
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect]);
    if (String(url) !== ICELAND_CAMERAS_URL) {
      return new Response('unavailable', { status: 503 });
    }
    return json([row()]);
  });

  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['is-vegagerdin-hellisheidi_1'],
  );

  process.env.CCTV_ICELAND_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.some(([url]) => url === ICELAND_CAMERAS_URL),
    false,
    'a disabled pack makes no request',
  );
});
