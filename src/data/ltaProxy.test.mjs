// LTA DataMall (Singapore) camera mapping.
//
// The field contract is the point of these tests. `Traffic-Imagesv2` was
// verified live on 2026-09-13 to return {CameraID, Latitude, Longitude,
// ImageLink}; if any of those are renamed upstream the pack must collapse
// visibly here rather than quietly resolving to zero Singapore cameras — the
// same failure mode that dropped every mapped-installation way and relation.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltaCameraToSource } from '../../vite.config.js';

/** A camera shaped exactly like a live Traffic-Imagesv2 element. */
const LIVE = {
  CameraID: '2701',
  Latitude: 1.447023728,
  Longitude: 103.7716543,
  ImageLink: 'https://dm-traffic-camera-itsc.s3.ap-southeast-1.amazonaws.com/2026-09-14/02-50/2701_0249.jpg?X-Amz-Expires=900&X-Amz-Signature=abc',
};

test('a live LTA element maps to a placeable camera', () => {
  const source = ltaCameraToSource(LIVE);
  assert.ok(source, 'the verified upstream shape must map');
  assert.equal(source.id, 'lta-2701');
  assert.equal(source.lat, 1.447023728);
  assert.equal(source.lon, 103.7716543);
  assert.equal(source.city, 'Singapore');
  assert.equal(source.sourceKind, 'lta-datamall');
  assert.equal(source.feedType, 'image');
  assert.equal(source.snapshotUrl, LIVE.ImageLink);
  // Attribution is REQUIRED by the Singapore Open Data Licence.
  assert.match(source.license, /Singapore Open Data Licence/);
});

test('LTA publishes no pose, so heading is a flagged fallback not a claim', () => {
  const source = ltaCameraToSource(LIVE);
  assert.equal(source.headingConfidence, 'low', 'an invented heading must never read as surveyed');
  assert.ok(Number.isFinite(source.headingDeg));
  assert.ok(source.headingDeg >= 0 && source.headingDeg < 360);
  for (const key of ['pitchDeg', 'fovDeg', 'rangeM', 'mountHeightM', 'groundElevationM']) {
    assert.ok(Number.isFinite(source[key]), `${key} must be finite so the camera can project`);
  }
});

test('a renamed or missing coordinate field drops the camera instead of misplacing it', () => {
  assert.equal(ltaCameraToSource({ ...LIVE, Latitude: undefined }), null);
  assert.equal(ltaCameraToSource({ ...LIVE, Longitude: undefined }), null);
  assert.equal(ltaCameraToSource({ ...LIVE, CameraID: '' }), null);
  // The pre-v2 lowercase spelling must NOT silently half-work.
  assert.equal(ltaCameraToSource({ cameraID: '2701', latitude: 1.44, longitude: 103.77, imageLink: LIVE.ImageLink }), null);
  assert.equal(ltaCameraToSource({}), null);
  assert.equal(ltaCameraToSource(null), null);
});

test('only https image links are accepted', () => {
  assert.equal(ltaCameraToSource({ ...LIVE, ImageLink: 'http://example.com/a.jpg' }), null);
  assert.equal(ltaCameraToSource({ ...LIVE, ImageLink: '' }), null);
  assert.equal(ltaCameraToSource({ ...LIVE, ImageLink: 'javascript:alert(1)' }), null);
});

test('a numeric CameraID still produces a stable string id', () => {
  const source = ltaCameraToSource({ ...LIVE, CameraID: 4703 });
  assert.equal(source.id, 'lta-4703');
  assert.equal(source.name, 'LTA Camera 4703');
});
