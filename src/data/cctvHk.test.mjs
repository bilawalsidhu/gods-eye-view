import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hkCameraName,
  hkCameraToSource,
  hkImageUrlFromKey,
  loadHkSourcesFromOpenData,
  normalizeHkImageUrl,
  parseHkCameraLocationsXml,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DEFAULT_HK_CAMERAS_URL,
  DEFAULT_HK_MAX_SOURCES,
  HK_IMAGE_ORIGIN,
  HK_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<image-list>'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** One Transport Department `<image>` block as a parsed row. */
const row = (overrides = {}) => ({
  key: 'BC101F',
  region: 'New Territories',
  district: 'North',
  description: 'San Tin Highway near Lok Ma Chau [BC101F]',
  latitude: '22.508',
  longitude: '114.078',
  url: 'https://tdcctv.data.one.gov.hk/BC101F.JPG',
  ...overrides,
});

/** Fixture XML matching the published English locations schema. */
const fixtureXml = (...records) => {
  const images = records
    .map(
      (record) => `
	<image>
		<key>${record.key}</key>
		<region>${record.region}</region>
		<district>${record.district}</district>
		<description>${record.description}</description>
		<latitude>${record.latitude}</latitude>
		<longitude>${record.longitude}</longitude>
		<url>${record.url}</url>
	</image>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<image-list>${images}\n</image-list>\n`;
};

test('an HK row maps to a source on the pinned HTTPS frame host', () => {
  const source = hkCameraToSource(row());
  assert.equal(source.id, 'hk-bc101f');
  assert.equal(source.name, 'San Tin Highway near Lok Ma Chau [BC101F]');
  assert.equal(source.cityId, 'hk');
  assert.equal(source.provider, 'Transport Department');
  assert.equal(source.lat, 22.508);
  assert.equal(source.lon, 114.078);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'hk-td-open-data');
  assert.equal(
    source.license,
    'Hong Kong Transport Department / DATA.GOV.HK — attribution required',
  );
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
  assert.equal(source.url, 'https://tdcctv.data.one.gov.hk/BC101F.JPG');
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(HK_IMAGE_ORIGIN));
});

test('rows outside Hong Kong, off-host frames and unusable keys are dropped', () => {
  assert.equal(
    hkCameraToSource(row({ latitude: '43.6532', longitude: '-79.3832' })),
    null,
  );
  assert.equal(hkCameraToSource(row({ latitude: '0', longitude: '0' })), null);
  assert.equal(hkCameraToSource(row({ key: '' })), null);
  assert.equal(hkCameraToSource(row({ key: 'bad key!' })), null);
  assert.equal(
    hkCameraToSource(row({ url: 'https://evil.example/BC101F.JPG' })),
    null,
  );
  assert.equal(
    hkCameraToSource(
      row({
        url: 'https://tdcctv.data.one.gov.hk.evil.test/BC101F.JPG',
      }),
    ),
    null,
  );
  assert.equal(hkCameraToSource(row({ url: 'file:///etc/passwd' })), null);
  assert.equal(hkCameraToSource(null), null);
});

test('frame URLs are rebuilt from the key and pinned to the TD host', () => {
  assert.equal(
    hkImageUrlFromKey('bc101f'),
    'https://tdcctv.data.one.gov.hk/BC101F.JPG',
  );
  assert.equal(hkImageUrlFromKey(''), null);
  assert.equal(hkImageUrlFromKey('bad/key'), null);

  assert.equal(
    normalizeHkImageUrl('http://tdcctv.data.one.gov.hk/H429F.JPG'),
    'https://tdcctv.data.one.gov.hk/H429F.JPG',
  );
  assert.equal(
    normalizeHkImageUrl('https://tdcctv.data.one.gov.hk/H429F.JPG'),
    'https://tdcctv.data.one.gov.hk/H429F.JPG',
  );
  assert.equal(normalizeHkImageUrl(''), null);
  assert.equal(normalizeHkImageUrl('not a url'), null);
  assert.equal(normalizeHkImageUrl('https://evil.example/H429F.JPG'), null);
});

test('a nameless row still gets a label', () => {
  assert.equal(
    hkCameraName(
      { description: '  Aberdeen Praya Road near Fish Market [H429F] ' },
      'hk-h429f',
    ),
    'Aberdeen Praya Road near Fish Market [H429F]',
  );
  assert.equal(hkCameraName({ key: 'H429F' }, 'hk-h429f'), 'H429F');
  assert.equal(hkCameraName({}, 'hk-h429f'), 'HK Camera h429f');
});

