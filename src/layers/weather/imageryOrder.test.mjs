import test from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_IMAGERY_Z } from './imageryOrder.js';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
import { HEAT_IMAGERY_Z } from '../firms/heatImagery.js';

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

test('Active Fires heat, then an air-quality field and its Europe inset, then wind: never a tie', () => {
  const order = [
    HEAT_IMAGERY_Z,
    WEATHER_IMAGERY_Z['air-quality'],
    WEATHER_IMAGERY_Z['air-quality-inset'],
    WEATHER_IMAGERY_Z.wind,
  ];
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i - 1] < order[i], String(order));
  // Whatever the enable order, the port stacks them so.
  const globe = fakeGlobePort();
  const add = (zOrder) =>
    globe.imagery.add({
      kind: 'xyz',
      url: `https://${zOrder}.invalid`,
      zOrder,
    });
  const wind = add(WEATHER_IMAGERY_Z.wind);
  const inset = add(WEATHER_IMAGERY_Z['air-quality-inset']);
  const field = add(WEATHER_IMAGERY_Z['air-quality']);
  const heat = add(HEAT_IMAGERY_Z);
  assert.deepEqual(globe.layers, [heat, field, inset, wind]);
});
