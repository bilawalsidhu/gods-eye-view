import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  answerMapillaryRequest,
  describeCall,
  PHOTO_SEQUENCE_ID,
  photoImages,
  THUMB_HOST,
} from '../../scripts/fixtures/street-level/mapillaryGraph.mjs';
import { redact } from '../../scripts/qa-browserEvidence.mjs';
import {
  answerKartaViewRequest,
  describeKartaViewCall,
  KV_LINE,
  KV_OLD_STREET,
  KV_SEQUENCE_ID,
  kartaViewPhotos,
  resetKartaViewFixture,
} from '../../scripts/fixtures/street-level/kartaView.mjs';
import {
  maskedSegments,
  tileSegments,
} from '../layers/streetLevel/providers/kartaview/decode.js';
import { lonToTileX, latToTileY } from '../layers/streetLevel/tileMath.js';
import {
  normalizePhoto,
  resizedImageUrl,
} from '../layers/streetLevel/providers/kartaview/policy.js';

const graph = (path, params) =>
  `https://graph.mapillary.com/${path}?${new URLSearchParams({ access_token: 'MLY|0|qa-fixture', ...params })}`;
const answer = (url, method = 'GET') => {
  const out = answerMapillaryRequest({ method, url });
  return {
    ...out,
    json: out.contentType === 'application/json' ? JSON.parse(out.body) : null,
  };
};

