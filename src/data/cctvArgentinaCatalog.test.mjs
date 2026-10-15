import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = read('../../config/cctv_sources.argentina.json');
const survey = read('../../docs/data/cctv-argentina-survey-2026-10-15.json');
const mediaUrl = (camera) => camera.embedUrl || camera.url;

test('Argentina sources have unique public media and uncalibrated area anchors', () => {
  assert.equal(new Set(catalog.map((c) => c.id)).size, catalog.length);
  assert.equal(new Set(catalog.map(mediaUrl)).size, catalog.length);
  for (const camera of catalog) {
    assert.match(camera.id, /^[a-z0-9-]+$/);
    assert.match(camera.cityId, /^[a-z0-9-]+$/);
    assert.equal(camera.country, 'AR');
    assert.ok(
      Number.isFinite(camera.lat) && camera.lat >= -56 && camera.lat <= -21,
      camera.id,
    );
    assert.ok(
      Number.isFinite(camera.lon) && camera.lon >= -74 && camera.lon <= -53,
      camera.id,
    );
    for (const key of [
      'name',
      'city',
      'province',
      'provider',
      'credit',
      'license',
      'locationNote',
    ]) {
      assert.ok(
        typeof camera[key] === 'string' && camera[key].trim(),
        `${camera.id}: ${key}`,
      );
    }
    for (const value of [
      mediaUrl(camera),
      camera.sourcePageUrl,
      camera.locationSourceUrl,
    ]) {
      const url = new URL(value);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username + url.password + url.hash, '');
      for (const key of url.searchParams.keys())
        assert.ok(['v', 'alias'].includes(key), key);
    }
    assert.equal(camera.headingConfidence, 'low');
    for (const key of [
      'headingDeg',
      'pitchDeg',
      'fovDeg',
      'rangeM',
      'mountHeightM',
      'poseSource',
    ]) {
      assert.equal(
        camera[key],
        undefined,
        `${camera.id} must not assert a pose`,
      );
    }
  }
});

test('Argentina types use supported URL contracts and normalize direct feeds unchanged', () => {
  for (const camera of catalog) {
    assert.ok(['embed', 'hls', 'image'].includes(camera.feedType));
    const url = new URL(mediaUrl(camera));
    if (camera.feedType === 'embed') {
      assert.equal(url.origin, 'https://www.youtube.com');
      assert.equal(url.pathname, '/watch');
      assert.match(url.searchParams.get('v'), /^[A-Za-z0-9_-]{11}$/);
      assert.equal(camera.url, undefined);
      assert.equal(camera.snapshotUrl, undefined);
    } else {
      const normalized = normalizeSourceItem(camera);
      assert.equal(normalized.feedType, camera.feedType);
      assert.equal(normalized.url, camera.url);
      assert.equal(normalized.lat, camera.lat);
      assert.equal(normalized.lon, camera.lon);
      if (camera.feedType === 'hls') assert.match(url.pathname, /\.m3u8$/);
      else assert.equal(camera.snapshotUrl, camera.url);
    }
    if (camera.snapshotAliasUrl) {
      const alias = new URL(camera.snapshotAliasUrl);
      assert.equal(alias.origin, 'https://ipcamlive.com');
      assert.equal(alias.pathname, '/player/snapshot.php');
      assert.deepEqual([...alias.searchParams.keys()], ['alias']);
      assert.match(alias.searchParams.get('alias'), /^[a-z0-9]+$/);
      assert.match(url.hostname, /^s\d+\.ipcamlive\.com$/);
      assert.match(url.pathname, /^\/streams\/[a-z0-9]+\/snapshot\.jpg$/);
    }
  }
});

test('every active feed has a dated receipt and unavailable media stays out', () => {
  const receipts = new Map(
    survey.runtimeVerification.map((r) => [r.cameraId, r]),
  );
  assert.equal(receipts.size, survey.runtimeVerification.length);
  assert.equal(receipts.size, catalog.length);
  const counts = {};
  for (const camera of catalog) {
    counts[camera.feedType] = (counts[camera.feedType] || 0) + 1;
    const receipt = receipts.get(camera.id);
    assert.ok(receipt, camera.id);
    assert.equal(camera.checkedAt, survey.checkedAt);
    assert.equal(receipt.checkedAt.slice(0, 10), survey.checkedAt);
    if (camera.feedType === 'embed') {
      assert.equal(
        receipt.videoId,
        new URL(camera.embedUrl).searchParams.get('v'),
      );
      assert.equal(receipt.isLiveNow, true);
      assert.ok(receipt.playbackAdvancedSeconds > 0.5);
      assert.ok(receipt.videoSize.every((n) => n > 0));
    } else {
      assert.equal(receipt.httpStatus, 200);
      assert.equal(receipt.decoded, true);
      if (camera.feedType === 'image') {
        assert.equal(
          new Date(receipt.lastModified).toISOString().slice(0, 10),
          survey.checkedAt,
        );
      }
    }
  }
  assert.deepEqual(counts, survey.runtimeCounts);
  assert.equal(
    new Set(survey.otherSources.map((r) => r.id)).size,
    survey.otherSources.length,
  );
  const active = new Set(catalog.map(mediaUrl));
  for (const finding of survey.otherSources) {
    assert.ok(finding.reason && finding.sourcePageUrl && finding.status);
    assert.equal(finding.checkedAt, survey.checkedAt);
    if (finding.publishedUrl)
      assert.ok(!active.has(finding.publishedUrl), finding.id);
  }
});
