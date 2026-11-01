import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';

test('MP4 and TS routes enforce proxy-compatible same-site admission and session/lease checks', async (t) => {
  const keys = ['CCTV_SOURCES_FILE', 'CCTV_SOURCES_JSON', 'CCTV_FORCE_AUSTIN'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-hls-routes-'));
  const server = new EventEmitter();
  t.after(() => {
    server.emit('close');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  delete process.env.CCTV_SOURCES_FILE;
  delete process.env.CCTV_FORCE_AUSTIN;
  process.env.CCTV_SOURCES_JSON = JSON.stringify(
    ['mp4', 'ts'].map((id) => ({
      id,
      name: 'Synthetic ' + id,
      lat: -27.5,
      lon: -55.9,
      feedType: 'hls',
      url: 'https://camera.example/' + id + '/index.m3u8',
    })),
  );
  const requests = [];
  let pendingInit;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    if (pendingInit && url.endsWith('/init.mp4')) {
      pendingInit.started.resolve(options.signal);
      return pendingInit.response.promise;
    }
    if (url.endsWith('/mp4/index.m3u8'))
      return new Response(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' +
          '#EXTINF:5,\na.mp4\n#EXTINF:5,\nb.mp4\n',
      );
    if (url.endsWith('/ts/index.m3u8'))
      return new Response('#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n');
    return new Response(url.endsWith('/init.mp4') ? 'init' : 'abc');
  });
  let middleware;
  cctvProxy({ sourceRoot: root }).configureServer({
    httpServer: server,
    middlewares: {
      use(prefix, handler) {
        assert.equal(prefix, '/api/cctv');
        middleware = handler;
      },
    },
  });
  const request = async (
    url,
    method = 'GET',
    peer = '192.0.2.1',
    headers = {},
    onResponse = () => {},
  ) => {
    const response = new EventEmitter();
    response.headers = {};
    response.setHeader = (key, value) => {
      response.headers[key] = value;
    };
    response.writeHead = (status, headers = {}) => {
      response.status = status;
      response.headers = headers;
    };
    response.end = (body) => {
      response.body = body;
      response.writableEnded = true;
      response.emit('finish');
    };
    onResponse(response);
    await middleware(
      {
        url,
        method,
        headers: { host: 'localhost:4173', ...headers },
        socket: { remoteAddress: peer },
      },
      response,
    );
    response.status ??= response.statusCode;
    return response;
  };
  const lease = '11111111-1111-4111-8111-111111111111';
  const result = await request('/media/mp4?lease=' + lease);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'application/vnd.apple.mpegurl');
  const playlist = String(result.body);
  const initUrl = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)[1];
  const segmentUrl = playlist.split('\n').find((line) => line.includes('seg_'));
  const local = (url) => url.replace('/api/cctv', '');
  for (const url of [initUrl, segmentUrl]) {
    const asset = await request(local(url), 'GET', '::ffff:192.0.2.1', {
      'sec-fetch-site': 'same-origin',
      range: 'bytes=0-',
    });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['Content-Type'], 'video/mp4');
  }
  const reads = requests.length;
  // Reverse proxies may change the direct socket address between requests.
  // Session and lease tokens remain the capability; forwarded values are not identities.
  for (const headers of [
    { 'x-forwarded-for': '192.0.2.1' },
    { forwarded: 'for=192.0.2.1;proto=https' },
    { 'x-forwarded-proto': 'https', origin: 'https://localhost:4173' },
  ]) {
    const proxyHeaders = { 'sec-fetch-site': 'same-origin', ...headers };
    assert.equal(
      (
        await request(
          '/media/mp4?lease=' + lease,
          'GET',
          '192.0.2.2',
          proxyHeaders,
        )
      ).status,
      200,
    );
    for (const url of [initUrl, segmentUrl]) {
      assert.equal(
        (await request(local(url), 'GET', '192.0.2.2', proxyHeaders)).status,
        200,
      );
      assert.equal(
        (
          await request(
            local(url).replace(lease, '33333333-3333-4333-8333-333333333333'),
            'GET',
            '192.0.2.2',
            proxyHeaders,
          )
        ).status,
        404,
      );
    }
  }
  assert.equal(
    requests.length,
    reads,
    'proxy reads and renewals share the existing pull',
  );

  for (const headers of [
    { origin: 'https://foreign.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '192.0.2.1' },
    { origin: 'https://foreign.example', 'x-forwarded-proto': 'https' },
  ]) {
    for (const [method, url] of [
      ['GET', '/media/mp4?lease=' + lease],
      ['DELETE', '/media/mp4?lease=' + lease],
      ['GET', local(initUrl)],
      ['GET', local(segmentUrl)],
    ])
      assert.equal(
        (await request(url, method, '192.0.2.1', headers)).status,
        403,
      );
  }
  assert.equal((await request(local(initUrl))).status, 200);
  assert.equal(requests.length, reads);
  const otherLease = '22222222-2222-4222-8222-222222222222';
  const other = await request(
    '/media/mp4?lease=' + otherLease,
    'GET',
    '192.0.2.2',
  );
  assert.equal(other.status, 200);
  assert.equal(
    other.headers['X-CCTV-Session'],
    result.headers['X-CCTV-Session'],
  );
  assert.equal(requests.length, reads, 'another consumer reuses the same pull');
  const invalid = [
    local(segmentUrl).replace('.mp4', '.ts'),
    local(initUrl).replace('init_0.mp4', 'init_999.mp4'),
    local(initUrl).replace(/session=[^&]+/, 'session=wrong'),
    '/media/mp4/../init.mp4?lease=' + lease,
  ];
  for (const url of invalid) assert.equal((await request(url)).status, 404);
  assert.equal(requests.length, reads);
  assert.equal(
    (await request('/media/mp4?lease=' + lease, 'DELETE')).status,
    204,
  );
  assert.equal((await request(local(initUrl))).status, 404);
  const otherInit = local(initUrl).replace(lease, otherLease);
  assert.equal((await request(otherInit, 'GET', '192.0.2.2')).status, 200);
  await request('/media/mp4?lease=' + otherLease, 'DELETE', '192.0.2.2', {
    'x-forwarded-for': '192.0.2.9',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal((await request(otherInit, 'GET', '192.0.2.2')).status, 404);
  assert.equal(requests.length, reads);
  const ts = await request('/media/ts?lease=' + lease);
  assert.equal(ts.status, 200);
  const tsUrl = String(ts.body)
    .split('\n')
    .find((line) => line.includes('seg_'));
  const tsAsset = await request(local(tsUrl));
  assert.equal(tsAsset.status, 200);
  assert.equal(tsAsset.headers['Content-Type'], 'video/mp2t');
  assert.equal(
    (
      await request(local(tsUrl), 'GET', '192.0.2.2', {
        'x-forwarded-for': '192.0.2.9',
      })
    ).status,
    200,
  );
  await request(
    '/media/ts?lease=33333333-3333-4333-8333-333333333333',
    'DELETE',
    '192.0.2.2',
  );
  assert.equal((await request(local(tsUrl))).status, 200);

  pendingInit = {
    started: Promise.withResolvers(),
    response: Promise.withResolvers(),
  };
  let disconnected;
  const opening = request(
    '/media/mp4?lease=' + lease,
    'GET',
    '192.0.2.1',
    {},
    (res) => {
      disconnected = res;
    },
  );
  const signal = await pendingInit.started.promise;
  disconnected.emit('close');
  assert.equal(
    signal.aborted,
    true,
    'disconnect releases the pending consumer lease',
  );
  pendingInit.response.resolve(new Response('late init'));
  await opening;
  assert.equal(
    disconnected.status,
    undefined,
    'no write after the consumer leaves',
  );
  pendingInit = null;
  const reopened = await request('/media/mp4?lease=' + lease);
  assert.equal(
    reopened.status,
    200,
    'the disconnected session slot was reclaimed',
  );
  assert.notEqual(
    reopened.headers['X-CCTV-Session'],
    result.headers['X-CCTV-Session'],
  );
  assert.equal((await request(local(initUrl))).status, 404);
  assert.equal(
    (await request(local(tsUrl))).status,
    200,
    'the other camera is undisturbed',
  );
  server.emit('close');
  assert.equal((await request(local(tsUrl))).status, 404);
});
