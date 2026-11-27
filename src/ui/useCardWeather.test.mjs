import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, reactive } from 'vue';
import { useCardWeather } from './useCardWeather.js';

test('a stationary card renews weather and recovers after its provider stalls', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0;
  const store = reactive({
    tick: 0,
    readWeather() {
      calls++;
      return calls === 2
        ? new Promise(() => {})
        : Promise.resolve({ weather: { temperatureC: calls } });
    },
  });
  const scope = effectScope();
  t.after(() => scope.stop());
  const state = scope.run(() =>
    useCardWeather(() => ({ lat: 1, lon: 2 }), store),
  );
  async function advance(ms) {
    t.mock.timers.tick(ms);
    store.tick++;
    await nextTick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await advance(0);
  assert.equal(state.weather.value.temperatureC, 1);
  await advance(299999);
  assert.equal(calls, 1);
  await advance(1);
  assert.equal(calls, 2);
  await advance(15000);
  assert.equal(state.weather.value, null);
  await advance(60000);
  assert.equal(state.weather.value.temperatureC, 3);
});
