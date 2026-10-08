import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureTile } from '../../scripts/qa-street-level.mjs';
import {
  answerMapillaryRequest,
  describeCall,
  PHOTO_LINE,
  PHOTO_SEQUENCE_ID,
  photoImages,
  THUMB_HOST,
} from '../../scripts/fixtures/street-level/mapillaryGraph.mjs';
import { redact } from '../../scripts/qa-browserEvidence.mjs';

test('fixture tiles give the hermetic gate something real to filter', async () => {
  const { decodeCoverageTile } =
    await import('../layers/streetLevel/providers/mapillary/decode.js');
  const now = Date.UTC(2026, 9, 1);
  const street = decodeCoverageTile(fixtureTile(14, 2662, 6286, now), {
    x: 2662,
    y: 6286,
    z: 14,
  });
  const grid = street.sequences.filter((s) => s.id !== PHOTO_SEQUENCE_ID);
  assert.equal(grid.length, 8);
  const pano = grid.filter((s) => s.isPano).length;
  assert.ok(pano > 0 && pano < 8, '360° and flat both present');
  const year = 365 * 86_400_000;
  const old = grid.filter((s) => now - s.capturedAt > year).length;
  assert.ok(old > 0 && old < 8, 'recent and older both present');
  assert.equal(fixtureTile(3, 1, 3, now).length, 0, 'nothing from orbit');
  assert.equal(fixtureTile(8, 1, 1, now).length, 0, 'nor in between');
});

/* ── Hermetic photo flow: the photo line and the Graph fixtures ────────── */

test('the photo sequence runs through the parked view, clipped to each tile it crosses', async () => {
  const { decodeCoverageTile } =
    await import('../layers/streetLevel/providers/mapillary/decode.js');
  const { lonToTileX, latToTileY } =
    await import('../layers/streetLevel/tileMath.js');
  const x = lonToTileX(PHOTO_LINE.lon, 14);
  const rows = new Set(
    [PHOTO_LINE.south, PHOTO_LINE.north].map((lat) => latToTileY(lat, 14)),
  );
  assert.ok(rows.size > 1, 'the line crosses a tile edge');
  let south = Infinity;
  let north = -Infinity;
  for (const y of rows) {
    const line = decodeCoverageTile(fixtureTile(14, x, y), {
      x,
      y,
      z: 14,
    }).sequences.find((s) => s.id === PHOTO_SEQUENCE_ID);
    assert.ok(line, `tile 14/${x}/${y} carries the photo line`);
    for (const [lon, lat] of line.parts[0]) {
      assert.ok(Math.abs(lon - PHOTO_LINE.lon) < 1e-4);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  assert.ok(Math.abs(south - PHOTO_LINE.south) < 1e-4);
  assert.ok(Math.abs(north - PHOTO_LINE.north) < 1e-4);
  // Far away there is no photo line, only the grid.
  const elsewhere = decodeCoverageTile(fixtureTile(14, 100, 100), {
    x: 100,
    y: 100,
    z: 14,
  });
  assert.equal(
    elsewhere.sequences.some((s) => s.id === PHOTO_SEQUENCE_ID),
    false,
  );
});

test('the fixture photos: one sequence, 360° and flat, spaced past the cone thinning', () => {
  const images = photoImages(Date.UTC(2026, 9, 1));
  assert.ok(images.length >= 3);
  assert.ok(images.some((image) => image.isPano));
  assert.ok(images.some((image) => !image.isPano));
  for (let i = 1; i < images.length; i++) {
    const gap = (images[i].lat - images[i - 1].lat) * 110_540;
    assert.ok(gap > 3, `gap ${gap}`);
  }
  assert.equal(new Set(images.map((image) => image.id)).size, images.length);
});

const graph = (path, params) =>
  `https://graph.mapillary.com/${path}?${new URLSearchParams({ access_token: 'MLY|0|qa-fixture', ...params })}`;
const answer = (url, method = 'GET') => {
  const out = answerMapillaryRequest({ method, url });
  return {
    ...out,
    json: out.contentType === 'application/json' ? JSON.parse(out.body) : null,
  };
};

test('the Graph fixtures answer the provider’s sequence lookups', () => {
  const images = photoImages();
  const sequence = answer(
    graph('images', {
      sequence_ids: PHOTO_SEQUENCE_ID,
      fields: 'id,geometry,compass_angle,captured_at,is_pano',
      limit: '2000',
    }),
  );
  assert.equal(sequence.json.data.length, images.length);
  assert.deepEqual(
    answer(graph('images', { sequence_ids: 'other', fields: 'id' })).json.data,
    [],
  );
});

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
