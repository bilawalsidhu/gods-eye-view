import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCctvCatalog } from './catalog.js';
import {
  DRIVENC_CAMERAS_URL,
  DRIVENC_MAP_ICONS_URL,
  DRIVENC_TOOLTIP_URL,
} from './constants.js';
import {
  _clearDriveNcTooltipCacheForTest,
  driveNcCameraLabel,
  driveNcHeadingFromCode,
  loadDriveNcSourcesFromOpenData,
  parseDriveNcCameraCode,
  parseDriveNcTooltip,
} from './sources.js';

/** The `/map/mapIcons/Cameras` catalog: every camera's id and [lat, lon]. */
function mapIcons(cameras) {
  return {
    item1: {
      url: '/Generated/Content/Images/511/map_camera.svg',
      size: [29, 35],
      origin: [0, 0],
      anchor: [14, 34],
      zindex: 0,
      preventClustering: false,
      isClickable: true,
    },
    item2: cameras.map(([itemId, lat, lon]) => ({
      itemId,
      location: [lat, lon],
      icon: {},
      title: '',
    })),
  };
}

/**
 * A `/tooltip/Cameras/<id>` page, trimmed to the markup the loader reads plus
 * the video container it ignores (the stream needs credentials).
 */
function tooltipHtml(id, code, viewId = id) {
  return `\r\n\r\n<div class="map-tooltip camTooltip">
    <h4>
        <img src="/Content/Images/ic_camera.svg" alt="Camera" /> Camera
    </h4>
    <table class="table-condensed table-striped">
        <tbody>
            <tr>
                <td id="CameraTooltipDescriptionColumn" colspan="2">
                    <strong>
                        ${code}
                    </strong>
                </td>
                <td id="MyCameraButtonRow" style="display: none">
    <div class="dropdown">
        <button class="btn btn-primary dropdown-toggle" type="button" data-site-id="${id}">My Cameras</button>
    </div>
</td>
            </tr>
            <tr>
                <td colspan="2">
                    <div class="cctvCameraCarousel setVisibility">
                            <div id="carouselDiv-${id}">
                                    <div class="text-center">
                                        <button class="btn btn-default btn-xs showVideo" id="showVideo-${id}" data-camera-id="${id}" >Show Video</button>
                                    </div>
                                    <div class="dirDescHeader">${code}</div>
                                    <img class="carouselCctvImage cctvImage" data-lazy="/map/Cctv/${viewId}" title="Click to enlarge the image." alt="${code}, ${code}" id='${id}img' data-fs-title="${code}" data-fs-desc="${code}" data-refresh-rate="60000" />
                                    <div id="${id}-videoContainer" data-camera-id="${id}" data-videoauth="true" data-videourl="https://cfsse06.services.ncdot.gov:8887/chan-${id}_l/index.m3u8" data-streamtype="application/x-mpegURL"></div>
                            </div>
                    </div>
                </td>
            </tr>
        </tbody>
    </table>
</div>`;
}

/** A row of the keyed `api/v2/get/cameras` catalog (the Ontario 511 shape). */
const API_ROW = {
  Id: 42,
  Latitude: 35.78,
  Longitude: -78.64,
  Location: 'CCTV05-I40-300E_WADE',
  Roadway: 'I-40',
  Direction: 'Eastbound',
  County: 'Wake',
  Views: [
    {
      Status: 'Enabled',
      Url: 'https://www.drivenc.gov/map/Cctv/4201',
      Description: 'I-40 East',
    },
  ],
};

