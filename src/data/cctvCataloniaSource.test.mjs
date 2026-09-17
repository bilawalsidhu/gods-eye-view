import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { CATALONIA_CAMERAS_URL } from '../../server/providers/cctv/constants.js';
import {
  parseCataloniaXml,
  normalizeCataloniaImageUrl,
  cataloniaCameraName,
  loadCataloniaSourcesFromOpenData,
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

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** One `<gml:featureMember>` block matching the real feed's shape. */
function cataloniaFeature({
  fid,
  lon,
  lat,
  carretera = '',
  municipi = '',
  pk = '',
  link = '',
  font = '',
}) {
  const pkTag = pk ? `<cite:pk>${pk}</cite:pk>` : '';
  return (
    `<gml:featureMember><cite:cameres fid="${fid}">` +
    `<cite:geom><gml:Point srsName="http://www.opengis.net/gml/srs/epsg.xml#4326">` +
    `<gml:coordinates xmlns:gml="http://www.opengis.net/gml" decimal="." cs="," ts=" ">${lon},${lat}</gml:coordinates>` +
    `</gml:Point></cite:geom>` +
    `<cite:carretera>${carretera}</cite:carretera>` +
    `<cite:municipi>${municipi}</cite:municipi>${pkTag}` +
    `<cite:link>${link}</cite:link>` +
    `<cite:font>${font}</cite:font>` +
    `</cite:cameres></gml:featureMember>`
  );
}

function cataloniaFeed(features) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs">' +
    features.join('') +
    '</wfs:FeatureCollection>'
  );
}

test('parseCataloniaXml extracts every field from a feature block', () => {
  const xml = cataloniaFeed([
    cataloniaFeature({
      fid: 'cameres.fid-52bf6eca_1a0a06bea1c_386f',
      lon: '2.1849528',
      lat: '41.45989301',
      carretera: 'C-58',
      municipi: 'Nus Trinitat',
      pk: '0.50',
      link: 'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=nc87.gif',
      font: 'SCT',
    }),
  ]);
  const rows = parseCataloniaXml(xml);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    fid: 'cameres.fid-52bf6eca_1a0a06bea1c_386f',
    lon: 2.1849528,
    lat: 41.45989301,
    carretera: 'C-58',
    municipi: 'Nus Trinitat',
    pk: '0.50',
    link: 'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=nc87.gif',
    font: 'SCT',
  });
});

test('normalizeCataloniaImageUrl rewrites SCT RenderService links to the direct http TransitCamera URL', () => {
  // RenderService always 302s to a hardcoded http:// Location (which
  // fetchWithinHost refuses as a scheme downgrade), and mct.gencat.cat's TLS
  // setup fails the handshake with Node's fetch regardless — TransitCamera
  // over plain http is the only transport that actually works here, so we
  // build that URL from RenderService's sctidcam id instead of registering
  // the redirector.
  assert.equal(
    normalizeCataloniaImageUrl(
      'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=nc87.gif',
    ),
    'http://mct.gencat.cat/mct2bo/TransitCamera?nom=nc87.gif&visualitzacio=imatge',
  );
  assert.equal(
    normalizeCataloniaImageUrl(
      'https://mct.gencat.cat/mct2bo/RenderService?sctidcam=sc64.gif',
    ),
    'http://mct.gencat.cat/mct2bo/TransitCamera?nom=sc64.gif&visualitzacio=imatge',
    'an already-https RenderService link is rewritten the same way',
  );
  assert.equal(
    normalizeCataloniaImageUrl('https://mct.gencat.cat/mct2bo/RenderService'),
    '',
    'a RenderService link with no sctidcam id is rejected',
  );
});

test('normalizeCataloniaImageUrl accepts the other registered hosts, upgraded to https', () => {
  assert.equal(
    normalizeCataloniaImageUrl('http://www.bcn.cat/transit/imatges/a.gif'),
    'https://www.bcn.cat/transit/imatges/a.gif',
  );
  assert.equal(
    normalizeCataloniaImageUrl(
      'https://emap.terrassa.cat/it_terrassa/cam02.jpeg',
    ),
    'https://emap.terrassa.cat/it_terrassa/cam02.jpeg',
  );
  assert.equal(
    normalizeCataloniaImageUrl('https://evil.example.com/mct.gencat.cat.gif'),
    '',
    'a look-alike host is rejected',
  );
  assert.equal(
    normalizeCataloniaImageUrl('https://unlisted-publisher.example/frame.gif'),
    '',
    'any host outside the allowlist is rejected',
  );
  assert.equal(normalizeCataloniaImageUrl(''), '');
  assert.equal(normalizeCataloniaImageUrl('not a url'), '');
});

