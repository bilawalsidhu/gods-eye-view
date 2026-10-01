import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEMPERATURE_STOPS,
  kelvinToCelsius,
  scaleGradient,
  scalePosition,
  scaleReading,
  scaleTicks,
} from './scale.js';

test('the stops span the published product range', () => {
  // NASA's colour map for this layer runs 200 K to 350 K; anything outside is
  // clamped into the end stops, which the labels have to say.
  assert.equal(TEMPERATURE_STOPS[0].kelvin, 200);
  assert.equal(TEMPERATURE_STOPS.at(-1).kelvin, 350);
  const kelvins = TEMPERATURE_STOPS.map((s) => s.kelvin);
  assert.deepEqual(kelvins, [...kelvins].sort((a, b) => a - b));
});

test('Kelvin converts exactly, so the labels are not approximations', () => {
  assert.equal(kelvinToCelsius(273.15), 0);
  assert.equal(Math.round(kelvinToCelsius(200)), -73);
  assert.equal(Math.round(kelvinToCelsius(350)), 77);
});

test('the gradient places each published colour at its own temperature', () => {
  const gradient = scaleGradient();
  assert.ok(gradient.startsWith('linear-gradient(90deg, rgb(197,0,255) 0.00%'));
  assert.ok(gradient.endsWith('rgb(255,1,0) 100.00%)'));
  // 0 °C is not the midpoint of a 200-350 K ramp; evenly spaced stops would
  // put every label on the wrong colour.
  assert.ok(gradient.includes('rgb(91,255,43) 48.77%'));
  for (const stop of TEMPERATURE_STOPS)
    assert.ok(gradient.includes(stop.color), `${stop.color} is a published stop`);
});

test('ticks are round Celsius values placed by temperature, with a true minus', () => {
  const ticks = scaleTicks();
  assert.deepEqual(
    ticks.map(({ label }) => label),
    ['−60°', '−30°', '0°', '30°', '60°'],
  );
  assert.ok(Math.abs(ticks[2].position - 73.15 / 150) < 1e-9);
  assert.equal(scalePosition(100), 0, 'below the ramp clamps to its end');
  assert.equal(scalePosition(400), 1);
});

test('a reading sits mid-bucket in its published colour, and a bound at its bound', () => {
  const bucket = { r: 255, g: 205, b: 0, lowK: 309.8, highK: 310.4 };
  const reading = scaleReading(bucket);
  assert.equal(reading.color, 'rgb(255,205,0)');
  assert.ok(Math.abs(reading.position - (310.1 - 200) / 150) < 1e-9);
  assert.equal(
    scaleReading({ ...bucket, lowK: 0, highK: 200.4, clampLow: true }).position,
    scalePosition(200.4),
  );
  assert.equal(scaleReading(null), null);
});