/** Cameras nearest the three anchors, farther ones, and rows to be dropped. */
const RALEIGH = [35.7796, -78.6382];
const CHARLOTTE = [35.2271, -80.8431];
const GREENSBORO = [36.0726, -79.792];
const near = ([lat, lon], dLat) => [lat + dLat, lon];
const ICON_ROWS = [
  ['5413', ...near(RALEIGH, 0.001)],
  ['5464', ...near(RALEIGH, 0.002)],
  ['5466', ...near(RALEIGH, 0.003)],
  ['4022', ...near(CHARLOTTE, 0.0015)],
  ['4023', ...near(CHARLOTTE, 0.0025)],
  ['4024', ...near(CHARLOTTE, 0.004)],
  ['6001', ...near(GREENSBORO, 0.0005)],
  ['6002', ...near(GREENSBORO, 0.0035)],
  ['7001', 35.5951, -82.5515], // Asheville, far from every anchor
  ['7002', 34.2257, -77.9447], // Wilmington, far from every anchor
  ['abc', ...near(RALEIGH, 0.001)], // not a camera id
  ['5413', ...near(RALEIGH, 0.009)], // duplicate id
  ['8001', 37.5407, -77.436], // Richmond, VA: outside the state
];
const TOOLTIP_CODES = {
  5413: 'CCTV04-I40-311E_NC54',
  5464: 'CCTV04-US70-319W_CORNWALLIS',
  5466: 'CCTV05-US70BUS_GUY',
  4022: 'CCTV10-I77-10N',
  4023: 'CCTV10-I485-25.5S_US74',
  4024: 'CCTV10-I85-38M_BROOKSHIRE',
  6001: 'CCTV07-I40-217W_HOLDEN',
  6002: 'CCTV07-US220-91S',
  7001: 'CCTV13-I40-55E',
  7002: 'CCTV03-I40-420E',
};

/**
 * Route every fetch of a test: the map catalog, the tooltip pages, the keyed
 * API and nothing else. A tooltip entry can be HTML, a status code, or a
 * function answering the request itself.
 */
