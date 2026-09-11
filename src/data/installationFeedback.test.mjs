import test from 'node:test';
import assert from 'node:assert/strict';
import { installationFeedback } from './installationFeedback.js';

test('retry copy follows the real deadline and does not promise an overdue timer fired', () => {
  assert.equal(installationFeedback({ retryAt: 31000 }, 1000), 'Overpass temporarily unavailable — retrying in 30s');
  assert.match(installationFeedback({ retryAt: 31000 }, 32000), /retry pending$/);
  assert.match(installationFeedback({ retryAt: 241000 }, 1000), /240s$/);
});
test('only known failure reasons get specific attribution', () => {
  for (const [failureReason, text] of [['rate_limited', 'rate-limited'], ['timeout', 'timed out'], ['query_failed', 'could not complete']]) {
    assert.ok(installationFeedback({ status: 'unavailable', failureReason }).includes(text));
  }
  assert.match(installationFeedback({ status: 'unavailable', failureReason: 'unknown' }), /temporarily unavailable/);
});
test('first fetch, retry, cached data and success have distinct copy', () => {
  assert.equal(installationFeedback({ loading: true }), 'Fetching mapped sites…');
  assert.equal(installationFeedback({ loading: true, retrying: true }), 'Retrying mapped sites…');
  assert.equal(installationFeedback({ status: 'ready' }), 'Mapped sites loaded');
  assert.equal(installationFeedback({ stale: true }), 'Showing cached mapped sites');
});
