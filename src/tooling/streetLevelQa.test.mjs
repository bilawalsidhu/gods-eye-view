import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerMapillaryRequest,
  describeCall,
  PHOTO_SEQUENCE_ID,
  photoImages,
  THUMB_HOST,
} from '../../scripts/fixtures/street-level/mapillaryGraph.mjs';
import { redact } from '../../scripts/qa-browserEvidence.mjs';

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
