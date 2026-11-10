import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignCourses,
  bearingBetween,
  cameraBearing,
  kartaViewPhotoUrl,
  kartaViewTimeMs,
  normalizePhoto,
  passesKartaViewFilter,
  photoFilterParams,
  resizedImageUrl,
  tileFilterQuery,
} from './policy.js';

/** A photo record as /2.0/photo returns it (trimmed to what is read). */
function record(overrides = {}) {
  return {
    id: '7102491',
    sequenceId: '14010',
    sequenceIndex: '950',
    lat: '42.335712',
    lng: '-83.048301',
    matchLat: '42.335731506347656',
    matchLng: '-83.04828643798828',
    heading: '299.58',
    fieldOfView: '0',
    projection: 'PLANE',
    shotDate: '2016-08-23 20:17:47.000',
    dateAdded: '2016-08-24 04:01:07',
    storage: 'storage1',
    filepath: '2016/8/24/{{sizeprefix}}/14010_ba53c_57bd1d23d50b7.jpg',
    filepathLTh: '2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
    filepathProc: '2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
    fileurl:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/{{sizeprefix}}/14010_ba53c_57bd1d23d50b7.jpg',
    fileurlLTh:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
    fileurlProc:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
    ...overrides,
  };
}

test('a photo record normalizes to numbers, the road-matched position and UTC capture time', () => {
  const photo = normalizePhoto(record());
  assert.equal(photo.id, '7102491');
  assert.equal(photo.sequenceId, '14010');
  assert.equal(photo.sequenceIndex, 950);
  assert.equal(photo.lat, 42.335731506347656);
  assert.equal(photo.lon, -83.04828643798828);
  assert.equal(photo.heading, 299.58);
  assert.equal(photo.isPano, false);
  assert.equal(photo.capturedAt, Date.UTC(2016, 7, 23, 20, 17, 47));
  assert.equal(photo.urls.pano, null);
});

