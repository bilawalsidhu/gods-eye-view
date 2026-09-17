import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHandlers,
  frameUrlFor,
  listCameras,
  schemas,
  selectCameras,
  verdictFor,
} from './cameraSweep.js';
import { LOCAL_TOOL_NAMES } from '../localToolSchemas.js';

// Downtown Austin, then cameras spreading out along a line north.
const HERE = { lat: 30.2672, lon: -97.7431, alt: 3000, heading: 0, pitch: -45, roll: 0 };
function cams(n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    id: `cam-${i}`,
    name: `Congress & ${i + 1}th`,
    city: 'Austin',
    lat: HERE.lat + i * 0.01,
    lon: HERE.lon,
    headingDeg: 90,
    fovDeg: 70,
    pitchDeg: -10,
    sourceKind: 'txdot-its',
    sourceStatus: 'ok',
  }));
}

function globe(cameras = cams(), { enabled = true } = {}) {
  const annotateCalls = [];
  let cleared = 0;
  return {
    annotateCalls,
    clearedCount: () => cleared,
    dataManager: {
      isEnabled: (id) => id === 'cctv' && enabled,
      layers: { get: (id) => (id === 'cctv' ? { module: { getUIState: () => ({ cameras }) } } : undefined) },
    },
    styleManager: { getCameraState: () => HERE },
    annotations: {
      annotate: async (specs) => {
        annotateCalls.push(specs);
        return { drawn: specs.length, failed: 0, results: [] };
      },
      clear: () => {
        cleared += 1;
      },
    },
  };
}

function jpegResponse(id, { source = 'upstream-image', type = 'image/jpeg', ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => ({ 'x-cctv-source': source, 'content-type': type })[k.toLowerCase()] },
    blob: async () => ({ id, size: 1000 }),
  };
}

function fakeVision(scoreFor = () => 0.5) {
  const posts = [];
  return {
    posts,
    fetchJson: async (url, body) => {
      posts.push({ url, body });
      return {
        ok: true,
        results: body.images.map((i) => ({ id: i.id, label: i.label, lat: i.lat, lon: i.lon, answer: `verdict ${i.id}`, score: scoreFor(i.id), ms: 900 })),
        summary: { high: [], low: [] },
        dropped: [],
      };
    },
  };
}

test('pack schemas are registered as local tools', () => {
  assert.deepEqual(schemas.map((s) => s.name), ['camera_sweep', 'clear_camera_marks']);
  assert.ok(LOCAL_TOOL_NAMES.includes('camera_sweep'));
  assert.ok(LOCAL_TOOL_NAMES.includes('clear_camera_marks'));
  assert.equal(schemas[0].parameters.additionalProperties, false);
  assert.deepEqual(schemas[0].parameters.required, ['question']);
});

test('verdict bands and frame URL construction', () => {
  assert.equal(verdictFor(0.6), 'red');
  assert.equal(verdictFor(0.59), 'amber');
  assert.equal(verdictFor(0.4), 'green');
  assert.equal(verdictFor(NaN), 'amber');
  const url = frameUrlFor(cams(1)[0], () => 123_456);
  assert.ok(url.startsWith('/api/cctv/frame/cam-0?'));
  const params = new URL(`http://x${url}`).searchParams;
  assert.equal(params.get('label'), 'Congress & 1th');
  assert.equal(params.get('lat'), '30.267200');
  assert.equal(params.get('heading'), '90');
  assert.equal(params.get('ts'), '12');
  assert.equal(params.get('sweep'), '1');
  const bare = frameUrlFor({ id: 'a b' }, () => 0);
  assert.ok(bare.startsWith('/api/cctv/frame/a%20b?ts=0'));
});

test('listCameras reads the layer UI state and reports off/unavailable layers', () => {
  assert.equal(listCameras(globe()).cameras.length, 10);
  assert.match(listCameras(globe(cams(), { enabled: false })).error, /off/);
  assert.match(listCameras({ dataManager: { layers: { get: () => undefined } } }).error, /unavailable/);
  assert.match(listCameras(globe([])).error, /No cameras/);
  const viaObjects = listCameras({
    viewer: { scene: { globe: { ellipsoid: { cartesianToCartographic: (p) => ({ latitude: p.lat, longitude: p.lon }) } } } },
    dataManager: { layers: { get: () => ({ module: { getDetectableObjects: () => [{ sourceId: 'z', position: { lat: Math.PI / 6, lon: -Math.PI / 2 } }] } }) } },
  });
  assert.equal(viaObjects.cameras[0].id, 'z');
  assert.ok(Math.abs(viaObjects.cameras[0].lat - 30) < 1e-9);
});

