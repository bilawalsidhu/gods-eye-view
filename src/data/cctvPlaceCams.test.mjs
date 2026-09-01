import assert from 'node:assert/strict';
import test from 'node:test';
import { _seedCatalogForTest, _isPlaceCamForTest } from './cctv.js';
import { PLACE_CAM_SEEDS } from './placeCamSeeds.js';

test('seedCatalog appends every place cam as a feedType:"youtube" camera', () => {
  const catalog = _seedCatalogForTest();
  const placeCams = catalog.filter((c) => c.feedType === 'youtube');
  assert.equal(placeCams.length, PLACE_CAM_SEEDS.length);
  for (const cam of placeCams) {
    assert.equal(cam.provider, 'YouTube Live');
    assert.equal(cam.sourceKind, 'placecam');
    assert.equal(cam.feedConfigured, true);
    assert.ok(Array.isArray(cam.youtube?.videoIds), `${cam.id} carries youtube.videoIds`);
    for (const vid of cam.youtube.videoIds) {
      assert.match(vid, /^[\w-]{11}$/, `${cam.id} inline id "${vid}" is a valid YouTube id`);
    }
    assert.ok(cam.youtube.watchUrl, `${cam.id} carries youtube.watchUrl`);
    assert.match(
      cam.youtube.watchUrl,
      /[?&]sp=EgJAAQ/,
      `${cam.id} watchUrl restricts the fallback search to live results`,
    );
    assert.ok(_isPlaceCamForTest(cam));
    assert.ok(Number.isFinite(cam.lat) && Number.isFinite(cam.lon));
  }
});

test('most place cams ship at least one probeable inline live id', () => {
  const withInline = PLACE_CAM_SEEDS.filter((s) => s.videoIds.length > 0);
  // The rest fall back to the OPEN LIVE STREAM search button; keep the inline
  // set the clear majority so the panel plays without a click for most places.
  assert.ok(
    withInline.length >= Math.ceil(PLACE_CAM_SEEDS.length / 2),
    `expected 50%+ with inline ids, got ${withInline.length}/${PLACE_CAM_SEEDS.length}`,
  );
});

test('the traffic seeds are untouched (still feedType:"image", not place cams)', () => {
  const catalog = _seedCatalogForTest();
  const trafficCams = catalog.filter((c) => c.sourceKind === 'seed');
  assert.ok(trafficCams.length > 0);
  for (const cam of trafficCams) {
    assert.equal(cam.feedType, 'image');
    assert.equal(_isPlaceCamForTest(cam), false);
    // traffic seeds get a resolved pose; place cams do not
    assert.ok(cam.anchor || cam.basePose || Number.isFinite(cam.absoluteHeightM));
  }
});

test('_isPlaceCamForTest keys purely off feedType', () => {
  assert.equal(_isPlaceCamForTest({ feedType: 'youtube' }), true);
  assert.equal(_isPlaceCamForTest({ feedType: 'image' }), false);
  assert.equal(_isPlaceCamForTest({}), false);
  assert.equal(_isPlaceCamForTest(null), false);
});