test('cataloniaCameraName joins road and municipality, skipping a redundant municipality', () => {
  assert.equal(
    cataloniaCameraName('C-58', 'Nus Trinitat'),
    'C-58 (Nus Trinitat)',
  );
  assert.equal(
    cataloniaCameraName('Plaça Urquinaona', 'Barcelona'),
    'Plaça Urquinaona (Barcelona)',
  );
  assert.equal(
    cataloniaCameraName('Barcelona Ronda Litoral', 'Barcelona'),
    'Barcelona Ronda Litoral',
  );
  assert.equal(cataloniaCameraName('', ''), 'Càmera de trànsit');
  assert.equal(cataloniaCameraName('C-58', ''), 'C-58');
});

test('Catalonia loader keeps SCT, Barcelona and Terrassa cameras with per-publisher credit', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_CATALONIA_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const xml = cataloniaFeed([
      cataloniaFeature({
        fid: 'cameres.fid-1',
        lon: '2.1849528',
        lat: '41.45989301',
        carretera: 'C-58',
        municipi: 'Nus Trinitat',
        pk: '0.50',
        link: 'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=nc87.gif',
        font: 'SCT',
      }),
      cataloniaFeature({
        fid: 'cameres.fid-2',
        lon: '2.17228212',
        lat: '41.38890733',
        carretera: 'Plaça Urquinaona',
        municipi: 'Barcelona',
        link: 'http://www.bcn.cat/transit/imatges/PlUrquinaona.gif?a=1',
        font: 'IMI',
      }),
      cataloniaFeature({
        fid: 'cameres.fid-3',
        lon: '2.0111',
        lat: '41.5636',
        carretera: 'Cam02',
        municipi: 'Terrassa',
        link: 'https://emap.terrassa.cat/it_terrassa/cam02.jpeg?a=1',
        font: 'Terrassa',
      }),
      // Rejected: link host not in the allowlist.
      cataloniaFeature({
        fid: 'cameres.fid-4',
        lon: '2.0',
        lat: '41.5',
        link: 'https://example.com/fake.gif',
        font: 'SCT',
      }),
      // Rejected: outside the Catalonia bounding box.
      cataloniaFeature({
        fid: 'cameres.fid-5',
        lon: '-3.7',
        lat: '40.4',
        link: 'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=x.gif',
        font: 'SCT',
      }),
    ]);
    return new Response(xml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  });

  const cameras = await loadCataloniaSourcesFromOpenData();

  assert.deepEqual(requested, [CATALONIA_CAMERAS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id).sort(),
    ['cat-1', 'cat-2', 'cat-3'],
    'the off-allowlist link (fid-4) and the out-of-bbox row (fid-5) are excluded',
  );

  const sct = cameras.find((c) => c.id === 'cat-1');
  assert.equal(sct.name, 'C-58 (Nus Trinitat)');
  assert.equal(sct.provider, 'Servei Català de Trànsit');
  assert.equal(sct.credit, '', 'SCT is the publisher, no separate credit');
  assert.equal(
    sct.url,
    'http://mct.gencat.cat/mct2bo/TransitCamera?nom=nc87.gif&visualitzacio=imatge',
    'registers the direct, non-redirecting http frame URL, not the RenderService redirector',
  );
  assert.equal(sct.groundElevationM, 80);
  assert.equal(sct.headingConfidence, 'low', 'the feed carries no heading');

  const bcn = cameras.find((c) => c.id === 'cat-2');
  assert.equal(bcn.credit, 'Ajuntament de Barcelona');
  assert.equal(bcn.city, 'Barcelona');
  assert.equal(bcn.groundElevationM, 20);

  const terrassa = cameras.find((c) => c.id === 'cat-3');
  assert.equal(terrassa.credit, 'Ajuntament de Terrassa');
  assert.equal(terrassa.groundElevationM, 270);
});

test('Catalonia loader fails soft on HTTP errors, empty payloads and network errors', async (t) => {
  quiet(t);
  let respond;
  t.mock.method(globalThis, 'fetch', (...args) => respond(...args));
  for (respond of [
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('<wfs:FeatureCollection></wfs:FeatureCollection>'),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(await loadCataloniaSourcesFromOpenData(), []);
  }
});

test('CCTV catalog merges Catalonia cameras and CCTV_CATALONIA_ENABLED=0 skips the request', async (t) => {
  quiet(t);
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-catalog-catalonia-'),
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
    CCTV_CATALONIA_ENABLED: undefined,
    CCTV_CATALONIA_MAX_SOURCES: undefined,
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (String(url) !== CATALONIA_CAMERAS_URL) {
      return new Response('unavailable', { status: 503 });
    }
    const xml = cataloniaFeed([
      cataloniaFeature({
        fid: 'cameres.fid-1',
        lon: '2.1849528',
        lat: '41.45989301',
        link: 'http://mct.gencat.cat/mct2bo/RenderService?sctidcam=nc87.gif',
        font: 'SCT',
      }),
    ]);
    return new Response(xml, { status: 200 });
  });

  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['cat-1'],
  );

  process.env.CCTV_CATALONIA_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.includes(CATALONIA_CAMERAS_URL),
    false,
    'a disabled pack makes no request',
  );
});
