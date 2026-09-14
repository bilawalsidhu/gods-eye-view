// Contract tests for the /api/opensky Pages Function's viewport scoping —
// the body-cap/bbox-clamp sweep (docs/PLAN.md Phase 7). The handler once
// forwarded a raw `bbox=lamax,lamin,lomin,romax` passthrough (no client ever
// sent it) and fed unvalidated lat/lon strings into the upstream query; these
// pin the validated replacement.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPENSKY_BOX_HALF_DEG, buildOpenSkyStatesUrl } from './opensky.js';

const queryOf = (search) => new URL(`https://example.com/api/opensky${search}`).searchParams;

test('camera lat/lon derive the ~250 km query box', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=29.4259&lon=-98.4861'));
  assert.equal(url.pathname, '/api/states/all');
  assert.equal(Number(url.searchParams.get('lamin')), 29.4259 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lamax')), 29.4259 + OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('lomin')), -98.4861 - OPENSKY_BOX_HALF_DEG);
  assert.equal(Number(url.searchParams.get('romax')), -98.4861 + OPENSKY_BOX_HALF_DEG);
});

test('the derived box is clamped to the planet', () => {
  const url = buildOpenSkyStatesUrl(queryOf('?lat=89.9&lon=179.9'));
  assert.equal(Number(url.searchParams.get('lamax')), 90);
  assert.equal(Number(url.searchParams.get('romax')), 180);
  assert.ok(Number(url.searchParams.get('lamin')) > 80);
});

test('absent, malformed, and out-of-range coordinates degrade to the global fetch', () => {
  for (const search of ['', '?lat=999&lon=0', '?lat=29.4&lon=-999', '?lat=abc&lon=def', '?lat=91&lon=0', '?lat=0&lon=181']) {
    const url = buildOpenSkyStatesUrl(queryOf(search));
    assert.equal(
      url.searchParams.toString(),
      '',
      `${search || '(no query)'} must not produce a partial box`,
    );
  }
});

test('the raw bbox passthrough is gone', () => {
  // Nothing in the client ever sent it; it forwarded arbitrary strings into
  // the upstream query string.
  const url = buildOpenSkyStatesUrl(queryOf('?bbox=1,2,3,<script>'));
  assert.equal(url.searchParams.toString(), '');
});
