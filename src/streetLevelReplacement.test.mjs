import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreetLevelLayer } from './layers/streetLevel/index.js';
import { fakeStreetLevelProvider, fakeCesiumViewer } from './testSupport/streetLevelFakes.mjs';
import { showStreetLevel } from './voice/gevActions.js';
import { installViews } from './app/embed.js';
import { groundedLookAt } from './view/index.js';
import { composeCatalog, coreTools } from './tools/index.js';

// Replacing a street-level photo, across sources and against the user's own
// moves; posted views waiting on terrain, and their look-at near a pole.
// Offline: providers, lookups, terrain and flights are fixtures.
globalThis.fetch = async () => { throw new Error('Unexpected network use in offline test'); };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function provider(id, { nearest = async () => 'B', load = async () => {}, billed = false } = {}) {
  const def = fakeStreetLevelProvider({ id, pickPrefix: id + ':', nearestImage: nearest });
  def.name = id;
  def.label = id.toUpperCase();
  def.billedPerImage = billed;
  const create = def.create;
  def.create = context => {
    const instance = create(context);
    let pose;
    instance.viewer.onPose = listener => { pose = listener; return () => { pose = null; }; };
    instance.viewer.open = async imageId => {
      def.calls.open.push(imageId);
      await load(imageId);
      pose?.({ imageId, position: { lat: 48, lon: 2 }, creator: 'fixture photographer',
        externalUrl: 'https://www.mapillary.com/app/?pKey=' + imageId });
    };
    return instance;
  };
  return def;
}
async function harness(t, defs) {
  document.body.className = '';
  document.body.replaceChildren();
  const viewer = fakeCesiumViewer();
  viewer.canvas = viewer.scene.canvas;
  viewer.canvas.setPointerCapture = () => {};
  const layer = createStreetLevelLayer({ providers: defs });
  layer.init(viewer);
  layer.enable(viewer);
  layer.attachViewerHost(document.body.appendChild(document.createElement('div')));
  t.after(() => { layer.destroy(); document.body.className = ''; document.body.replaceChildren(); });
  await settle();
  const dataManager = {
    layers: new Map([['street-level', { module: layer }]]),
    getAll: () => [{ id: 'street-level', enabled: true }],
    isEnabled: () => true,
    getLayerParams: () => ({ mapillary: true }),
    setLayerParams: (_id, params) => layer.setParams(params),
  };
  const shell = { _navigationGeneration: 1, initialRestorePromise: Promise.resolve(), setCleanView() {} };
  const flights = [];
  const context = { viewer, dataManager, styleManager: shell,
    runOptions: { signal: new AbortController().signal },
    runGevAction: async (name, args) => {
      assert.equal(name, 'fly_to_location');
      flights.push(args);
      return { ok: true, latitude: args.latitude, longitude: args.longitude, label: 'fixture point' };
    },
  };
  const run = (name, args) => name === 'show_street_level' ? showStreetLevel(args, context) : Promise.resolve({ ok: true });
  return { layer, viewer, dataManager, shell, context, run, flights };
}
async function embed(t, h, terrain) {
  const replies = [];
  const peer = { postMessage: message => replies.push(message) };
  const windowRef = new EventTarget();
  windowRef.parent = peer;
  windowRef.document = document;
  const remove = installViews({ ...h, terrain, windowRef, location: { search: '?embed=1', hash: '' } });
  t.after(remove);
  await settle();
  const post = (id, view) => {
    const event = new Event('message');
    Object.assign(event, { source: peer, origin: 'https://host.example', data: { type: 'gev:view', id, view } });
    windowRef.dispatchEvent(event);
  };
  return { post, replies };
}
const args = provider => ({ provider, latitude: 48, longitude: 2, fly: false });
const view = pitch => ({ camera: { lat: 48, lon: 2, altitude_m: 1000, pitch_deg: pitch }, street_level: { provider: 'mapillary' } });