test('the Graph fixtures answer every call MapillaryJS makes to open a photo', () => {
  const [first, second] = photoImages();
  const spatial = answer(
    graph('images', {
      image_ids: `${first.id},${second.id}`,
      fields:
        'id,computed_geometry,geometry,sequence,camera_type,computed_rotation,thumb_1024_url,thumb_2048_url,width,height,merge_cc,sfm_cluster,mesh,creator,captured_at',
    }),
  );
  assert.equal(spatial.status, 200);
  assert.equal(spatial.headers['Access-Control-Allow-Origin'], '*');
  const [pano, flat] = spatial.json.data;
  assert.equal(pano.camera_type, 'spherical');
  assert.equal(flat.camera_type, 'perspective');
  assert.equal(pano.merge_cc, null, 'unmerged: no mesh request');
  assert.equal(pano.sfm_cluster, null, 'no cluster request');
  assert.equal(pano.computed_rotation.length, 3);
  assert.equal(new URL(pano.thumb_2048_url).hostname, THUMB_HOST);
  assert.equal(
    answer(graph('images', { s2: '9749618446378729472', fields: 'id' })).json
      .data.length,
    0,
  );
  assert.deepEqual(
    answer(graph('image_ids', { sequence_id: PHOTO_SEQUENCE_ID })).json.data[0],
    { id: first.id },
  );
  assert.deepEqual(
    answer(graph(`${first.id}/tiles`, { z: '11', fields: 'url,z,x,y' })).json,
    { data: [] },
  );
  const photo = answer(pano.thumb_2048_url);
  assert.equal(photo.status, 200);
  assert.equal(photo.contentType, 'image/jpeg');
  assert.deepEqual([...photo.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const preflight = answer(graph('images', { image_ids: first.id }), 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers['Access-Control-Allow-Headers'],
    /Authorization/,
  );
});

test('a Mapillary call no fixture covers is answered but flagged unknown', () => {
  for (const url of [
    graph('images', { bbox: '0,0,1,1' }),
    graph('map_features', { fields: 'id' }),
    'https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/1/1',
  ]) {
    const out = answer(url);
    assert.equal(out.known, false, url);
    assert.ok(out.status >= 400);
  }
});

test('answered calls are named without the token', () => {
  const call = describeCall(
    'GET',
    new URL(graph('9100000000000/tiles', { z: '11', fields: 'url' })),
  );
  assert.equal(call, 'GET graph.mapillary.com/{imageId}/tiles?fields&z');
  assert.doesNotMatch(call, /MLY|access_token/);
  assert.equal(
    describeCall(
      'GET',
      new URL('https://qa-fixture.mapillary.com/thumb/9100000000016.jpg'),
    ),
    'GET qa-fixture.mapillary.com/thumb/{imageId}.jpg',
  );
});

test('evidence never carries a Mapillary token', () => {
  assert.equal(
    redact(
      'GET https://graph.mapillary.com/images?access_token=MLY|123|abc&fields=id',
    ),
    'GET https://graph.mapillary.com/images?access_token=REDACTED&fields=id',
  );
  assert.equal(
    redact('token MLY|123|abc in a log'),
    'token MLY|REDACTED in a log',
  );
  assert.equal(
    redact(
      'https://tile.googleapis.com/v1/3dtiles/x.glb?session=s1&key=AIzaSyBexampleexampleexampleexample00',
    ),
    'https://tile.googleapis.com/v1/3dtiles/x.glb?session=s1&key=REDACTED',
  );
  assert.equal(
    redact('loaded with AIzaSyBexampleexampleexampleexample00 inline'),
    'loaded with AIza…REDACTED inline',
  );
});

test('KartaView fixtures draw the drive, answer nearest first, and refuse the storage host the API names', () => {
  const body = (answer) => JSON.parse(answer.body);
  const lat = (KV_LINE.south + KV_LINE.north) / 2;
  const x = lonToTileX(KV_LINE.lon, 14);
  const y = latToTileY(lat, 14);
  const tile = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/tiles/${x}/${y}/14.json`,
  });
  assert.equal(tile.known, true);
  assert.ok(body(tile).lines.length >= 1);
  const empty = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/tiles/${x + 3}/${y}/14.json`,
  });
  assert.deepEqual(body(empty).lines, []);
  const nearUrl = `https://api.kartaview.org/2.0/photo/?lat=${lat}&lng=${KV_LINE.lon + 0.0001}&zoomLevel=18&itemsPerPage=10`;
  resetKartaViewFixture();
  // The first lookup is rate-limited, readable cross-origin; the retry answers.
  const limited = answerKartaViewRequest({ method: 'GET', url: nearUrl });
  assert.equal(limited.status, 429);
  assert.equal(limited.known, true);
  assert.equal(limited.headers['Retry-After'], '0');
  assert.match(limited.headers['Access-Control-Expose-Headers'], /Retry-After/);
  const near = answerKartaViewRequest({ method: 'GET', url: nearUrl });
  assert.equal(near.status, 200);
  const records = body(near).result.data;
  assert.ok(records.length > 1);
  assert.ok(Number(records[0].distance) <= Number(records[1].distance));
  const photo = normalizePhoto(records[0]);
  assert.match(photo.urls.view, /^https:\/\/storage2\.openstreetcam\.org\//);
  assert.equal(
    answerKartaViewRequest({ method: 'GET', url: photo.urls.view }).known,
    true,
  );
  // Every odd photo is archived: its file answers 409, an even one the image.
  const photos = kartaViewPhotos();
  const storageAnswer = (index) =>
    answerKartaViewRequest({
      method: 'GET',
      url: normalizePhoto(
        body(
          answerKartaViewRequest({
            method: 'GET',
            url: `https://api.kartaview.org/2.0/photo/${photos[index].id}`,
          }),
        ).result.data,
      ).urls.view,
    });
  assert.equal(photos[3].archived, true);
  assert.equal(storageAnswer(3).status, 409);
  assert.equal(storageAnswer(3).known, true);
  assert.equal(photos[4].archived, false);
  assert.equal(storageAnswer(4).status, 200);
  assert.equal(storageAnswer(4).contentType, 'image/jpeg');
  // The image proxy still serves an archived photo: the 360° step opens one.
  const pano = photos.find((p) => p.isPano);
  assert.equal(pano.archived, true);
  const panoRecord = body(
    answerKartaViewRequest({
      method: 'GET',
      url: `https://api.kartaview.org/2.0/photo/${pano.id}`,
    }),
  ).result.data;
  assert.equal(
    answerKartaViewRequest({
      method: 'GET',
      url: resizedImageUrl(normalizePhoto(panoRecord).urls.pano, [1024, 512]),
    }).status,
    200,
  );
  assert.equal(
    answerKartaViewRequest({ method: 'GET', url: records[0].fileurlLTh }).known,
    false,
    'the storage1 address the API gives is not where the photo is',
  );
  const page = answerKartaViewRequest({
    method: 'GET',
    url: `https://api.kartaview.org/2.0/sequence/${KV_SEQUENCE_ID}/photos?page=1&itemsPerPage=1000`,
  });
  assert.equal(body(page).result.data.length, kartaViewPhotos().length);
  assert.ok(kartaViewPhotos().some((p) => p.isPano));
  assert.equal(
    describeKartaViewCall(
      'GET',
      new URL('https://api.kartaview.org/2.0/photo/77000001'),
    ),
    'GET api.kartaview.org/2.0/photo/{id}',
  );
});

test('Panoramax fixtures: two sequences on one street, searches honour sequence and filters, unknown calls are flagged', async () => {
  const {
    answerPanoramaxRequest,
    describePanoramaxCall,
    PNX_LINE,
    PNX_SEQUENCES,
    panoramaxHdDownloads,
    panoramaxPictures,
    panoramaxTile,
    resetPanoramaxFixture,
  } = await import('../../scripts/fixtures/street-level/panoramax.mjs');
  const { decodeCoverageTile, decodePictures } =
    await import('../layers/streetLevel/providers/panoramax/decode.js');
  const { normalizeItem } =
    await import('../layers/streetLevel/providers/panoramax/policy.js');
  resetPanoramaxFixture();
  const pictures = panoramaxPictures();
  assert.deepEqual(
    [...new Set(pictures.map((p) => p.sequenceId))],
    [...PNX_SEQUENCES],
  );
  assert.ok(pictures.some((p) => p.isPano));
  // Coverage: both lines in a z14 tile on the street; cones in z15.
  const z = 14;
  const x = lonToTileX((PNX_LINE.west + PNX_LINE.east) / 2, z);
  const y = latToTileY(PNX_LINE.lat, z);
  const lines = decodeCoverageTile(panoramaxTile(z, x, y), { x, y, z });
  assert.deepEqual(
    lines.sequences.map((s) => s.id).sort(),
    [...PNX_SEQUENCES].sort(),
  );
  const t15 = {
    x: lonToTileX(pictures[20].lon, 15),
    y: latToTileY(PNX_LINE.lat, 15),
    z: 15,
  };
  assert.ok(
    decodePictures(panoramaxTile(15, t15.x, t15.y), t15, PNX_SEQUENCES[0])
      .length > 0,
  );
  // A search for one sequence near the street gives only its pictures, nearest first.
  const at = pictures[30];
  const ask = (query) =>
    JSON.parse(
      answerPanoramaxRequest({
        method: 'GET',
        url: `https://api.panoramax.xyz/api/search?${query}`,
      }).body,
    ).features.map(normalizeItem);
  const own = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-50&limit=5&collections=${PNX_SEQUENCES[1]}`,
  );
  assert.ok(own.length > 0);
  assert.ok(own.every((p) => p.sequenceId === PNX_SEQUENCES[1]));
  assert.equal(own[0].nextId && typeof own[0].nextId, 'string');
  const panos = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-200&limit=50&filter=field_of_view%3D360`,
  );
  assert.ok(panos.length > 0 && panos.every((p) => p.isPano));
  assert.deepEqual(
    ask(
      `place_position=${at.lon},${at.lat}&place_distance=0-200&limit=50&datetime=2024-01-01T00:00:00.000Z/..`,
    ).every((p) => p.sequenceId === PNX_SEQUENCES[0]),
    true,
    'the second sequence is older',
  );
  // A box has every picture in it, those looking away included; a place
  // search leaves out pictures the point is behind (all look east).
  const d = 0.0002;
  const boxed = ask(
    `bbox=${at.lon - d},${at.lat - d},${at.lon + d},${at.lat + d}&limit=100`,
  );
  assert.ok(
    boxed.some((p) => p.lon < at.lon) && boxed.some((p) => p.lon > at.lon),
  );
  const placed = ask(
    `place_position=${at.lon},${at.lat}&place_distance=0-30&limit=50`,
  );
  assert.ok(placed.length > 0);
  assert.ok(
    placed.every((p) => p.lon <= at.lon + 1e-7),
    'none it is behind',
  );
  const one = ask(`ids=${at.id}&limit=1`);
  assert.equal(one[0].id, at.id);
  // Its pictures, and only those, are served; HD downloads are counted.
  const file = (name) =>
    answerPanoramaxRequest({
      method: 'GET',
      url: `https://panoramax.openstreetmap.fr/derivates/${name}`,
    });
  assert.equal(file(`${at.id}/sd.jpg`).status, 200);
  assert.equal(file(`${at.id}/hd.jpg`).status, 200);
  assert.equal(panoramaxHdDownloads(), 1);
  assert.equal(file('nope/sd.jpg').known, false);
  const unknown = answerPanoramaxRequest({
    method: 'GET',
    url: 'https://api.panoramax.xyz/api/collections/x/items',
  });
  assert.equal(unknown.known, false);
  assert.equal(
    describePanoramaxCall(
      'GET',
      new URL('https://api.panoramax.xyz/api/map/14/1/2.mvt'),
    ),
    'GET api.panoramax.xyz/api/map/{z}/{x}/{y}.mvt',
  );
});