function routeFetch(
  t,
  { icons = mapIcons(ICON_ROWS), tooltips = {}, api } = {},
) {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const href = String(url);
    requested.push(href);
    if (href === DRIVENC_MAP_ICONS_URL) {
      return typeof icons === 'function'
        ? icons(href, init)
        : Response.json(icons);
    }
    const tooltip =
      /^https:\/\/www\.drivenc\.gov\/tooltip\/Cameras\/([^/?#]+)$/.exec(href);
    if (tooltip) {
      const id = tooltip[1];
      const answer = Object.hasOwn(tooltips, id)
        ? tooltips[id]
        : tooltipHtml(id, TOOLTIP_CODES[id] || `CCTV00-NC1-${id}N`);
      if (typeof answer === 'function') return answer(href, init);
      if (typeof answer === 'number')
        return new Response('', { status: answer });
      return new Response(answer, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (href.startsWith(DRIVENC_CAMERAS_URL.split('?')[0]) && api) {
      return api(href, init);
    }
    return new Response('unavailable', { status: 503 });
  });
  return requested;
}

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

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

const tooltipRequests = (requested) =>
  requested.filter((href) => href.includes('/tooltip/Cameras/'));

test.beforeEach(() => _clearDriveNcTooltipCacheForTest());

test('NCDOT camera codes become road labels and low-confidence side-of-road headings', () => {
  const cases = [
    ['CCTV05-I40-273E_NC54', 'I-40 MM 273 E at NC-54', 90],
    ['CCTV04-US70-319W_CORNWALLIS', 'US-70 MM 319 W at CORNWALLIS', 270],
    ['CCTV05-I87-5S', 'I-87 MM 5 S', 180],
    ['CCTV05-NC147-1N', 'NC-147 MM 1 N', 0],
    ['CCTV05-NC147-7S_US15-501', 'NC-147 MM 7 S at US-15-501', 180],
    ['CCTV05-NC540-53.8E_NC55BYP', 'NC-540 MM 53.8 E at NC-55 BYP', 90],
    ['CCTV05-US64BUS-3W_NEWHOPE', 'US-64 BUS MM 3 W at NEWHOPE', 270],
    ['PCCTV05-I440-4W_WADE', 'I-440 MM 4 W at WADE', 270],
    // "M" is not a compass side: the label keeps it, the heading falls back.
    ['CCTV05-I40-289M_WADE', 'I-40 MM 289 M at WADE', NaN],
    ['CCTV05-NC540_US64', 'CCTV05-NC540_US64', NaN],
    ['CCTV05-EDWARDSMILL_DURALEIGH', 'CCTV05-EDWARDSMILL_DURALEIGH', NaN],
    ['', '', NaN],
  ];
  for (const [code, label, heading] of cases) {
    assert.equal(driveNcCameraLabel(code), label, code);
    assert.deepEqual(driveNcHeadingFromCode(code), heading, code);
  }
  assert.deepEqual(parseDriveNcCameraCode('CCTV05-I40-273.5E_NC54'), {
    road: 'I40',
    mile: '273.5',
    side: 'E',
    cross: 'NC54',
  });
  assert.equal(parseDriveNcCameraCode('CCTV05-TRINITY_YOUTHCENTER'), null);
});

test('a tooltip page yields the camera code and view id, and only a still under /map/Cctv/', () => {
  assert.deepEqual(
    parseDriveNcTooltip(tooltipHtml('5413', 'CCTV04-I40-311E')),
    {
      code: 'CCTV04-I40-311E',
      viewId: '5413',
    },
  );
  assert.deepEqual(
    parseDriveNcTooltip(
      tooltipHtml('5500', 'CCTV05-US1-1N &amp; US64', '5501'),
    ),
    { code: 'CCTV05-US1-1N & US64', viewId: '5501' },
  );
  for (const still of [
    '/other/Cctv/5413',
    '/map/Cctv/../../secret',
    '/map/Cctv/5413?x=1',
    'https://evil.example/map/Cctv/5413',
    '',
  ]) {
    assert.equal(
      parseDriveNcTooltip(
        tooltipHtml('5413', 'CCTV04-I40-311E').replace(
          'data-lazy="/map/Cctv/5413"',
          `data-lazy="${still}"`,
        ),
      ),
      null,
      still,
    );
  }
  assert.equal(parseDriveNcTooltip(''), null);
  assert.equal(parseDriveNcTooltip('<html>down</html>'), null);
  // A page without the code still registers the still; the camera gets a
  // generic name.
  assert.deepEqual(parseDriveNcTooltip('<img data-lazy="/map/Cctv/9" />'), {
    code: '',
    viewId: '9',
  });
});

test('keyless: the map catalog is listed, only the nearest cameras under the cap are looked up, and frames are pinned', async (t) => {
  const lines = captureConsole(t);
  const requested = routeFetch(t, {
    tooltips: { 5464: tooltipHtml('5464', TOOLTIP_CODES[5464], '5465') },
  });

  const cameras = await loadDriveNcSourcesFromOpenData(
    { sourceRoot: '/ignored' },
    { CCTV_DRIVENC_MAX_SOURCES: '8' },
  );

  assert.equal(requested[0], DRIVENC_MAP_ICONS_URL);
  // Nearest an anchor first, then the rest in distance order; the two far
  // cameras fall outside the cap and are never asked about.
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [
      'nc-6001',
      'nc-5413',
      'nc-4022',
      'nc-5464',
      'nc-4023',
      'nc-5466',
      'nc-6002',
      'nc-4024',
    ],
  );
  assert.equal(tooltipRequests(requested).length, 8);
  for (const far of ['7001', '7002', '8001', 'abc']) {
    assert.equal(
      requested.includes(DRIVENC_TOOLTIP_URL(far)),
      false,
      `${far} is not looked up`,
    );
  }
  assert.equal(cameras.available, 10, 'the listed count excludes bad rows');

  const i40 = cameras.find((camera) => camera.id === 'nc-5413');
  assert.equal(i40.name, 'I-40 MM 311 E at NC-54');
  assert.equal(i40.code, 'CCTV04-I40-311E_NC54');
  assert.equal(i40.url, 'https://www.drivenc.gov/map/Cctv/5413');
  assert.equal(i40.snapshotUrl, i40.url);
  assert.equal(i40.feedType, 'image');
  assert.equal(i40.provider, 'NCDOT DriveNC');
  assert.equal(i40.city, 'North Carolina');
  assert.equal(i40.cityId, 'north-carolina');
  assert.equal(i40.sourceKind, 'drivenc-open-data');
  assert.equal(i40.headingDeg, 90);
  assert.equal(i40.headingConfidence, 'low');
  assert.equal(i40.pitchDeg, -18);
  assert.equal(i40.fovDeg, 44);
  assert.equal(i40.rangeM, 145);
  assert.equal(i40.mountHeightM, 8);
  assert.equal(i40.lat, RALEIGH[0] + 0.001);
  assert.equal(i40.lon, RALEIGH[1]);
  assert.match(i40.license, /neither stored nor recorded/);

  // The frame URL comes from the view id, which need not be the camera id.
  const us70 = cameras.find((camera) => camera.id === 'nc-5464');
  assert.equal(us70.url, 'https://www.drivenc.gov/map/Cctv/5465');
  assert.equal(us70.headingDeg, 270);

  // A code without a side letter takes the id-hash fallback, still low.
  const guy = cameras.find((camera) => camera.id === 'nc-5466');
  assert.equal(guy.name, 'CCTV05-US70BUS_GUY');
  assert.ok(Number.isFinite(guy.headingDeg));
  assert.equal(guy.headingConfidence, 'low');

  assert.match(
    lines.join('\n'),
    /Loaded DriveNC camera sources: 10 listed \(using nearest 8\)/,
  );
});

test('a camera whose tooltip fails is left out of this refresh, and remembered tooltips are not refetched', async (t) => {
  const lines = captureConsole(t);
  const requested = routeFetch(t, {
    tooltips: {
      4022: 503,
      4023: () => {
        throw new TypeError('fetch failed');
      },
      6002: '<html>no still here</html>',
    },
  });
  const env = { CCTV_DRIVENC_MAX_SOURCES: '8' };

  const first = await loadDriveNcSourcesFromOpenData({}, env);
  assert.deepEqual(
    first.map((camera) => camera.id),
    ['nc-6001', 'nc-5413', 'nc-5464', 'nc-5466', 'nc-4024'],
  );
  assert.equal(tooltipRequests(requested).length, 8);
  assert.match(
    lines.join('\n'),
    /DriveNC: 3 of 8 camera tooltips unavailable this refresh/,
  );

  // The next refresh asks only about the three it could not resolve.
  requested.length = 0;
  const second = await loadDriveNcSourcesFromOpenData({}, env);
  assert.deepEqual(
    tooltipRequests(requested).sort(),
    [
      DRIVENC_TOOLTIP_URL('4022'),
      DRIVENC_TOOLTIP_URL('4023'),
      DRIVENC_TOOLTIP_URL('6002'),
    ].sort(),
  );
  assert.deepEqual(
    second.map((camera) => camera.id),
    first.map((camera) => camera.id),
  );
});

test('the catalog request refuses redirects and the loader fails soft', async (t) => {
  const lines = captureConsole(t);
  let icons;
  routeFetch(t, { icons: (...args) => icons(...args) });
  for (const [answer, pattern] of [
    [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/cameras' },
        }),
      /DriveNC catalog redirected; redirects are not followed/,
    ],
    [
      () => new Response('unavailable', { status: 503 }),
      /DriveNC camera download failed: 503/,
    ],
    [() => Response.json({ item1: {} }), /0 listed \(using nearest 0\)/],
    [() => Response.json('nonsense'), /0 listed \(using nearest 0\)/],
    [
      () => {
        throw new TypeError('fetch failed');
      },
      /DriveNC camera download error: fetch failed/,
    ],
  ]) {
    icons = answer;
    lines.length = 0;
    assert.deepEqual(await loadDriveNcSourcesFromOpenData({}, {}), []);
    assert.match(lines.join('\n'), pattern);
  }
});

