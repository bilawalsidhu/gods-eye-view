import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  hkoRadarProxy,
  parseHkoRadarKml,
  hkoRadarFrameName,
  hkoRadarFrameTime,
} from '../../server/providers/hkoRadar.js';
import {
  validateHkoRadarSnapshot,
  hkoRadarFrameUrl,
} from '../layers/hkoRadar/source.js';

const EXTENT = Object.freeze({
  north: 23.44966,
  south: 21.14752,
  east: 115.41589,
  west: 112.92745,
});

function overlay(name, extent = EXTENT) {
  return `<GroundOverlay>
    <name>Case</name>
    <Icon><href>${name}</href></Icon>
    <LatLonBox>
      <north>${extent.north}</north>
      <south>${extent.south}</south>
      <east>${extent.east}</east>
      <west>${extent.west}</west>
    </LatLonBox>
  </GroundOverlay>`;
}

function kml(names) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Folder>
${names.map((name) => overlay(name)).join('\n')}
</Folder></kml>`;
}

function png(length = 64) {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
}

function install(options = {}) {
  let handler;
  const plugin = hkoRadarProxy(options);
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/hko-radar');
        handler = callback;
      },
    },
  });
  return (url, method = 'GET') => {
    const res = new EventEmitter();
    res.headers = {};
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    return handler({ url, method }, res).then(() => res);
  };
}

test('parses GroundOverlay frames and rejects non-128 hrefs', () => {
  const parsed = parseHkoRadarKml(
    kml([
      'resources/hkologo.png',
      '../escape_rad_128.png',
      '20261011005401_rad_128.png',
      'https://evil.example/20261011010001_rad_128.png',
      '20261011010001_rad_256.png',
      '20261011010601_rad_128.png',
    ]),
  );
  assert.equal(parsed.product, 'radar-128');
  assert.deepEqual(parsed.extent, EXTENT);
  assert.deepEqual(
    parsed.frames.map((f) => f.href),
    ['20261011005401_rad_128.png', '20261011010601_rad_128.png'],
  );
  assert.equal(parsed.latest, '2026-10-11T01:06:01.000Z');
  assert.match(parsed.attribution, /Hong Kong Observatory/);
});

test('rejects entity expansion, empty overlays, and mismatched extents', () => {
  assert.throws(() => parseHkoRadarKml('<!DOCTYPE kml [<!ENTITY x "y">]>'), {
    code: 'invalid_hko_radar_kml',
  });
  assert.throws(() => parseHkoRadarKml('<kml><Folder></Folder></kml>'), {
    code: 'invalid_hko_radar_kml',
  });
  assert.throws(
    () =>
      parseHkoRadarKml(`<?xml version="1.0"?><kml><Folder>
${overlay('20261011005401_rad_128.png')}
${overlay('20261011010601_rad_128.png', { ...EXTENT, north: 23.5 })}
</Folder></kml>`),
    { code: 'invalid_hko_radar_kml' },
  );
});

test('frame name pin and time decode', () => {
  assert.equal(hkoRadarFrameName('20261011005401_rad_128.png'), '20261011005401_rad_128.png');
  assert.equal(hkoRadarFrameName('../20261011005401_rad_128.png'), null);
  assert.equal(hkoRadarFrameName('20261011005401_rad_256.png'), null);
  assert.equal(
    hkoRadarFrameTime('20261011005401_rad_128.png'),
    '2026-10-11T00:54:01.000Z',
  );
  assert.equal(hkoRadarFrameUrl('20261011005401_rad_128.png'), '/api/hko-radar/frame?name=20261011005401_rad_128.png');
});

test('manifest and frame routes pin the HKO origin', async () => {
  const names = ['20261011005401_rad_128.png', '20261011010601_rad_128.png'];
  const calls = [];
  const request = install({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('.kml'))
        return new Response(kml(names), {
          headers: { 'Content-Type': 'application/xml' },
        });
      return new Response(png(), {
        headers: { 'Content-Type': 'image/png' },
      });
    },
  });
  const manifestRes = await request('/');
  assert.equal(manifestRes.statusCode, 200);
  const manifest = JSON.parse(manifestRes.body);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'radar-128');
  assert.equal(manifest.frames.length, 2);
  assert.equal(
    manifest.frames[0].url,
    '/api/hko-radar/frame?name=20261011005401_rad_128.png',
  );
  assert.equal(manifest.latest, '2026-10-11T01:06:01.000Z');
  validateHkoRadarSnapshot(manifest);
  assert.ok(
    calls[0].url.startsWith(
      'https://www.hko.gov.hk/wxinfo/radars/R4_GIS_rad_128/',
    ),
  );
  assert.equal(calls[0].options.redirect, 'manual');

  const bad = await request('/frame?name=../secret.png');
  assert.equal(bad.statusCode, 400);

  const frame = await request('/frame?name=20261011010601_rad_128.png');
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['Content-Type'], 'image/png');
  assert.ok(
    calls.some((call) =>
      call.url.endsWith('/20261011010601_rad_128.png'),
    ),
  );
});

test('client validator rejects foreign frame URLs', () => {
  assert.throws(() =>
    validateHkoRadarSnapshot({
      schemaVersion: 1,
      product: 'radar-128',
      extent: EXTENT,
      frames: [
        {
          time: '2026-10-11T00:54:01.000Z',
          href: '20261011005401_rad_128.png',
          url: 'https://evil.example/x.png',
        },
      ],
      latest: '2026-10-11T00:54:01.000Z',
      attribution: 'Hong Kong Observatory / DATA.GOV.HK',
    }),
  );
});
