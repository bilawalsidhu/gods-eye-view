import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPerceptionChoice,
  resolvePerceptionTier,
} from './perceptionPolicy.js';

test('perception policy always chooses the cheapest sufficient tier', () => {
  assert.equal(
    resolvePerceptionTier({
      stateSufficient: true,
      selectedSufficient: true,
      querySufficient: true,
      viewportSufficient: true,
    }),
    'state',
  );
  assert.equal(
    resolvePerceptionTier({
      selectedSufficient: true,
      querySufficient: true,
      viewportSufficient: true,
    }),
    'selected',
  );
  assert.equal(
    resolvePerceptionTier({
      querySufficient: true,
      cropSufficient: true,
      viewportSufficient: true,
    }),
    'query',
  );
  assert.equal(
    resolvePerceptionTier({
      cropSufficient: true,
      viewportSufficient: true,
    }),
    'crop',
  );
  assert.equal(resolvePerceptionTier({ viewportSufficient: true }), 'viewport');
});

test('perception policy escalates or abstains when lower tiers are insufficient', () => {
  assert.equal(resolvePerceptionTier(), 'multimodal');
  assert.equal(resolvePerceptionTier({ multimodalAllowed: false }), 'abstain');
});

test('perception receipts distinguish missed from wasted escalation', () => {
  assert.equal(
    classifyPerceptionChoice({
      chosenTier: 'viewport',
      minimumSufficientTier: 'selected',
    }),
    'wasted',
  );
  assert.equal(
    classifyPerceptionChoice({
      chosenTier: 'state',
      minimumSufficientTier: 'query',
    }),
    'missed',
  );
  assert.equal(
    classifyPerceptionChoice({
      chosenTier: 'query',
      minimumSufficientTier: 'query',
    }),
    'matched',
  );
  assert.equal(
    classifyPerceptionChoice({
      chosenTier: 'made-up',
      minimumSufficientTier: 'query',
    }),
    'unknown',
  );
});