test('with DRIVENC_API_KEY the keyed catalog is requested with it and parsed, and the key never leaks', async (t) => {
  const lines = captureConsole(t);
  const requested = routeFetch(t, {
    api: () =>
      Response.json([
        API_ROW,
        {
          ...API_ROW,
          Id: '43',
          Direction: 'Unknown',
          Location: 'CCTV05-I40-301W_WADE',
          Views: [
            {
              Status: 'Disabled',
              Url: 'https://www.drivenc.gov/map/Cctv/4301',
            },
            { Status: 'Enabled', Url: 'https://www.drivenc.gov/map/Cctv/4302' },
          ],
        },
        // Off-host and off-directory views register nothing.
        {
          ...API_ROW,
          Id: 44,
          Views: [
            { Status: 'Enabled', Url: 'https://evil.example/map/Cctv/44' },
          ],
        },
        {
          ...API_ROW,
          Id: 45,
          Views: [
            { Status: 'Enabled', Url: 'https://www.drivenc.gov/other/Cctv/45' },
          ],
        },
        { ...API_ROW, Id: 46, Latitude: 40.7 },
        { ...API_ROW, Id: 'x47' },
      ]),
  });

  const cameras = await loadDriveNcSourcesFromOpenData(
    {},
    { DRIVENC_API_KEY: ' test-key ', CCTV_DRIVENC_MAX_SOURCES: '8' },
  );

  assert.equal(requested.length, 1, 'one keyed request, no tooltip sweep');
  const url = new URL(requested[0]);
  assert.equal(url.host, 'www.drivenc.gov');
  assert.equal(url.pathname, '/api/v2/get/cameras');
  assert.equal(url.searchParams.get('key'), 'test-key');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['nc-42', 'nc-43'],
  );
  const [east, west] = cameras;
  assert.equal(east.url, 'https://www.drivenc.gov/map/Cctv/4201');
  assert.equal(east.name, 'I-40 MM 300 E at WADE');
  // A dedicated direction field is a confident heading, as for Ontario 511.
  assert.equal(east.headingDeg, 90);
  assert.equal(east.headingConfidence, 'high');
  assert.equal(east.pitchDeg, -24);
  // Without one, the code's side letter stands in at low confidence, and the
  // first enabled view is the frame.
  assert.equal(west.url, 'https://www.drivenc.gov/map/Cctv/4302');
  assert.equal(west.headingDeg, 270);
  assert.equal(west.headingConfidence, 'low');
  // The records go to the browser through /api/cctv; the key must stay on
  // the server-side catalog request.
  assert.doesNotMatch(JSON.stringify(cameras), /test-key/);
  assert.doesNotMatch(lines.join('\n'), /test-key/);
});