test('selectCameras picks nearest in scope and pushes placeholder feeds last', () => {
  const list = cams(10);
  list[0] = { ...list[0], sourceKind: 'synthetic' };
  const radius = selectCameras(list, { kind: 'radius', km: 3 }, HERE, 3);
  // 0.01 deg lat ≈ 1.11 km; cams 0,1,2 are within 3 km but cam-0 is synthetic
  assert.deepEqual(radius.selected.map((c) => c.id), ['cam-1', 'cam-2', 'cam-0']);
  assert.equal(radius.inScopeCount, 3);
  assert.equal(radius.selected[0].distanceKm, 1.1);
  const explicit = selectCameras(list, { kind: 'radius', latitude: HERE.lat + 0.09, longitude: HERE.lon, km: 2 }, null, 5);
  assert.deepEqual(explicit.selected.map((c) => c.id), ['cam-9', 'cam-8']);
  const anywhere = selectCameras(list, { kind: 'anywhere' }, HERE, 2);
  assert.deepEqual(anywhere.selected.map((c) => c.id), ['cam-1', 'cam-2']);
  const view = selectCameras(list, { kind: 'view' }, HERE, 20);
  assert.equal(view.inScopeCount, 10);
  // No camera position and no explicit point: the scope cannot resolve, so
  // nothing is filtered and rows carry no distance (the handler refuses this
  // case before it gets here for view/radius scopes).
  assert.equal(selectCameras(list, { kind: 'view' }, null, 5).selected[0].distanceKm, null);
});

test('camera_sweep fetches nearest frames, skips failures, posts the batch and marks the map by score', async () => {
  const g = globe();
  const fetched = [];
  const fetchImpl = async (url) => {
    const id = decodeURIComponent(url.split('?')[0].split('/').pop());
    fetched.push(id);
    if (id === 'cam-1') return jpegResponse(id, { ok: false, status: 502 });
    if (id === 'cam-2') return jpegResponse(id, { source: 'synthetic', type: 'image/svg+xml' });
    return jpegResponse(id);
  };
  const vision = fakeVision((id) => ({ 'cam-0': 0.9, 'cam-3': 0.2, 'cam-4': 0.5, 'cam-5': 0.7 })[id] ?? 0.5);
  const spoken = [];
  const handlers = createHandlers({
    getGlobe: () => g,
    camera: () => HERE,
    fetchJson: vision.fetchJson,
    fetchImpl,
    encodeFrame: async (blob) => `b64-${blob.id}`,
    speak: (t) => spoken.push(t),
    now: () => 0,
  });
  const out = await handlers.camera_sweep({ question: 'Is traffic jammed?', scope: { kind: 'radius', km: 20 }, max: 4 });
  assert.equal(out.ok, true, JSON.stringify(out));
  // 4 wanted: cam-0..3 fetched first; 1 and 2 failed so 4 and 5 filled in.
  assert.deepEqual(fetched, ['cam-0', 'cam-1', 'cam-2', 'cam-3', 'cam-4', 'cam-5']);
  assert.equal(vision.posts[0].url, '/api/voice/vision-batch');
  assert.equal(vision.posts[0].body.question, 'Is traffic jammed?');
  assert.deepEqual(vision.posts[0].body.images.map((i) => i.id), ['cam-0', 'cam-3', 'cam-4', 'cam-5']);
  assert.equal(vision.posts[0].body.images[0].image, 'b64-cam-0');
  assert.equal(vision.posts[0].body.images[0].lat, HERE.lat);
  assert.equal(out.checked, 4);
  assert.deepEqual(out.counts, { red: 2, amber: 1, green: 1 });
  assert.deepEqual(out.red.map((r) => r.label), ['Congress & 1th', 'Congress & 6th']);
  assert.deepEqual(out.skipped.map((s) => s.id), ['cam-1', 'cam-2']);
  assert.match(out.skipped[1].reason, /placeholder/);
  assert.equal(out.cameras[1].verdict, 'green');
  assert.equal(out.cameras[1].distanceKm, 3.3);
  assert.match(out.summary, /^2 of 4 cameras: yes \(Congress & 1th, Congress & 6th\); 1 no; 1 unsure; 2 skipped\.$/);
  assert.deepEqual(spoken, ['Checking 4 cameras.']);
  // Marks went straight to the annotation engine (no runner injected).
  assert.equal(out.marked, 4);
  const specs = g.annotateCalls[0];
  assert.deepEqual(specs.map((s) => s.color), ['red', 'green', 'amber', 'red']);
  assert.deepEqual(specs.map((s) => s.type), ['pin', 'pin', 'pin', 'pin']);
  assert.equal(specs[0].latitude, HERE.lat);
  assert.equal(specs[0].label, 'Congress & 1th: verdict cam-0');
});

