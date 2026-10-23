import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MET_IMAGE_ORIGIN,
  MET_WEBCAM_CATALOG_URL,
  applyMetGroundHeights,
  loadMetSources,
  metCameraToSource,
  metFacingToHeading,
  parseMetWebcamList,
} from '../../server/providers/cctv/met.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { KARTVERKET_HEIGHT_URL } from '../../server/providers/cctv/constants.js';
import {
  applyVegvesenGroundHeights,
  clearKartverketHeightCache,
} from '../../server/providers/cctv/sources.js';

/** One camera row, shaped like the live obs-view.met.no/obswebcam/ page. */
const row = ({
  site = 'webcam_bjornoya1',
  group = 'MET OBS',
  location = 'Bj&oslash;rn&oslash;ya (mot &oslash;st) ',
  position = '74.50384  18.996419',
  status = 'operativ',
  image = `last/site1_${site}.jpg`,
} = {}) => `<tr valign=top>
<tr>
<td width=50 bgcolor=#00ff00>
[OK]</td>
<td width=25>
</td>
<td>
<br><b>Site:${site} [${group}]</b><br>Lokasjon:${location}<br>Camera:campbell<br>Posisjon:${position}<br>
Link to internal page<br>Status:${status}<br><br></td>
<td>
${image ? `<a href=${image}><img src=${image} width=200 border=1></a><br>` : ''}</td>
</tr>
</tr>`;

const page = (...rows) =>
  `<html><head><title>Webcam fra MET Norway</title></head><body>
<p><hr>Kamera gruppe MET OBS OKD<p><hr>
<table align=center width=90% border=0 >
${rows.join('\n')}
</table></body></html>`;

/** A Kartverket `punkt` answer for the points the request asked about. */
const heightAnswer = (url, zFor) => {
  const asked = JSON.parse(new URL(url).searchParams.get('punkter'));
  return Response.json({
    koordsys: 4258,
    punkter: asked.map(([x, y]) => ({ x, y, ...zFor(x, y) })),
  });
};

const camera = (lat, lon, id = `c-${lat}-${lon}`) => ({ id, lat, lon });

test('the list page parses into one entry per camera', () => {
  const entries = parseMetWebcamList(
    page(
      row(),
      row({
        site: 'webcam_reinhaugen',
        group: 'MET OBS (COAT)',
        location: 'Reinhaugen i Finnmark',
        position: '70.335694  28.964806',
      }),
    ),
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    site: 'webcam_bjornoya1',
    group: 'MET OBS',
    location: 'Bjørnøya (mot øst)',
    lat: 74.50384,
    lon: 18.996419,
    status: 'operativ',
    image: 'last/site1_webcam_bjornoya1.jpg',
  });
  assert.equal(entries[1].group, 'MET OBS (COAT)');
});

test('a MET entry maps to a source on the pinned frame path', () => {
  const [entry] = parseMetWebcamList(page(row()));
  const source = metCameraToSource(entry);
  assert.equal(source.id, 'no-met-bjornoya1');
  assert.equal(source.name, 'Bjørnøya (mot øst)');
  assert.equal(source.city, 'Norway');
  assert.equal(source.cityId, 'norway');
  assert.equal(source.provider, 'MET Norway');
  assert.equal(source.lat, 74.50384);
  assert.equal(source.lon, 18.996419);
  assert.equal(source.headingDeg, 90);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, `${MET_IMAGE_ORIGIN}site1_webcam_bjornoya1.jpg`);
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.sourceKind, 'met-obswebcam');
  assert.equal(source.code, 'BJØRNØYA');
});

