import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMagnetosphereSource,
  validateMagnetosphereState,
} from './source.js';

const good = {
  schemaVersion: 1,
  solarWind: {
    observedAt: '2026-10-01T12:00:00Z',
    arrivesAt: '2026-10-01T13:00:00Z',
    speedKmPerS: 400,
    densityPerCm3: 5,
    bzNT: -4,
    btNT: 6,
  },
  magnetopause: {
    standoffRe: 10.1,
    flaring: 0.6,
    dynamicPressureNPa: 1.3,
    insideGeosynchronous: false,
    extrapolatedBeyondFit: false,
  },
  stale: false,
  unavailable: false,
};

test('a well-formed state is accepted and flattened', () => {
  const state = validateMagnetosphereState(good);
  assert.equal(state.unavailable, false);
  assert.equal(state.standoffRe, 10.1);
  assert.equal(state.arrivesAt, '2026-10-01T13:00:00Z');
});

test('an explicit unavailable response keeps its reason instead of throwing', () => {
  const state = validateMagnetosphereState({
    schemaVersion: 1,
    unavailable: true,
    reason: 'solar_wind_http_503',
  });
  assert.equal(state.unavailable, true);
  assert.equal(state.reason, 'solar_wind_http_503');
});

test('malformed or mis-versioned payloads are refused, not coerced', () => {
  for (const bad of [
    null,
    {},
    { ...good, schemaVersion: 2 },
    { ...good, solarWind: { ...good.solarWind, speedKmPerS: 'fast' } },
    { ...good, magnetopause: { ...good.magnetopause, standoffRe: 0.5 } },
    { ...good, magnetopause: undefined },
  ]) {
    assert.equal(validateMagnetosphereState(bad), null, JSON.stringify(bad));
  }
});

test('a boundary inside the Earth is rejected rather than drawn', () => {
  assert.equal(
    validateMagnetosphereState({
      ...good,
      magnetopause: { ...good.magnetopause, standoffRe: 0.9 },
    }),
    null,
  );
});

test('the source rejects a response that parses but is not ours', async () => {
  const source = createMagnetosphereSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }),
  });
  await assert.rejects(() => source.load(), /magnetosphere_invalid_response/);
});

test('an http failure with a valid unavailable body is honoured', async () => {
  const source = createMagnetosphereSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ schemaVersion: 1, unavailable: true, reason: 'down' }),
    }),
  });
  const state = await source.load();
  assert.equal(state.unavailable, true);
});