test('camera_sweep routes marks and clears through the action runner when present', async () => {
  const g = globe();
  const runs = [];
  const runner = async (name, args) => {
    runs.push({ name, args });
    return name === 'annotate_map' ? { ok: true, drawn: args.annotations.length } : { ok: true };
  };
  const handlers = createHandlers({
    getGlobe: () => g,
    camera: () => HERE,
    fetchJson: fakeVision(() => 0.95).fetchJson,
    fetchImpl: async (url) => jpegResponse(url),
    encodeFrame: async () => 'x',
    runner,
  });
  const out = await handlers.camera_sweep({ question: 'Flooded?', max: 2 });
  assert.equal(out.ok, true);
  assert.equal(runs[0].name, 'annotate_map');
  assert.equal(runs[0].args.annotations.length, 2);
  assert.equal(out.marked, 2);
  assert.equal(g.annotateCalls.length, 0);
  const cleared = await handlers.clear_camera_marks();
  assert.deepEqual(cleared, { ok: true, cleared: 'annotations' });
  assert.equal(runs[1].name, 'clear_annotations');

  const quiet = await handlers.camera_sweep({ question: 'Flooded?', max: 1, mark: false });
  assert.equal(quiet.marked, 0);
  assert.equal(runs.filter((r) => r.name === 'annotate_map').length, 1);
});

test('camera_sweep explains missing layer, empty scope, dead frames and vision failures', async () => {
  const base = { camera: () => HERE, fetchImpl: async (u) => jpegResponse(u), encodeFrame: async () => 'x' };
  const off = createHandlers({ ...base, getGlobe: () => globe(cams(), { enabled: false }), fetchJson: async () => ({ ok: true }) });
  assert.match((await off.camera_sweep({ question: 'q' })).error, /off/);

  const none = createHandlers({ ...base, getGlobe: () => globe(), fetchJson: async () => ({ ok: true }) });
  assert.match((await none.camera_sweep({ question: 'q', scope: { kind: 'radius', latitude: 0, longitude: 0, km: 5 } })).error, /No cameras in that area/);
  assert.match((await none.camera_sweep({ question: ' ' })).error, /question/);

  const dead = createHandlers({ ...base, getGlobe: () => globe(), fetchJson: async () => ({ ok: true }), fetchImpl: async () => { throw new Error('offline'); } });
  const deadOut = await dead.camera_sweep({ question: 'q', max: 2 });
  assert.match(deadOut.error, /usable frame/);
  assert.equal(deadOut.skipped.length, 6);

  const broken = createHandlers({ ...base, getGlobe: () => globe(), fetchJson: async () => ({ ok: false, error: 'Ollama down' }) });
  assert.equal((await broken.camera_sweep({ question: 'q', max: 1 })).error, 'Ollama down');

  const noCam = createHandlers({ ...base, camera: () => null, getGlobe: () => ({ ...globe(), styleManager: {} }), fetchJson: async () => ({ ok: true }) });
  assert.match((await noCam.camera_sweep({ question: 'q' })).error, /position/);

  const direct = createHandlers({ ...base, getGlobe: () => globe(), fetchJson: async () => ({ ok: true }) });
  const g = globe();
  const direct2 = createHandlers({ ...base, getGlobe: () => g, fetchJson: async () => ({ ok: true }) });
  await direct2.clear_camera_marks();
  assert.equal(g.clearedCount(), 1);
  assert.equal(typeof direct.clear_camera_marks, 'function');
});