for (const status of [400, 401, 403]) {
  test(`a ${status} from the keyed API names the key, never its value, and the keyless catalog loads instead`, async (t) => {
    const lines = captureConsole(t);
    const requested = routeFetch(t, {
      api: () => Response.json({ Message: 'Invalid Key' }, { status }),
    });
    const cameras = await loadDriveNcSourcesFromOpenData(
      {},
      { DRIVENC_API_KEY: 'secret-key-value', CCTV_DRIVENC_MAX_SOURCES: '8' },
    );
    assert.equal(cameras.length, 8);
    assert.equal(requested[1], DRIVENC_MAP_ICONS_URL);
    assert.match(
      lines.join('\n'),
      new RegExp(
        `API download failed: ${status} \\(check DRIVENC_API_KEY\\); using the keyless catalog`,
      ),
    );
    assert.doesNotMatch(lines.join('\n'), /secret-key-value/);
    assert.doesNotMatch(requested.slice(1).join('\n'), /secret-key-value/);
  });
}

test('a keyed API outage is reported without blaming the key, and the keyless catalog loads instead', async (t) => {
  const lines = captureConsole(t);
  routeFetch(t, { api: () => new Response('', { status: 503 }) });
  const cameras = await loadDriveNcSourcesFromOpenData(
    {},
    { DRIVENC_API_KEY: 'secret-key-value', CCTV_DRIVENC_MAX_SOURCES: '8' },
  );
  assert.equal(cameras.length, 8);
  assert.match(
    lines.join('\n'),
    /API download failed: 503; using the keyless catalog/,
  );
  assert.doesNotMatch(lines.join('\n'), /check DRIVENC_API_KEY/);
  assert.doesNotMatch(lines.join('\n'), /secret-key-value/);
});

