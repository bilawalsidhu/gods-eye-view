import test from 'node:test';
import assert from 'node:assert/strict';
import { withBase } from './apiBase.js';

test('withBase prefixes root-absolute paths with the effective base', () => {
  assert.equal(withBase('/api/opensky'), '/api/opensky'); // default base '/'
  assert.equal(withBase('/api/opensky?x=1', '/gods-eye/'), '/gods-eye/api/opensky?x=1');
  assert.equal(withBase('/api/ais-live/track?mmsi=1', '/'), '/api/ais-live/track?mmsi=1');
});