for (const outcome of ['empty', 'error']) {
  test('a replacement from another source that opens nothing keeps its explanation (' + outcome + ')', async t => {
    const a = provider('mapillary');
    const b = provider('panoramax', { nearest: async () => {
      if (outcome === 'error') throw new Error('Fixture lookup failure');
      return null;
    } });
    const h = await harness(t, [a, b]);
    assert.equal(await h.layer.openImage('mapillary', 'A', { frame: false }), true);
    const result = await showStreetLevel(args('panoramax'), h.context);
    const street = h.layer.getUIState().street;
    t.diagnostic(JSON.stringify({ result, error: street.error, nearestOutcome: street.nearestOutcome }));
    assert.equal(result.ok, false);
    assert.equal(street.open, false);
    assert.ok(street.error, 'replacement explanation must survive release');
    if (outcome === 'empty') assert.equal(street.nearestOutcome, 'empty');
  });
}
test('an arming link from another source keeps its armed point', async t => {
  const h = await harness(t, [provider('mapillary'), provider('google', { billed: true })]);
  assert.equal(await h.layer.openImage('mapillary', 'A', { frame: false }), true);
  const result = await showStreetLevel({ ...args('google'), autoOpen: false }, h.context);
  const street = h.layer.getUIState().street;
  t.diagnostic(JSON.stringify({ result, armed: street.armed }));
  assert.equal(result.armed, true);
  assert.deepEqual(street.armed?.point, { lat: 48, lon: 2 });
});
test('a same-source lookup that finds nothing keeps its explanation', async t => {
  const h = await harness(t, [provider('mapillary', { nearest: async () => null })]);
  await h.layer.openImage('mapillary', 'A', { frame: false });
  const result = await showStreetLevel(args('mapillary'), h.context);
  assert.equal(result.noImagery, true);
  assert.ok(h.layer.getUIState().street.error);
  assert.equal(h.layer.getUIState().street.nearestOutcome, 'empty');
});

for (const takeover of ['navigation', 'gesture', 'none']) {
  test('a posted view waiting on terrain yields to the user (' + takeover + ')', async t => {
    const a = provider('mapillary');
    const h = await harness(t, [a]);
    const entered = deferred();
    const terrain = deferred();
    const e = await embed(t, h, { getHeights: async () => { entered.resolve(); return terrain.promise; } });
    e.post(1, view(-45));
    await entered.promise;
    if (takeover === 'navigation') h.shell._navigationGeneration++;
    if (takeover === 'gesture') h.viewer.canvas.dispatchEvent(new Event('pointerdown'));
    terrain.resolve([{ ellipsoid: 200 }]);
    for (let n = 0; n < 8 && !e.replies.some(r => r.id === 1); n++) await settle();
    const reply = e.replies.find(r => r.id === 1);
    t.diagnostic(JSON.stringify({ takeover, flights: h.flights, opened: a.calls.open, reply }));
    assert.ok(reply, 'host receives completion');
    assert.equal(h.flights.length, takeover === 'none' ? 1 : 0, 'superseded view must not reclaim the camera');
    assert.equal(a.calls.open.length, takeover === 'none' ? 1 : 0);
    assert.equal(reply.ok, takeover === 'none');
  });
}

test('a posted view looking at the horizon does not wait on terrain or hold the queue', async t => {
  const h = await harness(t, [provider('mapillary')]);
  const terrain = deferred();
  let terrainCalls = 0;
  const e = await embed(t, h, { getHeights: () => { terrainCalls++; return terrain.promise; } });
  e.post(1, view(0));
  e.post(2, { ...view(-90), street_level: { provider: 'mapillary', lat: 49, lon: 3 } });
  for (let n = 0; n < 8; n++) await settle();
  const before = e.replies.filter(r => r.id).map(r => r.id);
  terrain.resolve([{ ellipsoid: 200 }]);
  for (let n = 0; n < 8 && !e.replies.some(r => r.id === 2); n++) await settle();
  const after = e.replies.filter(r => r.id).map(r => r.id);
  t.diagnostic(JSON.stringify({ terrainCalls, before, after, flights: h.flights }));
  assert.deepEqual(after, [1, 2], 'both complete after irrelevant terrain is released');
  assert.deepEqual(before, [1, 2], 'both should complete without any terrain response');
  assert.equal(terrainCalls, 0);
});

for (const initial of [true, false]) {
  test('a source switched by hand during the load stops the request (photo open before: ' + initial + ')', async t => {
    const entered = deferred();
    const load = deferred();
    const a = provider('mapillary', { load: async id => { if (id === 'B') { entered.resolve(); await load.promise; } } });
    const h = await harness(t, [a, provider('panoramax')]);
    if (initial) await h.layer.openImage('mapillary', 'A', { frame: false });
    const request = showStreetLevel(args('mapillary'), h.context);
    await entered.promise;
    h.layer.setProviderEnabled('panoramax', true);
    load.resolve();
    const result = await request;
    const street = h.layer.getUIState().street;
    t.diagnostic(JSON.stringify({ initial, result, open: street.open, sourceOn: h.layer.providerStatus('mapillary').on }));
    assert.equal(h.layer.providerStatus('mapillary').on, false);
    assert.equal(street.open, false);
    assert.equal(result.ok, false, 'request for the disabled source must not report success');
    assert.equal(result.cancelled, true);
  });
}

