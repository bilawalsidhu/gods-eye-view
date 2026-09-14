// src/data/calgaryCameras.test.mjs
// The load-bearing behaviour: Calgary publishes no camera facing, and the
// fields that look like one are the city's address grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionToHeading } from './directionText.js';
import {
  CALGARY_IMAGE_ORIGIN,
  calgaryCameraId,
  calgaryCameraName,
  isLikelyCalgaryCoordinate,
  normalizeCalgaryImageUrl,
  toCalgaryCameraSources,
} from './calgaryCameras.js';

const fallbackHeading = (id) => (id.length * 22.5) % 360;

const row = (overrides = {}) => ({
  camera_url: {
    url: 'http://trafficcam.calgary.ca/loc86.jpg',
    description: 'Camera 87',
  },
  quadrant: 'SE',
  camera_location: 'Stoney Trail / Deerfoot Trail SE',
  point: { type: 'Point', coordinates: [-113.9766063, 50.9007257] },
  ...overrides,
});

// ── the heading trap ───────────────────────────────────────────────────────

test('no heading is ever inferred from the quadrant or the camera name', () => {
  // Both fields parse to a confident bearing, and both bearings are meaningless:
  // "SE" is the half of Calgary's postal grid the intersection sits in.
  assert.equal(directionToHeading('Stoney Trail / Deerfoot Trail SE'), 135);
  assert.equal(directionToHeading('SE', true), 135);

  const [camera] = toCalgaryCameraSources([row()], { fallbackHeading });
  assert.equal(camera.headingDeg, fallbackHeading(camera.id));
  assert.notEqual(camera.headingDeg, 135);
  // And the layer must say so, so the UI can badge it and invite calibration.
  assert.equal(camera.headingConfidence, 'low');
});

test('every quadrant yields the supplied fallback heading, whatever it is', () => {
  // A sentinel fallback proves the quadrant contributes nothing: if any of the
  // four leaked into the bearing, the result could not still be the sentinel.
  // (Asserting "not 135" instead would pass or fail on whether a real hash
  // happened to collide with the trap value.)
  const SENTINEL = 7;
  for (const quadrant of ['NE', 'NW', 'SE', 'SW']) {
    const [camera] = toCalgaryCameraSources(
      [
        row({
          quadrant,
          camera_location: `16 Avenue / 14 Street ${quadrant}`,
          camera_url: {
            url: `http://trafficcam.calgary.ca/loc${quadrant}.jpg`,
          },
        }),
      ],
      { fallbackHeading: () => SENTINEL },
    );
    assert.equal(
      camera.headingDeg,
      SENTINEL,
      `${quadrant} leaked its address quadrant as a heading`,
    );
  }
});

// ── frame URL pinning ──────────────────────────────────────────────────────

test('frame URLs are upgraded to HTTPS', () => {
  assert.equal(
    normalizeCalgaryImageUrl('http://trafficcam.calgary.ca/loc86.jpg'),
    'https://trafficcam.calgary.ca/loc86.jpg',
  );
  assert.equal(
    normalizeCalgaryImageUrl('https://trafficcam.calgary.ca/loc86.jpg'),
    'https://trafficcam.calgary.ca/loc86.jpg',
  );
});

test('frame URLs off the official origin are refused', () => {
  for (const hostile of [
    'http://evil.example.com/loc86.jpg',
    'https://trafficcam.calgary.ca.evil.com/loc86.jpg',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '//trafficcam.calgary.ca/loc86.jpg',
    '',
    null,
    undefined,
    'not a url',
  ]) {
    assert.equal(
      normalizeCalgaryImageUrl(hostile),
      null,
      `${hostile} must be refused`,
    );
  }
});

test('a camera with an unusable frame URL is skipped, not registered blind', () => {
  const cameras = toCalgaryCameraSources(
    [row(), row({ camera_url: { url: 'http://evil.example.com/x.jpg' } })],
    { fallbackHeading },
  );
  assert.equal(cameras.length, 1);
  assert.ok(cameras[0].url.startsWith(CALGARY_IMAGE_ORIGIN));
});

// ── identity ───────────────────────────────────────────────────────────────

test('camera ids come from the frame filename and are stable', () => {
  assert.equal(
    calgaryCameraId('https://trafficcam.calgary.ca/loc86.jpg'),
    'calgary-86',
  );
  assert.equal(
    calgaryCameraId('https://trafficcam.calgary.ca/loc142.jpg'),
    'calgary-142',
  );
  // A filename-scheme change degrades to a stable slug rather than dropping it.
  assert.equal(
    calgaryCameraId('https://trafficcam.calgary.ca/cams/west-7.png'),
    'calgary-cams-west-7',
  );
  assert.equal(calgaryCameraId('nonsense'), null);
});

test('duplicate cameras collapse to one registration', () => {
  const cameras = toCalgaryCameraSources([row(), row()], { fallbackHeading });
  assert.equal(cameras.length, 1);
});

test('the intersection name is kept verbatim, quadrant suffix included', () => {
  assert.equal(
    calgaryCameraName(row(), 'calgary-86'),
    'Stoney Trail / Deerfoot Trail SE',
  );
  assert.equal(
    calgaryCameraName(
      { camera_url: { description: 'Camera 87' } },
      'calgary-86',
    ),
    'Camera 87',
  );
  assert.equal(calgaryCameraName({}, 'calgary-86'), 'Calgary Camera 86');
});

// ── scope guard ────────────────────────────────────────────────────────────

test('coordinates outside Calgary are rejected', () => {
  assert.equal(isLikelyCalgaryCoordinate(51.0461, -114.0626), true);
  assert.equal(isLikelyCalgaryCoordinate(53.5461, -113.49), false); // Edmonton
  assert.equal(isLikelyCalgaryCoordinate(30.2672, -97.7431), false); // Austin
  assert.equal(isLikelyCalgaryCoordinate(NaN, -114), false);
  const cameras = toCalgaryCameraSources(
    [
      row(),
      row({
        point: { coordinates: [-97.7431, 30.2672] },
        camera_url: { url: 'http://trafficcam.calgary.ca/loc9.jpg' },
      }),
    ],
    { fallbackHeading },
  );
  assert.equal(cameras.length, 1);
});

test('malformed rows are skipped without discarding the catalog', () => {
  const cameras = toCalgaryCameraSources(
    [null, 'nonsense', {}, { point: null }, row()],
    { fallbackHeading },
  );
  assert.equal(cameras.length, 1);
  assert.deepEqual(toCalgaryCameraSources(null, { fallbackHeading }), []);
});

test('a missing heading source is a programming error, not a silent default', () => {
  assert.throws(() => toCalgaryCameraSources([row()], {}), /fallbackHeading/);
});

test('normalized records carry the licence and the CCTV source contract', () => {
  const [camera] = toCalgaryCameraSources([row()], { fallbackHeading });
  assert.equal(camera.cityId, 'calgary');
  assert.equal(camera.provider, 'The City of Calgary');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.sourceKind, 'calgary-open-data');
  assert.match(camera.license, /Open Government Licence – City of Calgary/);
  for (const key of [
    'id',
    'name',
    'lat',
    'lon',
    'headingDeg',
    'pitchDeg',
    'fovDeg',
    'rangeM',
    'url',
  ]) {
    assert.ok(camera[key] !== undefined, `missing ${key}`);
  }
});
