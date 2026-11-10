// src/data/planespottersPhoto.test.mjs — the Planespotters photo answer is read
// into one credited thumbnail, and nothing outside Planespotters' own hosts is
// ever shown or linked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanespottersPhoto } from './planespottersPhoto.js';

const UPSTREAM = Object.freeze({
  photos: [
    {
      id: '1745410',
      thumbnail: {
        src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_t.jpg',
        size: { width: 200, height: 133 },
      },
      thumbnail_large: {
        src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_280.jpg',
        size: { width: 420, height: 280 },
      },
      link: 'https://www.planespotters.net/photo/1745410/n160an-american-airlines-airbus-a321-231-wl?utm_source=api',
      photographer: 'Jan Seler',
    },
  ],
});

const PHOTO = Object.freeze({
  found: true,
  src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_280.jpg',
  width: 420,
  height: 280,
  photographer: 'Jan Seler',
  link: 'https://www.planespotters.net/photo/1745410/n160an-american-airlines-airbus-a321-231-wl?utm_source=api',
});

const photo = (overrides) => ({
  photos: [{ ...UPSTREAM.photos[0], ...overrides }],
});

test('the upstream answer maps to the large thumbnail, its size, credit and link', () => {
  assert.deepEqual(parsePlanespottersPhoto(UPSTREAM), PHOTO);
});

test('the small thumbnail stands in when the large one is missing', () => {
  assert.deepEqual(parsePlanespottersPhoto(photo({ thumbnail_large: null })), {
    ...PHOTO,
    src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_t.jpg',
    width: 200,
    height: 133,
  });
});

test('a server’s cached shape reads the same way', () => {
  assert.deepEqual(
    parsePlanespottersPhoto({
      found: true,
      thumbnail: { src: PHOTO.src, width: 420, height: 280 },
      photographer: 'Jan Seler',
      link: PHOTO.link,
    }),
    PHOTO,
  );
  assert.deepEqual(parsePlanespottersPhoto({ found: false }), {
    found: false,
  });
});

test('a server’s cached shape prefers its large thumbnail', () => {
  assert.deepEqual(
    parsePlanespottersPhoto({
      found: true,
      thumbnail: {
        src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_t.jpg',
        width: 200,
        height: 133,
      },
      thumbnail_large: { src: PHOTO.src, width: 420, height: 280 },
      photographer: 'Jan Seler',
      link: PHOTO.link,
    }),
    PHOTO,
  );
});

test('a server’s cached shape falls back to its small thumbnail when the large one fails the checks', () => {
  const small = {
    src: 'https://t.plnspttrs.net/33043/1745410_822dfe330c_t.jpg',
    width: 200,
    height: 133,
  };
  for (const thumbnail_large of [
    { src: 'https://evil.example/a.jpg', width: 420, height: 280 },
    null,
  ]) {
    assert.deepEqual(
      parsePlanespottersPhoto({
        found: true,
        thumbnail: small,
        thumbnail_large,
        photographer: 'Jan Seler',
        link: PHOTO.link,
      }),
      { ...PHOTO, ...small },
      JSON.stringify(thumbnail_large),
    );
  }
});

test('no photo, junk, and missing fields are "no photo"', () => {
  for (const payload of [
    { photos: [] },
    {},
    null,
    undefined,
    'nope',
    { photos: 'nope' },
    { photos: [null] },
    photo({ photographer: '' }),
    photo({ photographer: '   ' }),
    photo({ photographer: 42 }),
    photo({ link: '' }),
    photo({ thumbnail: null, thumbnail_large: null }),
  ]) {
    assert.deepEqual(
      parsePlanespottersPhoto(payload),
      { found: false },
      JSON.stringify(payload),
    );
  }
});

test('a src outside https *.plnspttrs.net is dropped', () => {
  for (const src of [
    'http://t.plnspttrs.net/a.jpg',
    'https://plnspttrs.net.evil.example/a.jpg',
    'https://evil.example/t.plnspttrs.net/a.jpg',
    'https://t.plnspttrs.net.evil.example/a.jpg',
    'https://user@t.plnspttrs.net/a.jpg',
    'https://t.plnspttrs.net:8443/a.jpg',
    'javascript:alert(1)',
    '//t.plnspttrs.net/a.jpg',
    'not a url',
  ]) {
    assert.deepEqual(
      parsePlanespottersPhoto(
        photo({
          thumbnail_large: { src, size: { width: 420, height: 280 } },
          thumbnail: { src, size: { width: 200, height: 133 } },
        }),
      ),
      { found: false },
      src,
    );
  }
});

test('a link anywhere but https://www.planespotters.net is dropped', () => {
  for (const link of [
    'http://www.planespotters.net/photo/1',
    'https://planespotters.net/photo/1',
    'https://www.planespotters.net.evil.example/photo/1',
    'https://evil.example/?u=https://www.planespotters.net/',
    'https://user:pw@www.planespotters.net/photo/1',
    'https://www.planespotters.net:444/photo/1',
    'javascript:alert(1)',
  ]) {
    assert.deepEqual(
      parsePlanespottersPhoto(photo({ link })),
      { found: false },
      link,
    );
  }
});

test('the first photo that passes the checks is the one shown', () => {
  const second = {
    ...UPSTREAM.photos[0],
    photographer: 'Second Spotter',
  };
  assert.deepEqual(
    parsePlanespottersPhoto({
      photos: [
        { ...UPSTREAM.photos[0], link: 'https://evil.example/' },
        second,
      ],
    }),
    { ...PHOTO, photographer: 'Second Spotter' },
  );
});

test('a missing size is null and the credit is trimmed', () => {
  assert.deepEqual(
    parsePlanespottersPhoto(
      photo({
        photographer: '  Jan Seler ',
        thumbnail_large: { src: PHOTO.src },
      }),
    ),
    { ...PHOTO, width: null, height: null },
  );
});
