// src/awarenessEcho.test.mjs — the Global Context echo field: when a sonar
// pulse front crosses a flight or vessel, its bracket echo lights and fades.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  awarenessEchoActive,
  awarenessEchoAt,
  awarenessEchoStrength,
  clearAwarenessEchoField,
  getAwarenessEchoField,
  setAwarenessEchoField,
} from './awarenessEcho.js';

const R = 250_000;
const pulse = { count: 3, periodMs: 9000, startFraction: 0.02 };
const echo = { fadeMs: 1400, layerIds: ['flights', 'ais-live-vessels'] };
const strength = (nowMs, distanceM) =>
  awarenessEchoStrength(nowMs, distanceM, R, pulse, echo);
/** The moment pulse 0's front sits at `distanceM`, in a later cycle. */
const arrival = (distanceM) =>
  ((distanceM / R - pulse.startFraction) / (1 - pulse.startFraction)) *
    pulse.periodMs +
  pulse.periodMs * 4;

test('an echo lights as a pulse front reaches the contact, then fades', () => {
  const d = 100_000;
  const t0 = arrival(d);
  assert.ok(Math.abs(strength(t0, d) - 1) < 1e-6);
  assert.ok(Math.abs(strength(t0 + echo.fadeMs / 2, d) - 0.25) < 1e-6);
  assert.equal(strength(t0 + echo.fadeMs + 1, d), 0);
  assert.equal(strength(t0 - 50, d), 0, 'dark just before the front');
  // Every pulse lights it once a period: `count` separate flashes in any
  // one-period window that starts after a flash has faded.
  let flashes = 0;
  let wasLit = false;
  const from = t0 + echo.fadeMs + 1;
  for (let ms = 0; ms < pulse.periodMs; ms += 10) {
    const lit = strength(from + ms, d) > 0.5;
    if (lit && !wasLit) flashes++;
    wasLit = lit;
  }
  assert.equal(flashes, pulse.count);
});

test('rim contacts fade out after the front wraps; outside the range never', () => {
  const rim = R * 0.999;
  assert.ok(strength(arrival(rim) + echo.fadeMs / 2, rim) > 0.2);
  // Inside the ring pulses are born on, nothing is ever crossed: the
  // subject and anything within 5 km never echo, at any moment.
  const inner = R * pulse.startFraction;
  for (let ms = 0; ms < pulse.periodMs; ms += 10) {
    assert.equal(strength(ms, 0), 0, 'the subject itself');
    assert.equal(strength(ms, inner - 1), 0);
  }
  assert.ok(strength(pulse.periodMs * 5, inner) > 0.99, 'the birth ring');
  for (let ms = 0; ms < pulse.periodMs; ms += 50)
    assert.equal(strength(ms, R + 1), 0);
  assert.equal(strength(0, Number.NaN), 0);
  assert.equal(strength(0, -1), 0);
});

test('awarenessEchoAt reads the published field, by layer, at ground level', (t) => {
  t.after(clearAwarenessEchoField);
  const contact = Cesium.Cartesian3.fromDegrees(3.5, 27, 0);
  assert.equal(awarenessEchoAt('flights', contact, 0), 0, 'no field, no echo');
  const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  setAwarenessEchoField({ center, radiusM: R, pulse, echo });
  assert.ok(getAwarenessEchoField());
  const d = Cesium.Cartesian3.distance(center, contact);
  const t0 = arrival(d);
  assert.ok(awarenessEchoAt('flights', contact, t0) > 0.99);
  assert.ok(awarenessEchoAt('ais-live-vessels', contact, t0) > 0.99);
  // Layers outside the echo list never light.
  assert.equal(awarenessEchoAt('cctv', contact, t0), 0);
  assert.equal(awarenessEchoAt('military-installations', contact, t0), 0);
  // An aircraft 11 km up echoes with the ground point under it.
  const aloft = Cesium.Cartesian3.fromDegrees(3.5, 27, 11_000);
  assert.ok(
    Math.abs(
      awarenessEchoAt('flights', aloft, t0 + 300) -
        awarenessEchoAt('flights', contact, t0 + 300),
    ) < 0.01,
  );
  // The field's centre is read in place, so a moved subject moves the echo:
  // about 50 km farther, the contact lights at its new distance's moment.
  Cesium.Cartesian3.clone(Cesium.Cartesian3.fromDegrees(3.5, 26.1, 0), center);
  const moved = Cesium.Cartesian3.distance(center, contact);
  assert.ok(Math.abs(moved - d) > 1000);
  assert.ok(awarenessEchoAt('flights', contact, arrival(moved)) > 0.99);
  assert.equal(awarenessEchoAt('flights', null, t0), 0);
  clearAwarenessEchoField();
  assert.equal(getAwarenessEchoField(), null);
  assert.equal(awarenessEchoAt('flights', contact, t0), 0);
});

test('echoes scale with the field level and rest with the pulses', (t) => {
  t.after(clearAwarenessEchoField);
  const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  // ~100 km east of the subject, on the ground.
  const contact = Cesium.Cartesian3.fromDegrees(4.008, 27, 0);
  let level = 1;
  setAwarenessEchoField({
    center,
    radiusM: R,
    pulse,
    echo,
    level: () => level,
  });
  const d = Cesium.Cartesian3.distance(center, contact);
  const t0 = arrival(d);
  const full = awarenessEchoAt('flights', contact, t0);
  assert.ok(full > 0.99);
  level = 0.5;
  assert.ok(
    Math.abs(awarenessEchoAt('flights', contact, t0) - full / 2) < 1e-9,
  );
  assert.equal(awarenessEchoActive(t0), true);
  level = 0;
  assert.equal(awarenessEchoAt('flights', contact, t0), 0);
  // At rest the overlay skips echoes for the whole frame.
  assert.equal(awarenessEchoActive(t0), false);
  clearAwarenessEchoField();
  assert.equal(awarenessEchoActive(t0), false);
});

test('near the subject an echo is no brighter than the fading-in front', () => {
  const fading = { ...pulse, fadeInFraction: 0.08 };
  const at = (distanceM) =>
    awarenessEchoStrength(arrival(distanceM), distanceM, R, fading, echo);
  // Born at 5 km, the front reaches full strength 8% of the way out.
  const full = R * (fading.startFraction + 0.08 * (1 - fading.startFraction));
  assert.equal(at(R * fading.startFraction), 0);
  const halfway = (R * fading.startFraction + full) / 2;
  assert.ok(Math.abs(at(halfway) - 0.5) < 0.01, `${at(halfway)}`);
  assert.ok(at(full + 1) > 0.99);
  assert.ok(
    at(R * 0.999) > 0.99,
    'the rim, and so the ring flash, is unchanged',
  );
});
