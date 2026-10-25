import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPresentation } from '../layers/cctv/presentation.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createCards } from '../layers/cctv/cards.js';

const catalog = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_sources.argentina.json', import.meta.url),
  ),
);
const sourceFor = (feedType) =>
  catalog.find((entry) => entry.feedType === feedType);

function publicCamera(feedType) {
  const origin = sourceFor(feedType === 'none' ? 'image' : feedType);
  const camera = {
    ...origin,
    feedType,
    headingDeg: 0,
    fovDeg: 70,
    pitchDeg: -10,
    rangeM: 500,
    mountHeightM: 20,
    absoluteHeightM: 20,
  };
  const record = { camera, projection: null };
  const counts = { frames: 0, media: 0 };
  const parts = {
    selection: { getActiveRecord: () => record },
    calibration: {
      normalizeCalibration: () => ({}),
      deriveCalBadge: () => 'raw',
    },
    model: { isVideoFeedType: (v) => v === 'hls' },
    frames: {
      frameUrlFor: () => {
        counts.frames += 1;
        return '/api/cctv/frame/test';
      },
      mediaUrlFor: () => {
        counts.media += 1;
        return '/api/cctv/media/test';
      },
    },
  };
  const view = createPresentation({
    state: {
      _healthById: new Map([
        [camera.id, { status: 'degraded', message: 'Temporary outage' }],
      ]),
    },
    services: {},
    parts,
    source: null,
  }).getPublicCameraState(record, camera.id);
  return { view, counts };
}

test('Argentina catalog has disjoint snapshot, HLS and external routes', () => {
  assert.equal(catalog.length, 64);
  for (const [feedType, expected] of [
    ['embed', 25],
    ['hls', 24],
    ['image', 15],
  ]) {
    const matches = catalog.filter((entry) => entry.feedType === feedType);
    assert.equal(matches.length, expected);
    for (const entry of matches) {
      assert.equal(Boolean(entry.snapshotUrl), feedType === 'image');
      if (feedType === 'embed') {
        assert.ok(entry.embedUrl);
        assert.equal(Boolean(entry.url), false);
      }
    }
  }
});

test('external players remain external and never acquire image or media URLs', () => {
  const { view, counts } = publicCamera('embed');
  assert.equal(view.feedType, 'embed');
  assert.equal(view.sourceStatus, 'external');
  assert.equal(view.noFeed, false);
  assert.ok(view.embedUrl);
  assert.equal(view.frameUrl, null);
  assert.equal(view.mediaUrl, null);
  assert.deepEqual(counts, { frames: 0, media: 0 });
});

test('HLS and static cameras keep their media and snapshot URLs', () => {
  for (const feedType of ['hls', 'image']) {
    const { view, counts } = publicCamera(feedType);
    assert.equal(view.feedType, feedType);
    assert.equal(view.noFeed, false);
    assert.equal(view.sourceStatus, 'degraded');
    assert.ok(view.frameUrl);
    assert.ok(view.mediaUrl);
    assert.deepEqual(counts, { frames: 1, media: 1 });
  }
});

test('a learned location-only camera remains selectable but has no frame or media URL', async () => {
  const { view, counts } = publicCamera('none');
  assert.equal(view.active, true);
  assert.equal(view.noFeed, true);
  assert.equal(view.sourceStatus, 'no public feed');
  assert.equal(view.frameUrl, null);
  assert.equal(view.mediaUrl, null);
  assert.deepEqual(counts, { frames: 0, media: 0 });

  let requests = 0;
  const client = createCctvSource({
    fetchImpl: () => {
      requests += 1;
      throw new Error('unexpected server request');
    },
  });
  assert.equal(client.getFrameUrl(view), null);
  assert.equal(client.getMediaUrl(view), null);
  await assert.rejects(
    client.getFrame(view),
    /Location-only camera frames are not available/,
  );
  assert.equal(requests, 0);
});

test('protected active card skips location-only cameras', () => {
  const id = 'ar-bayo-copitos';
  const entries = [];
  const record = {
    camera: { id, name: 'Argentina snapshot', feedType: 'none' },
    position: { x: 1, y: 2, z: 3 },
  };
  const state = {
    _recordById: new Map([[id, record]]),
    _cardIds: new Set(),
    _hoverCardId: null,
    _activeCameraCardEnabled: true,
    _activeCameraId: id,
    _cctvOverlayHost: {
      setEntries: (_sourceId, items) => entries.push(...items),
    },
  };
  const cards = createCards({ state, services: {}, parts: {}, source: null });
  cards.pushAmbientCardEntries();
  cards.fetchCardFrame(record, {}, 1000);
  assert.equal(entries.length, 0);
});

test('location-only source badge has translations in every supported locale', () => {
  for (const lang of ['es', 'ru', 'zh-CN']) {
    const messages = JSON.parse(
      readFileSync(new URL(`../i18n/locales/${lang}.json`, import.meta.url)),
    );
    assert.ok(messages['NO PUBLIC FEED']);
  }
});
