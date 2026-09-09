import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledCuratedSources } from '../../vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCOTLAND_PACK = path.resolve(here, '../../config/cctv_sources.scotland.curated.json');

test('the bundled Scotland pack is well-formed: unique ids, https stills, Scottish coordinates, bounded cadence', () => {
  const pack = JSON.parse(fs.readFileSync(SCOTLAND_PACK, 'utf8'));
  assert.ok(Array.isArray(pack) && pack.length >= 40, 'pack should hold the 23 PKC + 22 mountain cameras');
  const ids = new Set();
  for (const camera of pack) {
    assert.ok(camera.id && !ids.has(camera.id), `duplicate or missing id: ${camera.id}`);
    ids.add(camera.id);
    assert.match(camera.url, /^https:\/\//, `${camera.id} must use https`);
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.feedType, 'image');
    assert.ok(camera.lat > 54.5 && camera.lat < 61 && camera.lon > -8.5 && camera.lon < -0.5, `${camera.id} is outside Scotland`);
    assert.ok(camera.frameRefreshMs >= 60_000 && camera.frameRefreshMs <= 20 * 60_000, `${camera.id} cadence out of client bounds`);
    assert.ok(camera.provider && camera.license && camera.city, `${camera.id} needs provider, license, city`);
    assert.ok(['pkc-council', 'mountain-webcam'].includes(camera.sourceKind), `${camera.id} unexpected sourceKind`);
    if (camera.poseSource === 'curated') {
      assert.ok(Number.isFinite(camera.headingDeg), `${camera.id} claims a curated pose without a heading`);
      assert.notEqual(camera.headingConfidence, 'low', `${camera.id} curated pose cannot be low confidence`);
    }
  }
  const pkc = pack.filter((camera) => camera.sourceKind === 'pkc-council');
  assert.equal(pkc.length, 23);
  assert.ok(pkc.every((camera) => camera.url.startsWith('https://localapps.pkc.gov.uk/RoadsCameraImages/images/')));
  assert.ok(pkc.every((camera) => camera.frameRefreshMs === 900_000), 'PKC publishes every 15 minutes');
  // Directional council cameras take their heading from the caption burned into the frame.
  const east = pkc.find((camera) => camera.id === 'pkc-474-cam1');
  assert.equal(east.headingDeg, 90);
  assert.equal(east.poseSource, 'curated');
  const amulree = pkc.find((camera) => camera.id === 'pkc-484-cam1');
  assert.equal(amulree.headingDeg, undefined, 'a camera with no stated facing keeps the id-hash prior');
  assert.equal(amulree.poseSource, undefined);
});

test('loadBundledCuratedSources loads the shipped packs and drops malformed entries', () => {
  const shipped = loadBundledCuratedSources({ env: {} });
  assert.ok(shipped.length >= 40);
  assert.ok(shipped.some((camera) => camera.id === 'cgm-base-station'));
  assert.ok(shipped.some((camera) => camera.id === 'pkc-475-cam2'));

  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gev-cctv-pack-')), 'pack.json');
  fs.writeFileSync(tmp, JSON.stringify([
    { id: 'ok-1', url: 'https://example.com/a.jpg', lat: 56.1, lon: -3.2 },
    { id: '', url: 'https://example.com/b.jpg', lat: 56.1, lon: -3.2 },
    { id: 'no-url', lat: 56.1, lon: -3.2 },
    { id: 'bad-scheme', url: 'ftp://example.com/c.jpg', lat: 56.1, lon: -3.2 },
    { id: 'no-coords', url: 'https://example.com/d.jpg', lat: 'x', lon: null },
    null,
    'garbage',
  ]));
  const filtered = loadBundledCuratedSources({ files: [tmp], env: {} });
  assert.deepEqual(filtered.map((camera) => camera.id), ['ok-1']);
});

test('loadBundledCuratedSources honours the kill switch and survives missing or non-array files', () => {
  assert.deepEqual(loadBundledCuratedSources({ env: { CCTV_BUNDLED_PACKS_ENABLED: '0' } }), []);
  assert.deepEqual(loadBundledCuratedSources({ files: ['/nonexistent/pack.json'], env: {} }), []);
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gev-cctv-pack-')), 'obj.json');
  fs.writeFileSync(tmp, JSON.stringify({ sources: [] }));
  assert.deepEqual(loadBundledCuratedSources({ files: [tmp], env: {} }), []);
});
