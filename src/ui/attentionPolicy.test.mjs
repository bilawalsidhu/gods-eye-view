import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAttentionDisposition } from './attentionPolicy.js';

test('blocking active-state failures surface as bounded exceptions', () => {
  assert.deepEqual(
    resolveAttentionDisposition({ blocking: true, quietMode: true }),
    { disposition: 'exception', reasonCode: 'blocking' },
  );
  assert.deepEqual(
    resolveAttentionDisposition({
      affectsActiveTask: true,
      freshnessTransition: 'failed',
    }),
    {
      disposition: 'exception',
      reasonCode: 'active-task-source-failed',
    },
  );
});

test('repeated updates decay to silence before ordinary surfacing', () => {
  assert.deepEqual(
    resolveAttentionDisposition({
      repeated: true,
      preparedActionReady: true,
      freshnessTransition: 'recovered',
    }),
    { disposition: 'silent', reasonCode: 'repeated-unchanged' },
  );
});

test('explicit focus and quiet mode suppress proactive suggestion pressure', () => {
  assert.deepEqual(resolveAttentionDisposition({ preparedActionReady: true }), {
    disposition: 'suggest',
    reasonCode: 'prepared-action-ready',
  });
  assert.deepEqual(
    resolveAttentionDisposition({
      preparedActionReady: true,
      explicitUserFocus: true,
    }),
    { disposition: 'ambient', reasonCode: 'prepared-action-deferred' },
  );
  assert.deepEqual(
    resolveAttentionDisposition({
      freshnessTransition: 'recovered',
      quietMode: true,
    }),
    { disposition: 'ambient', reasonCode: 'source-recovered' },
  );
});

test('ordinary background failure stays visible without claiming exception state', () => {
  assert.deepEqual(
    resolveAttentionDisposition({ freshnessTransition: 'failed' }),
    { disposition: 'ambient', reasonCode: 'source-failed' },
  );
  assert.deepEqual(resolveAttentionDisposition(), {
    disposition: 'silent',
    reasonCode: 'no-surface-needed',
  });
});
