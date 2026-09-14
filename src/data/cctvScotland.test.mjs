import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPkcSourcesFromCatalog,
  loadScotlandWebcamSourcesFromCatalog,
} from '../../server/providers/cctv/sources.js';
import { staticFrameRefreshMs } from './cctvLod.js';

const SCOTLAND = { south: 54.5, north: 61, west: -8.5, east: -0.5 };
const inScotland = (camera) =>
  camera.lat > SCOTLAND.south &&
  camera.lat < SCOTLAND.north &&
  camera.lon > SCOTLAND.west &&
  camera.lon < SCOTLAND.east;

test('Perth & Kinross catalog registers 23 council cameras on the council host only', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadPkcSourcesFromCatalog();
  assert.equal(cameras.length, 23);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 23);
  for (const camera of cameras) {
    assert.match(
      camera.url,
      /^https:\/\/localapps\.pkc\.gov\.uk\/RoadsCameraImages\/images\/[0-9]+_cam[0-9]\.jpg$/,
      camera.url,
    );
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.sourceKind, 'council-road-camera');
    assert.equal(camera.provider, 'Perth & Kinross Council');
    assert.equal(camera.cityId, 'perth-kinross');
    assert.ok(inScotland(camera), `${camera.id} is outside Scotland`);
    assert.match(camera.license, /^Public council road camera data/);
    if (camera.poseSource === 'curated') {
      assert.ok(
        [0, 90, 180, 270].includes(camera.headingDeg),
        `${camera.id}: a curated council heading comes from a cardinal caption`,
      );
      assert.equal(camera.headingConfidence, 'high');
    }
  }
  // Directional cameras take their facing from the caption burned into the frame.
  const east = cameras.find((camera) => camera.id === 'pkc-474-cam1');
  assert.equal(east.name, 'A90 Starr Farm (East)');
  assert.equal(east.headingDeg, 90);
  assert.equal(east.poseSource, 'curated');
  // A camera with no stated facing keeps the id-hash prior and no curated claim.
  const amulree = cameras.find((camera) => camera.id === 'pkc-484-cam1');
  assert.ok(Number.isFinite(amulree.headingDeg), 'id-hash heading prior');
  assert.equal(amulree.headingDeg % 22.5, 0, 'a 16-point compass prior');
  assert.equal(amulree.headingConfidence, 'low');
  assert.equal(amulree.poseSource, undefined);
});

test('Scottish webcam catalog registers 22 cameras on registered operator hosts only', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadScotlandWebcamSourcesFromCatalog();
  assert.equal(cameras.length, 22);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 22);
  const hosts = new Set();
  for (const camera of cameras) {
    assert.match(camera.url, /^https:\/\//, camera.url);
    hosts.add(new URL(camera.url).host);
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.sourceKind, 'mountain-webcam');
    assert.equal(camera.cityId, 'scotland');
    assert.ok(inScotland(camera), `${camera.id} is outside Scotland`);
    assert.ok(
      camera.provider && camera.license,
      `${camera.id} needs provider and license`,
    );
    assert.ok(
      Number.isFinite(camera.headingDeg),
      `${camera.id} needs a heading prior`,
    );
    if (camera.poseSource === 'curated') {
      assert.notEqual(
        camera.headingConfidence,
        'low',
        `${camera.id}: curated pose cannot be low confidence`,
      );
    }
  }
  assert.deepEqual([...hosts].sort(), [
    'ah.cdn.licr.co.uk',
    'www.cairngormmountain.co.uk',
    'www.deesideglidingclub.co.uk',
    'www.webcam-hd.com',
    'www.winterhighland.info',
  ]);
  // Every operator in the pack has a stated ambient refresh cadence.
  const cadences = {
    'Cairngorm Mountain': 120_000,
    'Glencoe Mountain Resort': 300_000,
    'Glenshee Ski Centre': 300_000,
    'Deeside Gliding Club': 300_000,
    'About Fort William': 300_000,
    Winterhighland: 300_000,
  };
  assert.deepEqual(
    [...new Set(cameras.map((camera) => camera.provider))].sort(),
    Object.keys(cadences).sort(),
  );
  for (const [provider, expected] of Object.entries(cadences)) {
    assert.equal(staticFrameRefreshMs({ provider }), expected, provider);
  }
  assert.equal(
    staticFrameRefreshMs({ provider: 'Perth & Kinross Council' }),
    900_000,
  );
});

test('Scottish catalog loaders tolerate a missing catalog file', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(
    loadPkcSourcesFromCatalog({ sourceRoot: '/nonexistent' }),
    [],
  );
  assert.deepEqual(
    loadScotlandWebcamSourcesFromCatalog({ sourceRoot: '/nonexistent' }),
    [],
  );
});

test('Scottish catalog loaders skip malformed, off-host, and duplicate rows without throwing', (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-scotland-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const ok = 'https://localapps.pkc.gov.uk/RoadsCameraImages/images/1_cam1.jpg';
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.pkc.json'),
    JSON.stringify([
      { id: { toString: null }, url: ok, lat: 56.4, lon: -3.4 },
      { id: 'ok', url: ok, lat: 56.4, lon: -3.4 },
      { id: 'ok', url: ok, lat: 56.5, lon: -3.5 },
      { id: 'text-coords', url: ok, lat: '56.4', lon: '-3.4' },
      { id: 'null-island', url: ok, lat: 0, lon: 0 },
      {
        id: 'off-host',
        url: 'https://evil.example/1_cam1.jpg',
        lat: 56.4,
        lon: -3.4,
      },
      {
        id: 'http-only',
        url: 'http://localapps.pkc.gov.uk/RoadsCameraImages/images/1_cam1.jpg',
        lat: 56.4,
        lon: -3.4,
      },
      null,
      'garbage',
    ]),
  );
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.scotland_webcams.json'),
    JSON.stringify({ sources: [] }),
  );
  assert.deepEqual(
    loadPkcSourcesFromCatalog({ sourceRoot: dir }).map((camera) => camera.id),
    ['ok'],
  );
  assert.deepEqual(
    loadScotlandWebcamSourcesFromCatalog({ sourceRoot: dir }),
    [],
  );
});