test('the XML parser reads each image block', () => {
  const rows = parseHkCameraLocationsXml(
    fixtureXml(
      row(),
      row({
        key: 'H429F',
        region: 'Hong Kong Island',
        district: 'Southern',
        description: 'Aberdeen Praya Road near Fish Market [H429F]',
        latitude: '22.24845',
        longitude: '114.1505',
        url: 'https://tdcctv.data.one.gov.hk/H429F.JPG',
      }),
    ),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'BC101F');
  assert.equal(rows[1].key, 'H429F');
  assert.equal(rows[1].latitude, '22.24845');
});

test('the loader reads the keyless catalog and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(
      fixtureXml(
        row(),
        row({ description: 'San Tin Highway near Lok Ma Chau (duplicate)' }),
        row({
          key: 'H210F',
          region: 'Hong Kong Island',
          district: 'Wan Chai',
          description: 'Aberdeen Tunnel - Wan Chai Side [H210F]',
          latitude: '22.2747',
          longitude: '114.17936',
          url: 'https://tdcctv.data.one.gov.hk/H210F.JPG',
        }),
        row({ url: 'https://evil.example/x.jpg' }),
      ),
      { headers: { 'Content-Type': 'application/xml' } },
    );
  });
  const cameras = await loadHkSourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_HK_CAMERAS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest Central/TST first: Wan Chai before the northern New Territories.
    ['hk-h210f', 'hk-bc101f'],
  );
  assert.equal(cameras[0].name, 'Aberdeen Tunnel - Wan Chai Side [H210F]');
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadHkSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadHkSourcesFromOpenData(), []);
});

test('the unselected label is the description, trimmed to the code width', () => {
  assert.equal(
    hkCameraToSource(row({ description: 'San Tin Highway [BC101F]' })).code,
    'SAN TIN HIGHWAY [BC101F]',
  );
  const long = hkCameraToSource(
    row({
      description:
        'Bow Trail & Old Banff Coach Rd SW / Strathcona Blvd SW [BC101F]',
    }),
  );
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('BOW TRAIL & OLD BANFF'));
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.xml' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadHkSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[DEFAULT_HK_CAMERAS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const body = fixtureXml(row());
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml',
        'content-length': String(HK_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadHkSourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(HK_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/xml' } },
    );
  });
  assert.deepEqual(await loadHkSourcesFromOpenData(), []);
});

test('a reduced catalog cap thins every pack instead of dropping HK', () => {
  const lane = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  });
  const { sources, packs } = allocateSourceCap(
    [
      lane('austin', 250),
      lane('calgary', 215),
      lane('hk', DEFAULT_HK_MAX_SOURCES),
    ],
    30,
  );
  assert.equal(sources.length, 30);
  assert.deepEqual(
    packs.map((p) => [p.name, p.kept]),
    [
      ['austin', 10],
      ['calgary', 10],
      ['hk', 10],
    ],
  );
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('hk-')).map((s) => s.id),
    Array.from({ length: 10 }, (_, i) => `hk-${i}`),
  );
});

/**
 * Serve the HK catalog to the HK endpoint and an empty payload to every other
 * pack, so one catalog refresh exercises the registration without reaching the
 * network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.includes('Traffic_Camera_Locations_En.xml')) {
      return new Response(
        fixtureXml(
          row(),
          row({
            key: 'H210F',
            region: 'Hong Kong Island',
            district: 'Wan Chai',
            description: 'Aberdeen Tunnel - Wan Chai Side [H210F]',
            latitude: '22.2747',
            longitude: '114.17936',
            url: 'https://tdcctv.data.one.gov.hk/H210F.JPG',
          }),
        ),
        { headers: { 'Content-Type': 'application/xml' } },
      );
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the HK lane is wired into the catalog and its loader runs', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_HK_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.includes(DEFAULT_HK_CAMERAS_URL),
      'the catalog refresh invokes the HK loader',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'hk').map((s) => s.id),
      ['hk-h210f', 'hk-bc101f'],
      'HK cameras reach the served catalog through the registered lane',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('CCTV_HK_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_HK_ENABLED = '0';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.includes(DEFAULT_HK_CAMERAS_URL),
      false,
      'the disabled lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'hk'),
      [],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
});
