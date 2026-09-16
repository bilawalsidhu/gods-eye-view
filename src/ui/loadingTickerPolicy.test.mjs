// src/ui/loadingTickerPolicy.test.mjs
// Arm/stop policy for the global loading chip ticker (Batch G carve-out).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadingTickerNeeded,
  loadingTickerSettled,
  globalStatusNoticeExpired,
} from './loadingTickerPolicy.js';

test('loadingTickerNeeded: active phase or timed notice keeps the ticker armed', () => {
  assert.equal(loadingTickerNeeded('loading', null), true);
  assert.equal(loadingTickerNeeded('complete', null), true, 'terminal dwell still ticks');
  assert.equal(loadingTickerNeeded(undefined, null), true, 'pre-first-sample state arms (matches the inline guard)');
  assert.equal(loadingTickerNeeded('idle', null), false);
  assert.equal(loadingTickerNeeded('idle', { hideAt: 1000 }), true, 'timed notice ticks');
  assert.equal(loadingTickerNeeded('idle', { hideAt: Number.POSITIVE_INFINITY }), false);
});

test('loadingTickerSettled is the exact complement of loadingTickerNeeded', () => {
  const cases = [
    ['loading', null],
    ['idle', null],
    ['idle', { hideAt: 5 }],
    [undefined, { hideAt: 5 }],
    ['complete', null],
  ];
  for (const [phase, notice] of cases) {
    assert.notEqual(
      loadingTickerNeeded(phase, notice),
      loadingTickerSettled(phase, notice),
      `${phase}/${JSON.stringify(notice)}`,
    );
  }
});

test('globalStatusNoticeExpired: finite notices expire, persistent ones never do', () => {
  assert.equal(globalStatusNoticeExpired({ hideAt: 100 }, 99), false);
  assert.equal(globalStatusNoticeExpired({ hideAt: 100 }, 100), true, 'expires at the boundary');
  assert.equal(globalStatusNoticeExpired({ hideAt: 100 }, 500), true);

  assert.equal(globalStatusNoticeExpired({ hideAt: 100, persistent: true }, 9999), false);
  assert.equal(globalStatusNoticeExpired({ persistent: true }, 9999), false, 'no hideAt at all');
  assert.equal(globalStatusNoticeExpired(null, 9999), false);
});