test('the CCTV catalog merges DriveNC cameras only with CCTV_DRIVENC_ENABLED=1', async (t) => {
  captureConsole(t);
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-cctv-drivenc-'),
  );
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  withEnv(t, {
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_PREFER_AUSTIN: undefined,
    CCTV_MAX_SOURCES: undefined,
    CCTV_CALTRANS_DISTRICTS: undefined,
    CCTV_DRIVENC_ENABLED: undefined,
    CCTV_DRIVENC_MAX_SOURCES: undefined,
    DRIVENC_API_KEY: undefined,
  });
  // Every other live pack is down; only DriveNC answers.
  const requested = routeFetch(t, {
    icons: mapIcons([['5413', ...near(RALEIGH, 0.001)]]),
  });

  // Off by default: DriveNC states no reuse terms, so an unset flag never
  // reaches the upstream.
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.some((href) => href.startsWith('https://www.drivenc.gov/')),
    false,
    'an unset flag makes no DriveNC request',
  );

  process.env.CCTV_DRIVENC_ENABLED = '1';
  requested.length = 0;
  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['nc-5413'],
  );
  assert.equal(sources[0].url, 'https://www.drivenc.gov/map/Cctv/5413');
  assert.equal(sources[0].pack, 'drivenc');
  assert.equal(sources[0].code, 'CCTV04-I40-311E_NC54');

  // Anything but "1" keeps it off, including the old kill-switch value.
  for (const value of ['0', 'true', 'yes']) {
    process.env.CCTV_DRIVENC_ENABLED = value;
    requested.length = 0;
    assert.deepEqual(await createCctvCatalog({ sourceRoot })(), [], value);
    assert.equal(
      requested.includes(DRIVENC_MAP_ICONS_URL),
      false,
      `CCTV_DRIVENC_ENABLED=${value} makes no request`,
    );
  }
});

test('a view id that would normalize out of the still directory registers no camera', async (t) => {
  captureConsole(t);
  routeFetch(t, {
    tooltips: {
      5413: tooltipHtml('5413', TOOLTIP_CODES[5413], '..'),
      5464: tooltipHtml('5464', TOOLTIP_CODES[5464], '.'),
    },
  });
  const keyless = await loadDriveNcSourcesFromOpenData(
    {},
    { CCTV_DRIVENC_MAX_SOURCES: '8' },
  );
  const ids = keyless.map((camera) => camera.id);
  assert.equal(ids.includes('nc-5413'), false);
  assert.equal(ids.includes('nc-5464'), false);
  assert.equal(keyless.length, 6);
  for (const camera of keyless) {
    assert.match(camera.url, /^https:\/\/www\.drivenc\.gov\/map\/Cctv\/[^/]+$/);
  }

  t.mock.restoreAll();
  captureConsole(t);
  routeFetch(t, {
    api: () =>
      Response.json([
        {
          ...API_ROW,
          Views: [
            { Status: 'Enabled', Url: 'https://www.drivenc.gov/map/Cctv/..' },
          ],
        },
        { ...API_ROW, Id: 43 },
      ]),
  });
  const keyed = await loadDriveNcSourcesFromOpenData(
    {},
    { DRIVENC_API_KEY: 'k', CCTV_DRIVENC_MAX_SOURCES: '8' },
  );
  assert.deepEqual(
    keyed.map((camera) => camera.id),
    ['nc-43'],
  );
});
