import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CACHE_DISCOUNT,
  DEFAULT_ROUND_TRIPS,
  estimateCommandCostUsd,
  formatCommandCostUsd,
} from './cost.js';

const priced = { pricing: { promptPerMTok: 0.25, completionPerMTok: 2 } };
const free = { pricing: { promptPerMTok: 0, completionPerMTok: 0 } };

test('a local model costs nothing, and an unpriced one reports nothing', () => {
  assert.equal(estimateCommandCostUsd(free, { prefixTokens: 12_000 }), 0);
  assert.equal(
    estimateCommandCostUsd({ pricing: null }, { prefixTokens: 12_000 }),
    null,
  );
  assert.equal(estimateCommandCostUsd(null, { prefixTokens: 12_000 }), null);
  assert.equal(
    estimateCommandCostUsd(
      { pricing: { promptPerMTok: 'free' } },
      { prefixTokens: 1 },
    ),
    null,
  );
});

test('an unusable prefix size yields no estimate rather than a wrong one', () => {
  assert.equal(estimateCommandCostUsd(priced, {}), null);
  assert.equal(estimateCommandCostUsd(priced, { prefixTokens: -1 }), null);
  assert.equal(
    estimateCommandCostUsd(priced, { prefixTokens: Number.NaN }),
    null,
  );
});

test('the estimate is the loop this app runs: a prefix resent per round trip', () => {
  const prefixTokens = 10_000;
  const cold = estimateCommandCostUsd(priced, { prefixTokens, warm: false });
  const warm = estimateCommandCostUsd(priced, { prefixTokens });
  const expectedWarm =
    (prefixTokens * DEFAULT_ROUND_TRIPS * 0.25 * DEFAULT_CACHE_DISCOUNT) / 1e6 +
    (200 * 0.25) / 1e6 +
    (70 * 2) / 1e6;
  assert.ok(Math.abs(warm - expectedWarm) < 1e-12);
  assert.ok(cold > warm, 'a cold prefix should cost more than a cached one');
});

test('a bigger prefix or more round trips costs more', () => {
  const base = estimateCommandCostUsd(priced, { prefixTokens: 10_000 });
  assert.ok(estimateCommandCostUsd(priced, { prefixTokens: 20_000 }) > base);
  assert.ok(
    estimateCommandCostUsd(priced, { prefixTokens: 10_000, roundTrips: 4 }) >
      base,
  );
});

test('sub-cent estimates are formatted with enough places to mean something', () => {
  assert.equal(formatCommandCostUsd(0), 'free');
  assert.equal(formatCommandCostUsd(0.00015), '~$0.00015');
  assert.equal(formatCommandCostUsd(0.0008), '~$0.00080');
  assert.equal(formatCommandCostUsd(0.0123), '~$0.0123');
  assert.equal(formatCommandCostUsd(1.5), '~$1.50');
  assert.equal(formatCommandCostUsd(null), 'n/a');
  assert.equal(formatCommandCostUsd(undefined), 'n/a');
  assert.equal(formatCommandCostUsd(Number.NaN), 'n/a');
});
