// src/data/openVesselPhoto.test.mjs — an Open Vessel Photos answer is read
// into one credited, licensed photo, and nothing outside Open Vessel Photos'
// own host is ever shown or linked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openVesselPhotosUrl,
  parseOpenVesselPhoto,
} from './openVesselPhoto.js';

const UPSTREAM = Object.freeze({
  mmsi: '366999709',
  name: '01 USCGC Sockeye WPB87337',
  photos: [
    {
      n: 1,
      urls: {
        cfr: null,
        mmsi: 'https://openvesselphotos.org/v1/mmsi/366999709/photos/1.jpg',
      },
      credit: 'Gordon Leggett',
      licence: 'CC-BY-4.0',
      licenceName: 'CC BY 4.0',
      width: 1600,
      height: 1200,
    },
  ],
});

const PHOTO = Object.freeze({
  found: true,
  src: 'https://openvesselphotos.org/v1/mmsi/366999709/photos/1.jpg?size=800',
  width: 800,
  height: 600,
  photographer: 'Gordon Leggett',
  licence: 'CC BY 4.0',
  link: 'https://openvesselphotos.org/vessels/mmsi/366999709',
});

const withPhoto = (overrides) => ({
  ...UPSTREAM,
  photos: [{ ...UPSTREAM.photos[0], ...overrides }],
});

test('the upstream answer maps to the 800 px image, its credit, licence and page', () => {
  assert.deepEqual(parseOpenVesselPhoto(UPSTREAM), PHOTO);
  assert.equal(
    openVesselPhotosUrl('366999709'),
    'https://openvesselphotos.org/v1/mmsi/366999709',
  );
});

test('an image narrower than 800 px keeps its own size', () => {
  const photo = parseOpenVesselPhoto(withPhoto({ width: 640, height: 480 }));
  assert.equal(photo.width, 640);
  assert.equal(photo.height, 480);
});

test('an already-read photo passes through its checks again', () => {
  assert.deepEqual(parseOpenVesselPhoto(PHOTO), PHOTO);
  assert.deepEqual(parseOpenVesselPhoto({ ...PHOTO, licence: '' }), {
    found: false,
  });
});

test('a photo off the Open Vessel Photos host, or without a licence, is no photo', () => {
  for (const overrides of [
    { urls: { mmsi: 'https://example.com/1.jpg' } },
    {
      urls: {
        mmsi: 'http://openvesselphotos.org/v1/mmsi/366999709/photos/1.jpg',
      },
    },
    { urls: { mmsi: 'https://openvesselphotos.org.evil.com/1.jpg' } },
    { urls: { mmsi: 'https://user@openvesselphotos.org/1.jpg' } },
    { licence: '', licenceName: '' },
  ])
    assert.deepEqual(parseOpenVesselPhoto(withPhoto(overrides)), {
      found: false,
    });
  assert.deepEqual(
    parseOpenVesselPhoto({ ...PHOTO, link: 'https://example.com/' }),
    { found: false },
  );
});

test('a vessel without photos, or an answer with a bad MMSI, is no photo', () => {
  assert.deepEqual(parseOpenVesselPhoto({ ...UPSTREAM, photos: [] }), {
    found: false,
  });
  assert.deepEqual(parseOpenVesselPhoto({ ...UPSTREAM, mmsi: '12/../x' }), {
    found: false,
  });
  assert.deepEqual(parseOpenVesselPhoto(null), { found: false });
});

test('the next photo stands in when the first fails its checks', () => {
  const second = {
    ...UPSTREAM.photos[0],
    n: 2,
    urls: {
      mmsi: 'https://openvesselphotos.org/v1/mmsi/366999709/photos/2.jpg',
    },
  };
  const photo = parseOpenVesselPhoto({
    ...UPSTREAM,
    photos: [{ ...UPSTREAM.photos[0], licenceName: '', licence: '' }, second],
  });
  assert.equal(
    photo.src,
    'https://openvesselphotos.org/v1/mmsi/366999709/photos/2.jpg?size=800',
  );
});

test('an answer about another vessel than the one asked for is no photo', () => {
  assert.deepEqual(parseOpenVesselPhoto(UPSTREAM, '366999709'), PHOTO);
  assert.deepEqual(parseOpenVesselPhoto(UPSTREAM, '227000101'), {
    found: false,
  });
});