test('a failed replacement from another source does not keep the old photo\'s details', async t => {
  const h = await harness(t, [provider('mapillary'), provider('panoramax', { load: async () => { throw new Error('Fixture image load failure'); } })]);
  await h.layer.openImage('mapillary', 'A', { frame: false });
  const before = h.layer.getUIState().street;
  assert.equal(before.imageId, 'A');
  assert.ok(before.externalUrl);
  const result = await showStreetLevel(args('panoramax'), h.context);
  const street = h.layer.getUIState().street;
  t.diagnostic(JSON.stringify({ result, street }));
  assert.equal(result.ok, false);
  assert.equal(street.providerId, 'panoramax');
  assert.match(street.error, /Fixture image load failure/);
  assert.deepEqual({ imageId: street.imageId, position: street.position, creator: street.creator, externalUrl: street.externalUrl },
    { imageId: null, position: null, creator: null, externalUrl: null }, 'destroyed provider photo must not be attributed to replacement');
});

const rejections = [];
process.on('unhandledRejection', reason => { rejections.push(String(reason?.message || reason)); });
// 111 m from the North Pole, looking east and down: 1 km ahead is more than a
// full turn of that parallel.
const north = { camera: { lat: 89.999, lon: 170, altitude_m: 1000, pitch_deg: -45, heading_deg: 90 }, street_level: { provider: 'mapillary' } };
const placed = { camera: { lat: 48, lon: 2, altitude_m: 1000, pitch_deg: -45 }, street_level: { provider: 'mapillary', lat: 48, lon: 2 } };

test('a grounded look-at near a pole stays on the globe', async () => {
  const point = await groundedLookAt(north.camera, { getHeights: async () => [{ ellipsoid: 0 }] });
  assert.ok(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180, JSON.stringify(point));
});

test('show_in_gods_eye_view frames the South Pole with a tilted camera', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' }, terrain: { getHeights: async () => [{ ellipsoid: 2835 }] } },
  });
  const result = await catalog.call('show_in_gods_eye_view', {
    camera: { lat: -90, lon: 0, altitude_m: 3500, pitch_deg: -30, heading_deg: 45 },
    street_level: { provider: 'mapillary' },
  });
  const street = result.data?.view?.street_level;
  assert.ok(street && Math.abs(street.lat) <= 90 && Math.abs(street.lon) <= 180, JSON.stringify(result));
});

test('a posted polar view is answered and the next view still applies', async t => {
  rejections.length = 0;
  const h = await harness(t, [provider('mapillary')]);
  const e = await embed(t, h, { getHeights: async () => [{ ellipsoid: 0 }] });
  e.post(1, north);
  e.post(2, placed);
  for (let n = 0; n < 20 && !e.replies.some(r => r.id === 2); n++) await settle();
  t.diagnostic(JSON.stringify({ replies: e.replies.filter(r => r.id), rejections }));
  assert.ok(e.replies.some(r => r.id === 1), 'the polar view gets an answer');
  assert.ok(e.replies.some(r => r.id === 2 && r.ok === true), 'the next view still applies');
  assert.deepEqual(rejections, [], 'no rejection escapes the views queue');
});

test('a stalled terrain answer does not hold posted views', { timeout: 15000 }, async t => {
  const h = await harness(t, [provider('mapillary')]);
  let asked = 0;
  // Hangs like a stalled upstream; gives up only when its signal aborts.
  const terrain = {
    getHeights: (_points, { signal } = {}) => {
      asked++;
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const e = await embed(t, h, terrain);
  e.post(1, view(-45));
  e.post(2, placed);
  const started = Date.now();
  while (Date.now() - started < 5000 && !e.replies.some(r => r.id === 2)) await new Promise(resolve => setTimeout(resolve, 100));
  t.diagnostic(JSON.stringify({ asked, waitedMs: Date.now() - started, replies: e.replies.filter(r => r.id).map(r => r.id) }));
  assert.equal(asked, 1);
  assert.ok(e.replies.some(r => r.id === 1), 'the view falls back to its own estimate within 5 s');
  assert.ok(e.replies.some(r => r.id === 2), 'the next view is not held behind it');
});

test('a posted view that throws is answered and does not hold the views behind it', async t => {
  rejections.length = 0;
  const h = await harness(t, [provider('mapillary')]);
  const getAll = h.dataManager.getAll;
  let calls = 0;
  h.dataManager.getAll = () => {
    if (calls++ === 0) throw new Error('Fixture layer list failure');
    return getAll();
  };
  const e = await embed(t, h, null);
  e.post(1, placed);
  e.post(2, placed);
  for (let n = 0; n < 20 && !e.replies.some(r => r.id === 2); n++) await settle();
  t.diagnostic(JSON.stringify({ replies: e.replies.filter(r => r.id), rejections }));
  assert.deepEqual(e.replies.find(r => r.id === 1), { type: 'gev:view-applied', id: 1, ok: false, error: 'Fixture layer list failure' });
  assert.ok(e.replies.some(r => r.id === 2 && r.ok === true), 'the next view still applies');
  assert.deepEqual(rejections, []);
});
