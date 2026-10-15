import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { cctvProxy } from '../../server/providers/cctv.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { normalizeCctvEmbedUrl } from '../sources/cctvTypes.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createGeometry } from '../layers/cctv/geometry.js';
import { createProjection } from '../layers/cctv/projection.js';
import { createPresentation } from '../layers/cctv/presentation.js';

const cameras = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_sources.youtube.json', import.meta.url),
  ),
);
const camera = normalizeSourceItem(cameras[0]);

function restoreEnv(t) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });
}

for (const camera of cameras) {
  test(`API exposes ${camera.id} and refuses frame/media fallbacks without fetching`, async (t) => {
    restoreEnv(t);
    process.env.CCTV_SOURCES_JSON = JSON.stringify([camera]);
    process.env.CCTV_FORCE_AUSTIN = '0';
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      throw new Error('No upstream request expected');
    });
    let middleware;
    cctvProxy({ sourceRoot: '/nonexistent' }).configureServer({
      middlewares: {
        use(_prefix, handler) {
          middleware = handler;
        },
      },
    });
    const get = async (url) => {
      let status;
      let body;
      await middleware(
        { url, method: 'GET', headers: {} },
        {
          writeHead(value) {
            status = value;
          },
          end(value) {
            body = JSON.parse(value);
          },
        },
      );
      return { status, body };
    };
    const catalog = await get('/sources');
    assert.equal(catalog.status, 200);
    assert.equal(
      catalog.body.sources[0].embedUrl,
      normalizeCctvEmbedUrl(camera.embedUrl),
    );
    assert.equal(catalog.body.sources[0].locationNote, camera.locationNote);
    const stream = await get(`/stream/${camera.id}`);
    assert.equal(stream.body.embedUrl, normalizeCctvEmbedUrl(camera.embedUrl));
    assert.equal(stream.body.mediaUrl, null);
    assert.equal(stream.body.frameUrl, null);
    for (const path of ['frame', 'media']) {
      const result = await get(`/${path}/${camera.id}`);
      assert.equal(result.status, 409);
      assert.match(result.body.error, /frames are not available/);
    }
    assert.equal(requests, 0);
  });
}

test('embedded cameras never fetch a frame or allocate projection and coverage geometry', async () => {
  let requests = 0;
  const source = createCctvSource({
    fetchImpl: async () => {
      requests++;
    },
  });
  assert.equal(source.getFrameUrl(camera), null);
  assert.equal(source.getMediaUrl(camera), null);
  await assert.rejects(source.getFrame(camera), /frames are not available/);
  assert.equal(requests, 0);
  const record = { camera };
  const parts = {};
  const services = { ground: {}, mesh: {}, render: {} };
  const state = { _records: [record] };
  const geometry = createGeometry({ state, services, parts });
  assert.deepEqual(
    geometry.materializeCctvActiveCoverageEntities(record, () => {
      throw new Error(
        'An approximate player must not claim calibrated coverage',
      );
    }),
    [],
  );
  assert.equal(geometry.buildCoverageVisibleSet(record).size, 0);
  assert.equal(geometry.coverageNeighborCount(record), 0);
  assert.equal(
    geometry.coverageNeighborCount({ camera: { feedType: 'image' } }),
    0,
  );
  const projection = createProjection({ state, services, parts });
  assert.equal(projection.ensureProjectionRuntime(record), null);
});

test('public camera state labels external playback without claiming live health or a known pose', () => {
  const record = { camera };
  const presentation = createPresentation({
    state: { _healthById: new Map() },
    services: {},
    parts: {
      selection: { getActiveRecord: () => record },
      model: { isVideoFeedType: () => false },
      calibration: {
        normalizeCalibration: () => ({}),
        deriveCalBadge: () => 'raw-prior',
      },
      frames: {
        frameUrlFor() {
          throw new Error('No frame URL');
        },
        mediaUrlFor() {
          throw new Error('No media URL');
        },
      },
    },
  });
  const state = presentation.getPublicCameraState(record);
  assert.equal(state.sourceStatus, 'external');
  assert.equal(state.isVideo, false);
  assert.equal(state.embedUrl, camera.embedUrl);
  for (const key of [
    'headingDeg',
    'pitchDeg',
    'fovDeg',
    'rangeM',
    'mountHeightM',
    'frameUrl',
    'mediaUrl',
  ])
    assert.equal(state[key], null, key);
  assert.match(presentation.buildSummaryText(), /APPROXIMATE LOCATION/);
});
