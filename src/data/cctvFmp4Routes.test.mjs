import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';

test('MP4 routes enforce session and lease checks', async (t) => {
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
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
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
  const request = async (url, method = 'GET') => {
    const response = new EventEmitter();
    response.writeHead = (status, headers = {}) => {
      response.status = status;
      response.headers = headers;
    };
    response.end = (body) => {
      response.body = body;
      response.writableEnded = true;
      response.emit('finish');
    };
    await middleware({ url, method, headers: {} }, response);
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
    const asset = await request(local(url));
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['Content-Type'], 'video/mp4');
  }
  const reads = requests.length;
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
  assert.equal(requests.length, reads);
  const ts = await request('/media/ts?lease=' + lease);
  assert.equal(ts.status, 200);
  const tsUrl = String(ts.body)
    .split('\n')
    .find((line) => line.includes('seg_'));
  const tsAsset = await request(local(tsUrl));
  assert.equal(tsAsset.status, 200);
  assert.equal(tsAsset.headers['Content-Type'], 'video/mp2t');
});