test('photo files come from the storage host the record names, not the one its URLs say', () => {
  // The API writes storage1 into every URL; this photo lives on storage2.
  const photo = normalizePhoto(record({ storage: 'storage2' }));
  assert.equal(
    photo.urls.view,
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
  );
  assert.equal(
    photo.urls.full,
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
  );
  // The link goes through the image proxy, which serves photos whose
  // storage host answers 502 directly.
  const link = kartaViewPhotoUrl(photo);
  assert.match(link, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\/[\w-]+$/);
  assert.equal(
    Buffer.from(link.split('/').at(-1), 'base64url').toString(),
    photo.urls.full,
  );
  // A fallback address must be on KartaView's storage, over https.
  for (const fileurlLTh of [
    'https://tracker.example/x.jpg',
    'http://storage1.openstreetcam.org/a.jpg',
    'https://storage1.openstreetcam.org.evil.example/a.jpg',
    'javascript:alert(1)',
  ]) {
    const hostile = normalizePhoto(
      record({ storage: '', filepathLTh: '', fileurlLTh, fileurl: fileurlLTh }),
    );
    assert.notEqual(hostile.urls.view, fileurlLTh);
    assert.doesNotMatch(
      String(hostile.urls.view),
      /tracker|javascript|evil|^http:/,
    );
  }
  // An unexpected storage value falls back to the URLs as given.
  const odd = normalizePhoto(record({ storage: 'https://evil.example' }));
  assert.match(odd.urls.view, /^https:\/\/storage1\.openstreetcam\.org\//);
  // No large thumbnail path: the size prefix fills in.
  const bare = normalizePhoto(
    record({ filepathLTh: '', fileurlLTh: '', storage: 'storage3' }),
  );
  assert.equal(
    bare.urls.view,
    'https://storage3.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
  );
});

test('a 360° photo keeps its equirectangular image; the unmatched position is the fallback', () => {
  const photo = normalizePhoto(
    record({
      projection: 'SPHERE',
      fieldOfView: '360',
      matchLat: '0',
      matchLng: '0',
      storage: 'storage13',
      filepathProc: '2022/10/6/wrapped_proc/6187609_626b8.jpg',
    }),
  );
  assert.equal(photo.isPano, true);
  assert.equal(photo.lat, 42.335712);
  assert.equal(
    photo.urls.pano,
    'https://storage13.openstreetcam.org/files/photo/2022/10/6/wrapped_proc/6187609_626b8.jpg',
  );
  // A sphere without a wrapped image has nothing to project.
  assert.equal(
    normalizePhoto(record({ projection: 'SPHERE', fieldOfView: '360' })).urls
      .pano,
    null,
  );
});

test('records without an id or a position are dropped; a missing heading is null', () => {
  assert.equal(normalizePhoto(null), null);
  // 0,0 is a missing fix.
  assert.equal(
    normalizePhoto(
      record({ lat: '0', lng: '0', matchLat: '0', matchLng: '0' }),
    ),
    null,
  );
  assert.equal(normalizePhoto(record({ lat: '95', matchLat: '95' })), null);
  assert.equal(normalizePhoto(record({ id: undefined })), null);
  assert.equal(
    normalizePhoto(
      record({ lat: 'x', lng: 'y', matchLat: undefined, matchLng: undefined }),
    ),
    null,
  );
  assert.equal(normalizePhoto(record({ heading: '' })).heading, null);
  // A device without a compass reads 0 for a whole drive: unknown, not north.
  assert.equal(normalizePhoto(record({ heading: '0' })).heading, null);
  assert.equal(normalizePhoto(record({ heading: '0.5' })).heading, 0.5);
  assert.equal(normalizePhoto(record({ heading: 'n/a' })).heading, null);
});

test('timestamps parse as UTC; years before 1990 and garbage are unknown', () => {
  assert.equal(kartaViewTimeMs('2022-03-21'), Date.UTC(2022, 2, 21));
  assert.equal(
    kartaViewTimeMs('2022-03-21T06:42:59'),
    Date.UTC(2022, 2, 21, 6, 42, 59),
  );
  assert.equal(kartaViewTimeMs('2022-02-31 12:00:00'), null);
  assert.equal(kartaViewTimeMs('2022-13-01 00:00:00'), null);
  assert.equal(kartaViewTimeMs('2022-03-21 25:00:00'), null);
  assert.equal(kartaViewTimeMs('2022-04-31'), null);
  assert.equal(kartaViewTimeMs('0000-00-00 00:00:00'), null);
  assert.equal(kartaViewTimeMs(''), null);
  assert.equal(kartaViewTimeMs(null), null);
  const fallback = normalizePhoto(record({ shotDate: null }));
  assert.equal(fallback.capturedAt, Date.UTC(2016, 7, 24, 4, 1, 7));
});

test('resized images go through the proxy with a base64url address', () => {
  const url = resizedImageUrl(
    'https://storage13.openstreetcam.org/files/photo/a?b=c+d',
    [1024, 512],
  );
  const [, encoded] = /\/rs:fit:1024:512\/(.+)$/.exec(url);
  assert.match(url, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\/rs:fit:/);
  assert.doesNotMatch(encoded, /[+/=]/);
  const decoded = Buffer.from(
    encoded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString();
  assert.equal(
    decoded,
    'https://storage13.openstreetcam.org/files/photo/a?b=c+d',
  );
  assert.equal(resizedImageUrl(null, [1, 1]), null);
});

test('a storage value that only contains a storage host name builds no address from it', () => {
  for (const storage of ['evil.example/#storage1', 'storage1.evil.example']) {
    const photo = normalizePhoto(record({ storage }));
    // Not a storage host: the API's own storage URLs serve.
    assert.equal(
      photo.urls.view,
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
      storage,
    );
    assert.equal(
      photo.urls.full,
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
      storage,
    );
  }
});

test('a 360° field of view makes a panorama whatever the projection says', () => {
  assert.equal(
    normalizePhoto(record({ projection: 'PLANE', fieldOfView: '360' })).isPano,
    true,
  );
  assert.equal(
    normalizePhoto(record({ projection: 'PLANE', fieldOfView: '359' })).isPano,
    false,
  );
});

test('a longitude past ±180 is not a position', () => {
  assert.equal(normalizePhoto(record({ lng: '181', matchLng: '181' })), null);
  assert.equal(normalizePhoto(record({ lng: '-181', matchLng: '-181' })), null);
  assert.equal(
    normalizePhoto(record({ lng: '180', matchLng: '180' })).lon,
    180,
  );
});

test('with no processed-photo path the size prefix gives the full photo', () => {
  const photo = normalizePhoto(
    record({ filepathProc: '', fileurlProc: '', storage: 'storage3' }),
  );
  assert.equal(
    photo.urls.full,
    'https://storage3.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
  );
  // Only the large thumbnail, no path at all: the thumbnail still shows.
  const thumbOnly = normalizePhoto(
    record({
      filepathProc: '',
      fileurlProc: '',
      filepath: '',
      fileurl: '',
      storage: 'storage3',
    }),
  );
  assert.equal(thumbOnly.urls.full, null);
  assert.match(
    thumbOnly.urls.view,
    /^https:\/\/storage3\.openstreetcam\.org\/.*\/lth\//,
  );
});

test('the camera looks along the drive: each photo’s course points to the next one a few metres on', () => {
  // North along a meridian, 5 m apart, then a repeat of the last position.
  const step = 5 / 110_540;
  const photos = [0, 1, 2, 3].map((i) => ({ lon: 10, lat: 50 + i * step }));
  photos.push({ lon: 10, lat: 50 + 3 * step }); // a stop: same place
  const metres = (a, b) =>
    Math.hypot(
      (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180),
      (b.lat - a.lat) * 110_540,
    );
  assignCourses(photos, metres);
  for (const photo of photos)
    assert.ok(
      Math.abs(photo.course) < 0.5 || Math.abs(photo.course - 360) < 0.5,
      `${photo.course}`,
    );
  // Eastward: 90°.
  const east = [0, 1].map((i) => ({ lon: 10 + (i * 5) / 71_600, lat: 50 }));
  assignCourses(east, metres);
  assert.ok(
    Math.abs(east[0].course - 90) < 0.5 && Math.abs(east[1].course - 90) < 0.5,
  );
  // A lone photo has no course; the compass is the fallback, then unknown.
  const [lone] = assignCourses([{ lon: 1, lat: 1 }], metres);
  assert.equal(lone.course, null);
  assert.equal(cameraBearing({ ...lone, heading: 42 }), 42);
  assert.equal(cameraBearing({ ...lone, heading: null }), null);
  assert.equal(
    cameraBearing({ course: 90, heading: 200 }),
    90,
    'the drive beats the compass',
  );
  assert.ok(
    Math.abs(bearingBetween({ lon: 0, lat: 0 }, { lon: 0, lat: -1 }) - 180) <
      1e-9,
  );
});

test('the imagery filter becomes KartaView’s tile query and photo-search params', () => {
  // 2026-03-05 23:30 UTC: the cut-off day is the UTC one.
  const sinceMs = Date.UTC(2026, 2, 5, 23, 30);
  assert.equal(tileFilterQuery(null), '');
  assert.equal(tileFilterQuery({ pano: 'all', sinceMs: null }), '');
  assert.equal(
    tileFilterQuery({ pano: 'pano', sinceMs: null }),
    'fieldOfView=360',
  );
  assert.equal(
    tileFilterQuery({ pano: 'flat', sinceMs }),
    'fieldOfView=plane&startDate=2026-03-05',
  );
  assert.equal(tileFilterQuery({ pano: 'all', sinceMs: 0 }), '');
  // The search ignores fieldOfView; its projection filters instead.
  assert.deepEqual(photoFilterParams({ pano: 'all', sinceMs: null }), {});
  assert.deepEqual(photoFilterParams({ pano: 'pano', sinceMs }), {
    projection: 'SPHERE',
    startDate: '2026-03-05',
  });
  assert.deepEqual(photoFilterParams({ pano: 'flat', sinceMs: null }), {
    projection: 'PLANE',
  });
});

test('KartaView’s SINCE is the upload date, from the start of the cut-off’s UTC day', () => {
  const photo = normalizePhoto(
    record({
      shotDate: '2016-08-23 20:17:47.000',
      dateAdded: '2026-03-05 00:10:00',
    }),
  );
  assert.equal(photo.uploadedAt, Date.UTC(2026, 2, 5, 0, 10));
  const since = (iso) => ({ pano: 'all', sinceMs: Date.parse(iso) });
  // Taken in 2016, uploaded on the cut-off day: it passes, as KartaView's
  // startDate=2026-03-05 keeps it.
  assert.equal(
    passesKartaViewFilter(photo, since('2026-03-05T23:00:00Z')),
    true,
  );
  assert.equal(
    passesKartaViewFilter(photo, since('2026-03-06T00:00:00Z')),
    false,
  );
  assert.equal(
    passesKartaViewFilter(photo, { pano: 'pano', sinceMs: null }),
    false,
  );
  assert.equal(
    passesKartaViewFilter(photo, { pano: 'flat', sinceMs: null }),
    true,
  );
  assert.equal(passesKartaViewFilter(photo, null), true);
  assert.equal(
    passesKartaViewFilter(
      { ...photo, uploadedAt: null },
      since('2020-01-01T00:00:00Z'),
    ),
    false,
    'no upload date passes no SINCE',
  );
});
