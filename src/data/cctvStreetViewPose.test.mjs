// When a catalog camera has no pose, the browser sends /frame a heading derived
// from the camera ID, a pitch of -17°, and a field of view of 74°. Street View
// uses that pose at the camera's catalog coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cctvProxy } from '../../server/providers/cctv.js';

// Same shape as a world-cameras row: an image URL, position, and no
// headingDeg / pitchDeg / fovDeg.
const POSELESS = {
  id: 'world-or-fixture',
  name: 'Pose-less fixture',
  lat: 44.05,
  lon: -123.09,
  feedType: 'image',
  url: 'https://cams.upstream.invalid/still.jpg',
};

/** The browser's id-hash heading (src/layers/cctv/model.js headingFromId). */
function browserHeadingFromId(id) {
  let acc = 0;
  for (let i = 0; i < id.length; i++) acc = (acc * 33 + id.charCodeAt(i)) >>> 0;
  return ((((acc % 16) * 22.5) % 360) + 360) % 360;
}

function response({ status = 200, headers = {}, body = '' }) {
  return new Response(status === 204 ? null : String(body), {
    status,
    headers,
  });
}

function recording() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

test('the Street View fallback frames a pose-less catalog camera the way the browser draws it', async (t) => {
  const saved = Object.fromEntries(
    [
      'CCTV_SOURCES_JSON',
      'CCTV_SOURCES_FILE',
      'CCTV_FORCE_AUSTIN',
      'GOOGLE_MAPS_SERVER_API_KEY',
      'GOOGLE_MAPS_API_KEY',
      'GEV_RATELIMIT_GOOGLE_PER_MIN',
    ].map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify([POSELESS]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-key';
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  const nativeFetch = globalThis.fetch;
  const streetView = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://maps.googleapis.com/')) {
      streetView.push(new URL(href));
      return response({
        headers: { 'content-type': 'image/jpeg' },
        body: 'street-view',
      });
    }
    return response({ status: 503 }); // the camera's upstream is down
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let handler;
  cctvProxy().configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });

  // What src/layers/cctv/source.js sends for this camera with no calibration.
  const heading = Math.round(browserHeadingFromId(POSELESS.id));
  const params = new URLSearchParams({
    label: POSELESS.name,
    city: '',
    lat: POSELESS.lat.toFixed(6),
    lon: POSELESS.lon.toFixed(6),
    heading: String(heading),
    fov: '74',
    pitch: '-17',
    ts: '1',
  });
  const { res, done } = recording();
  await handler(
    {
      url: `/frame/${POSELESS.id}?${params}`,
      headers: {},
      method: 'GET',
      on() {},
    },
    res,
  );
  await done;

  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
  assert.equal(streetView.length, 1);
  const sv = streetView[0].searchParams;
  assert.equal(sv.get('location'), `${POSELESS.lat},${POSELESS.lon}`);
  assert.equal(Number(sv.get('heading')), heading, 'heading the browser draws');
  assert.equal(Number(sv.get('fov')), 74, 'FOV the browser draws');
  assert.equal(Number(sv.get('pitch')), -17, 'pitch the browser draws');
});
