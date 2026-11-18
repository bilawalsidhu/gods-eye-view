import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installViews } from './embed.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { createAnnotationEngine } from '../annotations/annotationEngine.js';
import { fakeCesiumViewer } from '../testSupport/streetLevelFakes.mjs';

// A camera taken while a posted view waits on terrain stays with whoever took
// it: the stale view stands down whole, so it neither stops a newer follow nor
// frames its own marks. Offline: real installViews, action runner and
// annotation engine; the viewer, renderer, flights data and terrain are fixtures.
globalThis.fetch = async () => { throw new Error('Unexpected network request in offline reproduction'); };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function scenario(t, effect) {
  document.body.className = '';
  const entered = deferred();
  const terrain = deferred();
  const viewer = fakeCesiumViewer();
  viewer.clock = { onTick: new Cesium.Event() };
  viewer.canvas = viewer.scene.canvas;
  // A real perspective frustum looking down at 0,0; the old view's mark
  // at 48N,2E is outside it. No override of the engine's visibility logic.
  Object.assign(viewer.camera, {
    position: Cesium.Cartesian3.fromDegrees(0, 0, 1000),
    direction: new Cesium.Cartesian3(-1, 0, 0),
    up: new Cesium.Cartesian3(0, 0, 1),
    heading: 0,
    frustum: new Cesium.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 20000000 }),
  });
  const entity = { id: 'fixture-aircraft' };
  const aircraft = { icao24: 'fixture', callsign: 'Fixture', latitude: 0, longitude: 0 };
  let stopCalls = 0;
  const flights = {
    findByQuery: () => aircraft,
    trackById: () => { viewer.trackedEntity = entity; return true; },
    getTrackedInfo: () => viewer.trackedEntity ? aircraft : null,
    stopTracking: () => { stopCalls++; viewer.trackedEntity = undefined; return true; },
  };
  const dataManager = {
    layers: new Map([['flights', { module: flights }]]),
    getAll: () => [{ id: 'flights', enabled: true }],
    isEnabled: id => id === 'flights',
    setLayerParams: () => true,
  };
  const shell = {
    _navigationGeneration: 1,
    initialRestorePromise: Promise.resolve(),
    setCleanView() {},
    runImmediateNavigation(_noun, navigate) { this._navigationGeneration++; return navigate(); },
  };
  const annotations = createAnnotationEngine({ viewer,
    renderer: { add() {}, update() {}, remove() {}, sync() {}, destroy() {} },
  });
  const runner = createGevActionRunner({ viewer, dataManager, styleManager: shell, annotations });
  const calls = [];
  const run = async (name, args, options) => {
    calls.push(name);
    return runner(name, args, options);
  };
  const replies = [];
  const peer = { postMessage: message => replies.push(message) };
  const windowRef = new EventTarget();
  windowRef.parent = peer;
  windowRef.document = document;
  const remove = installViews({ shell, viewer, dataManager, run, windowRef,
    location: { search: '?embed=1', hash: '' },
    terrain: { getHeights: () => { entered.resolve(); return terrain.promise; } },
  });
  t.after(() => { remove(); runner.dispose(); annotations.destroy(); document.body.className = ''; });
  await tick();
  const event = new Event('message');
  Object.assign(event, { source: peer, origin: 'https://host.example', data: {
    type: 'gev:view', id: 1, view: {
      camera: { lat: 48, lon: 2, altitude_m: 1000, pitch_deg: -45 },
      layers: ['flights'],
      street_level: { provider: 'mapillary' },
      annotations: effect === 'annotations'
        ? [{ type: 'pin', latitude: 48, longitude: 2, label: 'Old view' }] : [],
    },
  } });
  windowRef.dispatchEvent(event);
  await entered.promise;
  if (effect === 'follow') {
    const follow = await runner('track_entity', { query: 'Fixture', layerId: 'flights' });
    assert.equal(follow.ok, true, 'new follow starts through the real runner');
    assert.equal(viewer.trackedEntity, entity);
  } else {
    viewer.canvas.dispatchEvent(new Event('pointerdown'));
  }
  terrain.resolve([{ ellipsoid: 200 }]);
  for (let n = 0; n < 50 && !replies.some(reply => reply.id === 1); n++) await tick();
  const reply = replies.find(reply => reply.id === 1);
  t.diagnostic(JSON.stringify({ effect, calls, stopCalls, followed: viewer.trackedEntity === entity,
    annotationCount: annotations.count(), annotationFlights: viewer.flights.started, reply }));
  assert.ok(reply, 'host receives completion');
  assert.equal(reply.ok, false, 'superseded view is acknowledged as not applied');
  assert.ok(!calls.includes('show_street_level'), 'superseded request never reaches photo handler');
  if (effect === 'follow') {
    assert.equal(stopCalls, 0, 'stale view must not stop the newer follow');
    assert.equal(viewer.trackedEntity, entity, 'the new tracked entity stays selected');
  } else {
    assert.equal(viewer.flights.started, 0, 'stale annotations must not fly the camera');
  }
}

for (const effect of ['follow', 'annotations']) {
  test(`a camera taken during the terrain wait keeps the user's ${effect}`, { timeout: 5000 }, t => scenario(t, effect));
}
