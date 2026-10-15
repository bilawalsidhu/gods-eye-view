import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createVaritechSnapshotFetcher,
  loadVaritechSourcesFromCatalog,
} from '../../server/providers/cctv/varitech.js';

const URL = 'https://varitech.ar/cameras/cam003/latest.jpg';
const jpeg = () =>
  new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
    headers: { 'Content-Type': 'image/jpeg' },
  });

test('Varitech labels resort references and estimated headings honestly', () => {
  const cameras = loadVaritechSourcesFromCatalog();
  assert.equal(cameras.length, 11);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 11);
  for (const camera of cameras) {
    assert.match(camera.name, /\(approx\. location\)$/);
    assert.match(camera.credit, /5-minute snapshots/);
    assert.equal(camera.headingConfidence, 'low');
    assert.equal(camera.poseSource, undefined);
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.url, camera.snapshotUrl);
    assert.match(
      camera.url,
      /^https:\/\/varitech\.ar\/cameras\/cam\d{3}\/latest\.jpg$/,
    );
  }
});

test('Varitech rejects malformed coordinates and IDs and ignores supplied URLs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-varitech-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config/cctv_sources.varitech.json');
  const valid = {
    id: 'cam003',
    name: 'Plaza Catalina Reynal',
    center: 'catedral',
    lat: -41.167,
    lon: -71.443,
  };
  fs.writeFileSync(
    file,
    JSON.stringify([
      null,
      { ...valid, id: 'cam999' },
      { ...valid, lat: null },
      { ...valid, lat: '-41.167' },
      { ...valid, lon: 0 },
      { ...valid, center: '__proto__' },
      {
        ...valid,
        url: 'https://evil.example/frame.jpg',
        snapshotUrl: 'http://127.0.0.1/',
      },
      valid,
    ]),
  );
  const cameras = loadVaritechSourcesFromCatalog({ sourceRoot: root });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].url, URL);
  assert.equal(cameras[0].snapshotUrl, URL);
  fs.writeFileSync(file, '{');
  assert.deepEqual(loadVaritechSourcesFromCatalog({ sourceRoot: root }), []);
  fs.writeFileSync(file, '{}');
  assert.deepEqual(loadVaritechSourcesFromCatalog({ sourceRoot: root }), []);
  assert.deepEqual(
    loadVaritechSourcesFromCatalog({ sourceRoot: path.join(root, 'missing') }),
    [],
  );
});

test('Varitech fetches on demand, shares concurrent requests and expires at five minutes', async () => {
  let time = 0;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const read = createVaritechSnapshotFetcher({
    now: () => time,
    fetchImpl: async () => {
      calls++;
      await gate;
      return jpeg();
    },
  });
  assert.equal(calls, 0);
  const first = read(URL);
  const second = read(URL);
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(a, b);
  time = 299999;
  assert.equal(await read(URL), a);
  assert.equal(calls, 1);
  time = 300000;
  assert.equal((await read(URL)).ok, true);
  assert.equal(calls, 2);
});

test('Varitech fails closed outside its exact public JPEG allowlist', async () => {
  let calls = 0;
  const read = createVaritechSnapshotFetcher({
    fetchImpl: async () => {
      calls++;
      return jpeg();
    },
  });
  for (const url of [
    'https://varitech.ar.evil.example/cameras/cam003/latest.jpg',
    'https://varitech.ar/cameras/cam999/latest.jpg',
    URL + '?redirect=http://127.0.0.1',
    URL.replace('https:', 'http:'),
    '***varitech.ar/cameras/cam003/latest.jpg',
  ])
    assert.equal(await read(url), null);
  assert.equal(calls, 0);
});

test('Varitech expires failed refreshes without retaining a previous image', async () => {
  let time = 0;
  let calls = 0;
  const read = createVaritechSnapshotFetcher({
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return calls === 2 ? new Response('offline', { status: 503 }) : jpeg();
    },
  });
  assert.equal((await read(URL)).ok, true);
  time = 300000;
  assert.equal(await read(URL), null);
  time = 329999;
  assert.equal(await read(URL), null);
  assert.equal(calls, 2);
  time = 330000;
  assert.equal((await read(URL)).ok, true);
  assert.equal(calls, 3);
});

test('Varitech rejects non-JPEG and oversized snapshots', async () => {
  for (const response of [
    new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('oversized', {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(2 * 1024 * 1024 + 1),
      },
    }),
  ]) {
    const read = createVaritechSnapshotFetcher({
      fetchImpl: async () => response,
    });
    assert.equal(await read(URL), null);
  }
});

test('separate Varitech proxy instances do not share cached frames', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jpeg();
  };
  const a = createVaritechSnapshotFetcher({ fetchImpl });
  const b = createVaritechSnapshotFetcher({ fetchImpl });
  await a(URL);
  await b(URL);
  assert.equal(calls, 2);
});