test('the compass word sets the heading; without one the prior is low', () => {
  assert.equal(metFacingToHeading('Haukeliseter (mot sør)'), 180);
  assert.equal(metFacingToHeading('Drag på Hamarøy (mot nordøst)'), 45);
  // The list spells sørvest "søvest" for Bø i Vesterålen.
  assert.equal(metFacingToHeading('Bø i Vesterålen (mot søvest)'), 225);
  assert.ok(Number.isNaN(metFacingToHeading('Jan Mayen')));
  assert.ok(Number.isNaN(metFacingToHeading('Sted (mot havet)')));
  const [entry] = parseMetWebcamList(
    page(
      row({
        site: 'webcam_janmayen1',
        location: 'Jan Mayen',
        position: '70.922686 -8.715629',
      }),
    ),
  );
  const source = metCameraToSource(entry);
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('cameras without an image, off-path frames and bad rows are dropped', () => {
  const sources = parseMetWebcamList(
    page(
      // MET leaves the image cell empty for a camera that stopped delivering.
      row({ site: 'webcam_bergebydalen', image: '' }),
      row({ image: 'https://evil.test/last/site1_webcam_bjornoya1.jpg' }),
      // Another camera's frame.
      row({ image: 'last/site1_webcam_hopen1.jpg' }),
      row({
        image:
          '//obs-view.met.no/obswebcam/last/site1_webcam_bjornoya1.jpg?x=1',
      }),
      row({ site: 'webcam_../x' }),
      // Copenhagen: plausible, but outside Norway and the Arctic islands.
      row({ position: '55.68 12.57' }),
      row({ position: '74.5' }),
    ),
  ).map(metCameraToSource);
  assert.deepEqual(sources, [null, null, null, null, null, null, null]);
  assert.equal(metCameraToSource(null), null);
});

test('the loader dedupes, and failures degrade to an empty pack', async (t) => {
  clearKartverketHeightCache();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect]);
    if (String(url).startsWith(KARTVERKET_HEIGHT_URL)) {
      return heightAnswer(url, () => ({ z: 347.13, datakilde: 'dtm1' }));
    }
    return new Response(
      page(
        row(),
        row(),
        row({
          site: 'webcam_hurum',
          location: 'V&aelig;rradar p&aring; Hurum',
          position: '59.627180  10.564460',
        }),
        // A camera MET is still trialling is left out.
        row({
          site: 'webcam_trial',
          location: 'Pr&oslash;ve',
          position: '60.0  10.0',
          status: 'test',
        }),
      ),
      { headers: { 'Content-Type': 'text/html' } },
    );
  });
  const cameras = await loadMetSources();
  assert.deepEqual(requested[0], [MET_WEBCAM_CATALOG_URL, 'manual']);
  // Nearest-to-anchor first: Hurum (near Oslo) leads.
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['no-met-hurum', 'no-met-bjornoya1'],
  );
  assert.equal(cameras[0].name, 'Værradar på Hurum');
  assert.equal(cameras[0].groundElevationM, 347.1);
  assert.equal(cameras[1].groundElevationM, undefined);

  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadMetSources(), []);
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/' },
      }),
  );
  assert.deepEqual(await loadMetSources(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadMetSources(), []);
});

test('mainland cameras get Kartverket heights; the Arctic ones keep none', async (t) => {
  clearKartverketHeightCache();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return heightAnswer(url, (x) =>
      x === 7.213865
        ? { z: 986.04, datakilde: 'dtm1' }
        : x === 10.450589
          ? // Over water the API returns the sea-floor depth.
            { z: -9.8, datakilde: 'dybdekurver', terreng: 'Havflate' }
          : { z: null },
    );
  });
  const haukeliseter = camera(59.81186, 7.213865);
  const buholmsrasa = camera(64.4016412, 10.450589);
  const noHeight = camera(68.0, 16.0);
  const bjornoya = camera(74.50384, 18.996419);
  const janMayen = camera(70.922686, -8.715629);
  const cameras = [haukeliseter, buholmsrasa, noHeight, bjornoya, janMayen];
  await applyMetGroundHeights(cameras, { now: () => 1000 });
  assert.equal(requested.length, 1);
  const url = new URL(requested[0]);
  assert.equal(`${url.origin}${url.pathname}`, KARTVERKET_HEIGHT_URL);
  assert.equal(url.searchParams.get('koordsys'), '4258');
  // Svalbard and Jan Mayen are outside Kartverket's coverage: not asked.
  assert.equal(JSON.parse(url.searchParams.get('punkter')).length, 3);
  assert.equal(haukeliseter.groundElevationM, 986);
  assert.equal(buholmsrasa.groundElevationM, 0);
  assert.equal(noHeight.groundElevationM, undefined);
  assert.equal(bjornoya.groundElevationM, undefined);
  assert.equal(janMayen.groundElevationM, undefined);

  // Heights are cached; a miss is asked about again only after its TTL.
  const again = [camera(59.81186, 7.213865), camera(68.0, 16.0)];
  await applyMetGroundHeights(again, { now: () => 2000 });
  assert.equal(requested.length, 1);
  assert.equal(again[0].groundElevationM, 986);
  await applyMetGroundHeights(again, { now: () => 1000 + 7 * 60 * 60 * 1000 });
  assert.equal(requested.length, 2);
  assert.equal(
    JSON.parse(new URL(requested[1]).searchParams.get('punkter')).length,
    1,
  );
});

