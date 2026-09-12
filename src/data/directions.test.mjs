import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import directionsLayer, {
  DEFAULT_DIRECTIONS_MODE,
  DIRECTIONS_MODES,
  DIRECTIONS_ROUTE_COLOR,
  createDirectionsStepOverlayEntry,
  directionsRequestUrl,
  directionsRowControls,
  directionsStats,
  directionsStepCopy,
  normalizeDirectionsParams,
  normalizeRoutePayload,
} from './directions.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';

const idle = { enabled: true, mode: 'car', armed: null, a: null, b: null, status: 'idle', error: null, route: null, lastUpdate: null };
const A = { lat: 60.1699, lon: 24.9384 };
const B = { lat: 60.2055, lon: 24.6559 };
const route = {
  distanceM: 21479,
  durationS: 1478,
  geometry: [[24.9384, 60.1699], [24.6559, 60.2055]],
  steps: [
    { index: 0, instruction: 'Head out on Kaivokatu', distanceM: 8, durationS: 1, lat: 60.1699, lon: 24.9384 },
    { index: 1, instruction: 'Turn right onto Kansakoulukatu', distanceM: 236, durationS: 39, lat: 60.1683, lon: 24.9349 },
    { index: 2, instruction: 'Arrive at your destination', distanceM: 0, durationS: 0, lat: 60.2055, lon: 24.6559 },
  ],
  mode: 'car',
};

test('layer module declares the manager contract, params, and row controls', () => {
  assert.equal(directionsLayer.id, 'directions');
  assert.equal(directionsLayer.updateInterval, 0);
  for (const method of ['init', 'enable', 'disable', 'update', 'getStats', 'destroy', 'setParams', 'getParams', 'getRowControls', 'setRowControlsListener', 'attachDataManager']) {
    assert.equal(typeof directionsLayer[method], 'function', `${method} is implemented`);
  }
  assert.deepEqual(directionsLayer.getParams(), { mode: DEFAULT_DIRECTIONS_MODE });
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'directions');
  assert.ok(entry, 'directions has a share-link token');
  assert.equal(LAYER_STATE_REGISTRY.filter((row) => row.token === entry.token).length, 1);
  assert.ok(SPRITE_LAYER_ORDER.includes('directions'));
});

test('params: unknown modes are rejected, commands and arm state are normalized', () => {
  assert.deepEqual(normalizeDirectionsParams({ mode: 'FOOT' }), { mode: 'foot' });
  assert.equal(normalizeDirectionsParams({ mode: 'rocket' }), null);
  assert.deepEqual(normalizeDirectionsParams({ arm: 'a' }), { arm: 'a' });
  assert.deepEqual(normalizeDirectionsParams({ arm: 'zzz' }), { arm: null });
  assert.deepEqual(normalizeDirectionsParams({ swap: true, fly: true, clear: true }), { swap: true, fly: true, clear: true });
  assert.deepEqual(normalizeDirectionsParams({ swap: 'yes' }), {});
  assert.deepEqual(normalizeDirectionsParams(), {});
  // The live module refuses an unknown mode without touching state.
  assert.equal(directionsLayer.setParams({ mode: 'rocket' }), false);
  assert.deepEqual(directionsLayer.getParams(), { mode: DEFAULT_DIRECTIONS_MODE });
});

test('row chips: modes, arming, and command availability follow the state', () => {
  const { chips } = directionsRowControls(idle);
  const ids = chips.map((c) => c.id);
  assert.deepEqual(ids, ['mode-car', 'mode-foot', 'mode-bike', 'set-a', 'set-b', 'swap', 'fly', 'clear']);
  assert.equal(chips.find((c) => c.id === 'mode-car').active, true);
  assert.equal(chips.find((c) => c.id === 'set-a').label, 'SET A');
  assert.deepEqual(chips.find((c) => c.id === 'set-a').params, { arm: 'a' });
  assert.equal(chips.find((c) => c.id === 'fly').disabled, true);
  assert.equal(chips.find((c) => c.id === 'swap').disabled, true);
  assert.equal(chips.find((c) => c.id === 'clear').disabled, true);

  const armed = directionsRowControls({ ...idle, armed: 'a' }).chips;
  assert.equal(armed.find((c) => c.id === 'set-a').label, 'CLICK MAP');
  assert.deepEqual(armed.find((c) => c.id === 'set-a').params, { arm: null }, 'clicking again cancels');

  const ready = directionsRowControls({ ...idle, a: A, b: B, status: 'ready', route }).chips;
  assert.equal(ready.find((c) => c.id === 'set-a').label, 'A ✓');
  assert.equal(ready.find((c) => c.id === 'fly').disabled, false);
  assert.equal(ready.find((c) => c.id === 'swap').disabled, false);
  assert.equal(ready.find((c) => c.id === 'clear').disabled, false);

  const routing = directionsRowControls({ ...idle, a: A, b: B, status: 'routing' }).chips;
  assert.equal(routing.find((c) => c.id === 'fly').busy, true);
  for (const mode of Object.keys(DIRECTIONS_MODES)) assert.ok(ids.includes(`mode-${mode}`));
});

