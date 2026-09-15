import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radioBrowser.js';
import { normalizeFeedType, isVideoFeedType } from './cctvTypes.js';
import { isValidTileCoord } from '../data/tomtomTiles.js';

const station = {
  stationuuid: 'abcdefff-1234-5678-abcd-123456789abc',
  name: '  Test\n Radio ',
  geo_lat: '30.2',
  geo_long: '-97.7',
  url_resolved: 'https://radio.example/stream',
  homepage: 'https://radio.example/',
  codec: 'mp3',
  lastcheckok: 1,
  hls: 0,
  countrycode: 'US',
  country: 'US',
  tags: 'News,news,air_traffic',
  bitrate: 128,
  clickcount: 10,
};

test('radio records normalize identity, country and tags and project only public fields', () => {
  const result = normalizeRadioBrowserStation(station);
  assert.equal(result.name, 'Test Radio');
  assert.equal(result.countryCode, 'US');
  assert.equal(result.country, 'United States');
  assert.deepEqual(result.tags, ['news', 'air traffic']);
  assert.equal(result.lat, 30.2);
  assert.equal(result.metadataTrust, 'untrusted-community');
  assert.equal('clickCount' in publicRadioStation(result), false);
  assert.equal(
    'extra' in publicRadioStation({ ...result, extra: 'not a record field' }),
    false,
  );
});

test('radio rejects unusable metadata and unsafe default stream destinations', () => {
  for (const patch of [
    { geo_lat: null },
    { geo_long: undefined },
    { geo_lat: 91 },
    { stationuuid: 'invalid' },
    { name: '' },
    { hls: 1 },
    { lastcheckok: 0 },
    { codec: 'unknown' },
    ...[
      'http://radio.example/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://user:pass@radio.example/',
      'https://[::1]/',
    ].map((url_resolved) => ({ url_resolved })),
  ])
    assert.equal(normalizeRadioBrowserStation({ ...station, ...patch }), null);
});

test('a supplied URL policy applies independently to stream and homepage', () => {
  const normalizeUrl = (value) => {
    const safe = publicRadioHttpsUrl(value);
    return safe && !new URL(safe).port ? safe : null;
  };
  assert.equal(
    normalizeRadioBrowserStation(
      { ...station, url_resolved: 'https://radio.example:8443/' },
      { normalizeUrl },
    ),
    null,
  );
  const record = normalizeRadioBrowserStation(
    { ...station, homepage: 'https://radio.example:8443/' },
    { normalizeUrl },
  );
  assert.equal(record.streamUrl, station.url_resolved);
  assert.equal(record.homepage, null);
  assert.ok(
    normalizeRadioBrowserStation({
      ...station,
      url_resolved: 'https://radio.example:8443/',
    }),
  );
});

test('camera aliases remain separate from player support decisions', () => {
  for (const [input, expected] of [
    ['JPEG', 'image'],
    ['mjpg', 'mjpeg'],
    ['video', 'mp4'],
    ['stream', 'hls'],
    ['', 'image'],
    ['other', 'other'],
  ]) {
    assert.equal(normalizeFeedType(input), expected);
  }
  assert.equal(isVideoFeedType('mjpeg'), false);
  assert.equal(isVideoFeedType('hls'), true);
});

test('XYZ math preserves traffic bounds while allowing explicit source bounds', () => {
  assert.equal(isValidTileCoord(7, 0, 0), false);
  assert.equal(isValidTileCoord(17, 0, 0), false);
  assert.equal(isValidTileCoord(8, 255, 255), true);
  assert.equal(isValidTileCoord(8, 256, 0), false);
  const bounds = { minZoom: 0, maxZoom: 22 };
  assert.equal(isValidTileCoord(0, 0, 0, bounds), true);
  assert.equal(isValidTileCoord(22, 2 ** 22 - 1, 0, bounds), true);
  assert.equal(isValidTileCoord(23, 0, 0, bounds), false);
  assert.equal(isValidTileCoord(4, 1.5, 0, bounds), false);
  assert.equal(isValidTileCoord(4, 0, 0, { minZoom: 5, maxZoom: 2 }), false);
});
