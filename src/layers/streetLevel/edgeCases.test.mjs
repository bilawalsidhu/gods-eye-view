// Edge cases for street-level:
// without a paid source, a late answer from a provider the user switched away
// from is ignored and the lit provider keeps the panel.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreetLevelLayer } from './index.js';
import {
  fakeStreetLevelProvider as fakeProvider,
  streetLevelMap,
} from '../../testSupport/streetLevelFakes.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

/** Two keyless providers; the first answers its nearest lookup on demand. */
async function twoProviders(t) {
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const lookups = [];
  const previous = fakeProvider({
    nearestImage: (point, { signal } = {}) => {
      const answer = deferred();
      lookups.push({ point, signal, answer });
      return answer.promise;
    },
  });
  const lit = fakeProvider({
    id: 'panoramax',
    pickPrefix: 'pmx:',
    nearestImage: async () => 'pmx-1',
  });
  const harness = streetLevelMap();
  const layer = createStreetLevelLayer({
    providers: [previous, lit],
    services: { createDisplay: () => harness.map },
  });
  layer.init(null, { engine: harness.engine });
  layer.enable();
  layer.attachViewerHost({});
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await settle();
  return { layer, previous, lit, lookups };
}

test('edge:street-level: a late nearest answer from the previous provider is ignored', async (t) => {
  const { layer, previous, lit, lookups } = await twoProviders(t);
  const stale = layer.openNearest({ lat: 38.58, lon: -121.49 });
  await settle();
  layer.setProviderEnabled('panoramax', true);
  assert.equal(await layer.openNearest({ lat: 38.58, lon: -121.49 }), true);
  lookups[0].answer.resolve('mly-late');
  assert.equal(await stale, false);
  await settle();
  assert.deepEqual(previous.calls.open, []);
  assert.deepEqual(lit.calls.open, ['pmx-1']);
  const { street } = layer.getUIState();
  assert.equal(street.providerId, 'panoramax');
  assert.equal(street.error, null);
  assert.equal(street.loading, false);
});

test('edge:street-level: a switched-off provider cannot open an image or post an error late', async (t) => {
  const { layer, previous, lit } = await twoProviders(t);
  const late = previous.context().actions;
  layer.setProviderEnabled('panoramax', true);
  assert.equal(await layer.openNearest({ lat: 1, lon: 2 }), true);
  // The darkened provider's own work (a sequence step, a cone it had queued)
  // finishes after the switch.
  assert.equal(await late.openImage('mly-late'), false);
  late.reportError('Sequence images unavailable');
  await settle();
  assert.deepEqual(previous.calls.open, []);
  assert.deepEqual(lit.calls.open, ['pmx-1']);
  const { street } = layer.getUIState();
  assert.equal(street.providerId, 'panoramax');
  assert.equal(street.error, null);
});
