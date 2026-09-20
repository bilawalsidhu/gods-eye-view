// overpassPolicy: the shared gate that decides what may be SENT to an Overpass
// upstream (sanitizeOverpassBody) and which mirror's answer may be TRUSTED
// (fetchOverpassPayload). The reject paths here are the security boundary for
// both dev middleware and Pages Function — a query that slips past puts an
// unbounded planet scan behind the app's credentials, so each rejection is
// asserted by its exact error, and each noise-stripping trick (comments,
// quoted literals) is proven unable to hide a bound or a denied construct.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERPASS_MAX_AROUND_M,
  OVERPASS_MAX_BBOX_DEG,
  buildMilitaryInstallationsQuery,
  fetchOverpassPayload,
  overpassLooksRateLimited,
  overpassLooksRuntimeError,
  sanitizeOverpassBody,
  simplifyOverpassPayloadBody,
} from './overpassPolicy.js';

/** Wrap a raw QL string the way the wire carries it. */
const body = (ql) => `data=${encodeURIComponent(ql)}`;

test('sanitize: the app-shaped queries pass unchanged', () => {
  // Positive control: the mapped-installation builder (shared by both
  // runtimes) must survive its own sanitizer.
  const ok = sanitizeOverpassBody(
    buildMilitaryInstallationsQuery({ south: 30.2, west: -97.8, north: 30.3, east: -97.7 }),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // The is_in/area/pivot shape the annotation resolver sends.
  const pivot = sanitizeOverpassBody(body('[out:json][timeout:25];'
    + 'node(around:1000,30.26,-97.74)->.a;is_in(.a)->.b;area.b["boundary"="administrative"]->.c;'
    + 'rel(pivot.c);out tags;'));
  assert.equal(pivot.ok, true, JSON.stringify(pivot));
});

test('sanitize: oversized around radius is rejected in point and set forms, sci-notation included', () => {
  const over = OVERPASS_MAX_AROUND_M + 1;
  assert.equal(sanitizeOverpassBody(body(`node[amenity](around:${over},1,1);out;`)).error,
    'Overpass around radius too large');
  // The input-set form (around.set:r) is matched by the same scan.
  assert.equal(sanitizeOverpassBody(body(`node[amenity](around.set:${over});out;`)).error,
    'Overpass around radius too large');
  // 5e7 parses as 50,000,000 — the full-token parse is what catches it.
  assert.equal(sanitizeOverpassBody(body('node[amenity](around:5e7,1,1);out;')).error,
    'Overpass around radius too large');
});

test('sanitize: oversized bbox is rejected at the degree cap', () => {
  const wide = OVERPASS_MAX_BBOX_DEG + 0.5;
  const ql = `node[amenity](${30 - wide},${-97 - wide},${30 + wide},${-97 + wide});out;`;
  assert.equal(sanitizeOverpassBody(body(ql)).error, 'Overpass bbox too large');
});

test('sanitize: control-flow constructs and poly filters are denied outright', () => {
  assert.equal(sanitizeOverpassBody(body('node[amenity](around:10,1,1)->.a;foreach.a->.b;out;')).error,
    'Unsupported Overpass construct');
  assert.equal(sanitizeOverpassBody(body('node[poly:"1 2 3"];out;')).error,
    'Overpass poly filter not allowed');
});

test('sanitize: an element-in-area selector is caught even when a tag filter sits between', () => {
  // way["highway"](area.a) must reject on the TAG-STRIPPED probe — the tag
  // cannot hide the unbounded area membership from the validator.
  assert.equal(sanitizeOverpassBody(body('way["highway"](area.a);out;')).error,
    'Overpass area-bounded element selector not allowed');
});

test('sanitize: comments and quoted literals cannot hide bounds or denied constructs', () => {
  // A "foreach" inside a quoted tag value is DATA, not a construct — accepted.
  const quoted = sanitizeOverpassBody(body('node["name"="the foreach cafe"](around:10,1,1);out;'));
  assert.equal(quoted.ok, true, JSON.stringify(quoted));
  // The same word in a comment is noise — also accepted...
  const commented = sanitizeOverpassBody(body('[out:json]; // foreach the admin\n'
    + '/* poly: hidden */ node(around:10,1,1);out;'));
  assert.equal(commented.ok, true, JSON.stringify(commented));
  // ...but a real oversized radius hidden behind comment noise is still seen:
  // the lexer strips /* */ and // before the bounds scan runs.
  assert.equal(sanitizeOverpassBody(body('node[amenity](around:10,1,1);/* padding */out;')).ok, true,
    'benign trailing comment keeps the query valid');
  assert.equal(
    sanitizeOverpassBody(body(`node[amenity]/*x*/(around:${OVERPASS_MAX_AROUND_M + 2},1,1);out;`)).error,
    'Overpass around radius too large',
    'a comment wedged into the selector does not blind the radius scan',
  );
});

test('simplify: an unstringifiable payload falls back to the original body', () => {
  // The stringify guard exists for payloads that parse but cannot survive a
  // re-encode (workd edge cases). Simulate one: parse succeeds, stringify throws.
  const pad = `"pad":"${'x'.repeat(2_000_000)}"`; // clear the min-bytes gate
  const padded = `{${pad},"elements":[{"type":"way","id":7,"geometry":[]}]}`;
  const original = JSON.stringify;
  let threw = false;
  try {
    JSON.stringify = () => { threw = true; throw new TypeError('simulated re-encode failure'); };
    const out = simplifyOverpassPayloadBody(padded, { minPoints: 0, toleranceDeg: 1 });
    assert.equal(out, padded, 'byte-identical passthrough on re-encode failure');
  } finally {
    JSON.stringify = original;
  }
  assert.ok(threw, 'the simulated failure must actually have been hit');
});

test('overpassLooksRateLimited/RuntimeError: the body remarks that gate mirror failover', () => {
  assert.equal(overpassLooksRateLimited('Error: rate_limited backoff'), true);
  assert.equal(overpassLooksRateLimited('Too Many Requests'), true);
  assert.equal(overpassLooksRateLimited('{"elements":[]}'), false);
  assert.equal(overpassLooksRuntimeError('remark: runtime error: query timed out'), true);
  assert.equal(overpassLooksRuntimeError('remark: server ran out of memory'), true);
  assert.equal(overpassLooksRuntimeError('remark: some other note'), false,
    'only the documented runtime remarks count');
});

/** A minimal Response stand-in for readTextCapped (it takes the .text() path). */
function upstreamResponse({ status = 200, text = '{"elements":[]}', contentType = 'application/json' } = {}) {
  return {
    status,
    headers: new Headers({ 'content-type': contentType, 'content-length': String(text.length) }),
    text: async () => text,
  };
}

/** Install a scripted fetch; returns the calls seen and a restore handle. */
function scriptFetch(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (endpoint) => {
    calls.push(endpoint);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('fetchOverpassPayload: rate-limited and 5xx mirrors fall through to a clean answer', async () => {
  const { calls, restore } = scriptFetch([
    () => upstreamResponse({ text: 'Error: rate_limited: backoff period' }),
    () => upstreamResponse({ status: 504, text: 'gateway timeout' }),
    () => upstreamResponse({ text: '{"elements":[{"type":"node","id":1}]}' }),
  ]);
  try {
    const payload = await fetchOverpassPayload(body('[out:json];node(around:10,1,1);out;'));
    assert.equal(calls.length, 3, 'two mirrors skipped, third answered');
    assert.equal(payload.endpoint, calls[2]);
    assert.equal(payload.rateLimited, false);
    assert.equal(payload.runtimeError, false);
    assert.ok(payload.body.includes('"id":1'));
  } finally {
    restore();
  }
});

test('fetchOverpassPayload: an oversized response is skipped for the next mirror', async () => {
  const { calls, restore } = scriptFetch([
    // Declared content-length above the cap -> readTextCapped reports tooLarge.
    () => upstreamResponse({ text: 'x'.repeat(64) }),
    () => upstreamResponse({ text: '{"elements":[]}' }),
  ]);
  try {
    const payload = await fetchOverpassPayload(body('[out:json];node;out;'), 16);
    assert.equal(calls.length, 2, 'oversized first response fell through');
    assert.equal(payload.endpoint, calls[1]);
  } finally {
    restore();
  }
});

test('fetchOverpassPayload: all mirrors rate-limited returns the last limiter response', async () => {
  const { restore } = scriptFetch([
    () => upstreamResponse({ text: 'Error: rate_limited first' }),
    () => upstreamResponse({ text: 'Error: rate_limited second' }),
    () => upstreamResponse({ text: 'Error: rate_limited third' }),
  ]);
  try {
    const payload = await fetchOverpassPayload(body('[out:json];node;out;'));
    assert.equal(payload.rateLimited, true, 'rate-limit payload is surfaced, not a fake success');
    assert.equal(payload.status, 200);
    assert.ok(payload.body.includes('third'), 'the LAST limiter payload wins');
  } finally {
    restore();
  }
});

test('fetchOverpassPayload: runtime-error bodies on HTTP 200 never come back as data', async () => {
  const { restore } = scriptFetch([
    () => upstreamResponse({ text: '{"remark":"runtime error: query timed out"}' }),
    () => upstreamResponse({ text: '{"remark":"runtime error: out of memory"}' }),
    () => upstreamResponse({ text: '{"remark":"runtime error: forever"}' }),
  ]);
  try {
    await assert.rejects(
      () => fetchOverpassPayload(body('[out:json];node;out;')),
      /runtime error/,
      'exhausted mirrors with only runtime-error bodies must reject',
    );
  } finally {
    restore();
  }
});

test('fetchOverpassPayload: hard upstream failures reject with the last error', async () => {
  const { restore } = scriptFetch([
    () => { throw new TypeError('fetch failed'); },
    () => { throw new TypeError('fetch failed 2'); },
    () => { throw new TypeError('fetch failed 3'); },
  ]);
  try {
    await assert.rejects(() => fetchOverpassPayload(body('[out:json];node;out;')), /fetch failed 3/);
  } finally {
    restore();
  }
});