/** The alpha of a fixture PNG (8-bit RGBA, unfiltered rows, as it writes them). */
function fixturePngAlpha(bytes) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const idat = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      alpha[y * width + x] = rows[y * (width * 4 + 1) + 1 + x * 4 + 3];
  return { width, height, alpha };
}

test('KartaView fixtures filter like KartaView: PNG tiles by view and upload date, the photo search by projection', () => {
  const body = (answer) => JSON.parse(answer.body);
  const z = 14;
  const x = lonToTileX(KV_LINE.lon, z);
  const y = latToTileY((KV_LINE.south + KV_LINE.north) / 2, z);
  assert.equal(x, lonToTileX(KV_OLD_STREET.lon, z), 'both streets in a tile');
  const base = `https://api.kartaview.org/2.0/sequence/tiles/${x}/${y}/${z}`;
  const segments = tileSegments(
    body(answerKartaViewRequest({ method: 'GET', url: `${base}.json` })),
  );
  const lons = (kept) => [...new Set(kept.map((segment) => segment[0][0]))];
  const keptFor = (query) => {
    const answer = answerKartaViewRequest({
      method: 'GET',
      url: `${base}.png?${query}`,
    });
    assert.equal(answer.contentType, 'image/png');
    assert.equal(answer.known, true);
    return lons(
      maskedSegments(segments, fixturePngAlpha(answer.body), { x, y, z }),
    );
  };
  assert.deepEqual(
    lons(segments).sort(),
    [KV_LINE.lon, KV_OLD_STREET.lon].sort(),
  );
  assert.deepEqual(keptFor('fieldOfView=360'), [KV_LINE.lon]);
  assert.deepEqual(keptFor('fieldOfView=plane').sort(), lons(segments).sort());
  const lastYear = new Date(Date.now() - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.deepEqual(keptFor(`startDate=${lastYear}`), [KV_LINE.lon]);
  assert.deepEqual(keptFor('startDate=2099-01-01'), []);
  assert.equal(
    describeKartaViewCall('GET', new URL(`${base}.png?fieldOfView=360`)),
    'GET api.kartaview.org/2.0/sequence/tiles/{x}/{y}/{z}.png?fieldOfView',
  );
  // The photo search: 360° only, and nothing uploaded after the drive.
  resetKartaViewFixture();
  const search = (extra) => {
    answerKartaViewRequest({
      method: 'GET',
      url: 'https://api.kartaview.org/2.0/photo/?lat=0&lng=0',
    });
    return body(
      answerKartaViewRequest({
        method: 'GET',
        url: `https://api.kartaview.org/2.0/photo/?lat=${KV_LINE.south + 0.002}&lng=${KV_LINE.lon}&zoomLevel=18&itemsPerPage=10${extra}`,
      }),
    ).result.data;
  };
  const panos = search('&projection=SPHERE');
  assert.ok(panos.length > 0);
  assert.ok(panos.every((record) => record.projection === 'SPHERE'));
  assert.deepEqual(search('&startDate=2099-01-01'), []);
});