test('stats guide the user, show progress, and summarize a route honestly', () => {
  assert.equal(directionsStats(idle).coverage, 'SET A, then click the globe');
  assert.equal(directionsStats({ ...idle, armed: 'b' }).coverage, 'Click the globe to place B');
  assert.equal(directionsStats({ ...idle, a: A }).coverage, 'SET B, then click the globe');
  const routing = directionsStats({ ...idle, a: A, b: B, status: 'routing' });
  assert.equal(routing.loading, true);
  const ready = directionsStats({ ...idle, a: A, b: B, status: 'ready', route, lastUpdate: 5 });
  assert.equal(ready.count, 3);
  assert.equal(ready.coverage, '21 km · 25 min · Drive');
  assert.equal(ready.loadingLabel, '21 km · 25 min · Drive', 'the summary is the row detail line');
  assert.equal(ready.loading, undefined);
  assert.equal(directionsStats(idle).loadingLabel, 'SET A, then click the globe');
  const failed = directionsStats({ ...idle, a: A, b: B, status: 'error', error: 'No route found between A and B' });
  assert.equal(failed.error, 'No route found between A and B');
  assert.equal(failed.count, 0);
  assert.equal(directionsLayer.getStats().count, 0);
});

test('step cards name the maneuver, its leg, and what comes next', () => {
  const copy = directionsStepCopy(route.steps, 1);
  assert.equal(copy.title, 'Turn right onto Kansakoulukatu');
  assert.deepEqual(copy.details, ['Step 2 of 3 · then 240 m · 39 s', 'Then: Arrive at your destination']);
  const last = directionsStepCopy(route.steps, 2);
  assert.deepEqual(last.details, ['Step 3 of 3']);
  const position = Cesium.Cartesian3.fromDegrees(24.9349, 60.1683, 2);
  const card = createDirectionsStepOverlayEntry(1, position, copy);
  assert.equal(card.accent, DIRECTIONS_ROUTE_COLOR);
  assert.equal(card.id, 'directions-step-1');
  assert.equal(createDirectionsStepOverlayEntry(null, position, copy), null);
});

test('the proxy request carries both endpoints, the profile, and asks for steps', () => {
  const url = directionsRequestUrl('foot', A, B);
  assert.match(url, /^\/api\/route\?profile=foot&coords=24\.938400%2C60\.169900%3B24\.655900%2C60\.205500&steps=1$/);
});

test('route payloads are validated; a failed route never becomes a straight line', () => {
  const ok = normalizeRoutePayload({ ok: true, distanceM: 21479, durationS: 1478, geometry: route.geometry, steps: route.steps }, 'car');
  assert.equal(ok.distanceM, 21479);
  assert.equal(ok.steps.length, 3);
  assert.equal(ok.mode, 'car');
  assert.equal(normalizeRoutePayload({ ok: false, error: 'no route found' }, 'car'), null);
  assert.equal(normalizeRoutePayload({ ok: true, geometry: [[1, 1]] }, 'car'), null);
  assert.equal(normalizeRoutePayload({ ok: true, geometry: [[999, 1], [1, 1]] }, 'car'), null);
  const noSteps = normalizeRoutePayload({ ok: true, geometry: route.geometry }, 'bike');
  assert.deepEqual(noSteps.steps, []);
  assert.equal(normalizeRoutePayload(null, 'car'), null);
});