test('a failed height lookup leaves cameras without heights and backs off', async (t) => {
  clearKartverketHeightCache();
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('busy', { status: 429 });
  });
  t.mock.method(console, 'log', () => {});
  const cameras = [camera(59.81186, 7.213865)];
  await applyMetGroundHeights(cameras, { now: () => 1000 });
  assert.equal(cameras[0].groundElevationM, undefined);
  // The shared backoff (30 min without Retry-After) outlasts a refresh.
  await applyMetGroundHeights(cameras, { now: () => 1000 + 15 * 60 * 1000 });
  assert.equal(calls, 1);
  await applyMetGroundHeights(cameras, { now: () => 1000 + 31 * 60 * 1000 });
  assert.equal(calls, 2);
});

test('MET and Vegvesen share one height cache and one backoff', async (t) => {
  clearKartverketHeightCache();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('busy', { status: 503 });
  });
  // Vegvesen's failure backs both packs off: MET asks nothing.
  await applyVegvesenGroundHeights([camera(60.0, 9.0)], { now: () => 1000 });
  assert.equal(calls, 1);
  const met = [camera(59.81186, 7.213865)];
  await applyMetGroundHeights(met, { now: () => 2000 });
  assert.equal(calls, 1);
  // A height one pack fetched serves the other at the same position.
  clearKartverketHeightCache();
  t.mock.method(globalThis, 'fetch', async (url) =>
    heightAnswer(url, () => ({ z: 986.04, datakilde: 'dtm1' })),
  );
  await applyVegvesenGroundHeights([camera(59.81186, 7.213865)]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected');
  });
  await applyMetGroundHeights(met);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(met[0].groundElevationM, 986);
});

test('CCTV_MET_HEIGHTS=0 skips the lookup', async (t) => {
  clearKartverketHeightCache();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected');
  });
  const saved = process.env.CCTV_MET_HEIGHTS;
  t.after(() => {
    if (saved === undefined) delete process.env.CCTV_MET_HEIGHTS;
    else process.env.CCTV_MET_HEIGHTS = saved;
  });
  process.env.CCTV_MET_HEIGHTS = '0';
  const cameras = [camera(59.81186, 7.213865)];
  await applyMetGroundHeights(cameras);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(cameras[0].groundElevationM, undefined);
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === MET_WEBCAM_CATALOG_URL) return new Response(page(row()));
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_MET_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('the MET lane is wired into the catalog when opted in', async (t) => {
  await withEnv({ CCTV_MET_ENABLED: '1' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(MET_WEBCAM_CATALOG_URL));
    assert.deepEqual(
      sources.filter((s) => s.sourceKind === 'met-obswebcam').map((s) => s.id),
      ['no-met-bjornoya1'],
    );
  });
});

test('the MET lane is off unless CCTV_MET_ENABLED=1', async (t) => {
  for (const patch of [{}, { CCTV_MET_ENABLED: '0' }]) {
    await withEnv(patch, async () => {
      const { requested, sources } = await runCatalog(t);
      assert.equal(requested.includes(MET_WEBCAM_CATALOG_URL), false);
      assert.deepEqual(
        sources.filter((s) => s.sourceKind === 'met-obswebcam'),
        [],
      );
    });
  }
});
