import test from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_IMAGERY_Z } from './imageryOrder.js';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';

test('an air-quality field and its inset, wind, infrared, radar, then lightning, above zOrder 0, whatever the enable order', () => {
  const globe = fakeGlobePort();
  const add = (name) =>
    globe.imagery.add({
      kind: 'xyz',
      url: `https://${name}.invalid/{z}/{x}/{y}`,
      zOrder: WEATHER_IMAGERY_Z[name],
    });
  const lightning = add('lightning');
  const overlay = globe.imagery.add({ kind: 'xyz', url: 'https://o.invalid' });
  const radar = add('radar');
  const wind = add('wind');
  const clouds = add('clouds');
  const regional = add('clouds-regional');
  const inset = add('air-quality-inset');
  const field = add('air-quality');
  assert.deepEqual(globe.layers, [
    overlay,
    field,
    inset,
    wind,
    clouds,
    regional,
    radar,
    lightning,
  ]);
});
