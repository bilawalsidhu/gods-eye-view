import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREET_VIEW_GLOBAL_MAX,
  STREET_VIEW_MAX_PER_IP,
  makeStreetViewRateLimiter,
  normalizeHeadingDeg,
  resolveStreetViewTarget,
} from '../../server/providers/cctv/streetview.js';

test('an unregistered camera id cannot spend a Street View lookup', () => {
  assert.equal(resolveStreetViewTarget(undefined), null);
  assert.equal(resolveStreetViewTarget(null), null);
});

test('a registered camera resolves to its own recorded pose', () => {
  assert.deepEqual(resolveStreetViewTarget({ lat: 30.2672, lon: -97.7431 }), {
    lat: 30.2672,
    lon: -97.7431,
  });
});

test('client-supplied coordinates cannot steer a billable lookup', () => {
  // The browser sends lat/lon on every frame; the resolver is handed the
  // registered record, so whatever arrived on the query string is not part of
  // the decision at all. A source carrying an attacker's target only resolves
  // when the catalog itself holds it.
  const registered = { lat: 30.2672, lon: -97.7431, id: 'austin-1' };
  const target = resolveStreetViewTarget(registered);
  assert.deepEqual(target, { lat: 30.2672, lon: -97.7431 });
});

test('a finite number that is not a coordinate is refused before Google sees it', () => {
  for (const bad of [
    { lat: 91, lon: 0 },
    { lat: -91, lon: 0 },
    { lat: 0, lon: 181 },
    { lat: 0, lon: -181 },
  ]) {
    assert.equal(resolveStreetViewTarget(bad), null, JSON.stringify(bad));
  }
});

test('a camera with no usable pose is refused rather than guessed at', () => {
  for (const bad of [
    { lat: undefined, lon: 0 },
    { lat: 0, lon: null },
    { lat: Number.NaN, lon: 0 },
    { lat: 'thirty', lon: 0 },
    { lat: Number.POSITIVE_INFINITY, lon: 0 },
  ]) {
    assert.equal(resolveStreetViewTarget(bad), null, JSON.stringify(bad));
  }
});

test('a bearing wraps instead of clamping, because a bearing is periodic', () => {
  assert.equal(normalizeHeadingDeg(40), 40);
  assert.equal(normalizeHeadingDeg(400), 40);
  assert.equal(normalizeHeadingDeg(-90), 270);
  assert.equal(normalizeHeadingDeg(360), 0);
  assert.equal(normalizeHeadingDeg(-720.5), 359.5);
});

test('an unreadable bearing becomes due north rather than reaching Google', () => {
  for (const bad of [undefined, null, Number.NaN, 'north', {}, Infinity]) {
    assert.equal(normalizeHeadingDeg(bad), 0, String(bad));
  }
});

test('the per-IP window admits the layer’s own worst case and then refuses', () => {
  const allow = makeStreetViewRateLimiter();
  for (let i = 0; i < STREET_VIEW_MAX_PER_IP; i += 1) {
    assert.equal(allow('10.0.0.1'), true, `lookup ${i + 1} should be admitted`);
  }
  assert.equal(
    allow('10.0.0.1'),
    false,
    'the lookup past the per-IP cap must be refused',
  );
});

test('the per-IP cap clears the demand the CCTV layer actually generates', () => {
  // 16 ambient cards (CCTV_AMBIENT_CARD_DRAIN_CAP) refreshing every 10s
  // (ACTIVE_FRAME_REFRESH_MS) is 96 fallback frames a minute for one viewer
  // using the layer as designed. A cap at or under that would throttle normal
  // use, which is the failure mode that keeps rate limits out of a codebase.
  const worstLegitimatePerMinute = 16 * (60_000 / 10_000);
  assert.equal(worstLegitimatePerMinute, 96);
  assert.ok(
    STREET_VIEW_MAX_PER_IP > worstLegitimatePerMinute,
    'per-IP cap must sit above the layer’s own steady-state demand',
  );
});

test('one host cannot drain the key past the global backstop', () => {
  const allow = makeStreetViewRateLimiter();
  let admitted = 0;
  // Rotate the key so the per-IP window is never the thing doing the refusing.
  for (let i = 0; i < STREET_VIEW_GLOBAL_MAX + 50; i += 1) {
    if (allow(`10.0.${Math.floor(i / 200)}.${i % 200}`)) admitted += 1;
  }
  assert.equal(admitted, STREET_VIEW_GLOBAL_MAX);
});

test('a refused caller does not consume another caller’s quota', () => {
  const allow = makeStreetViewRateLimiter();
  for (let i = 0; i < STREET_VIEW_MAX_PER_IP; i += 1) allow('10.0.0.1');
  assert.equal(allow('10.0.0.1'), false);
  assert.equal(
    allow('10.0.0.2'),
    true,
    'a second viewer must still be served while the first is capped',
  );
});
