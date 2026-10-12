import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredImageProvider } from './image-policy.js';
import { createReconstructionBudget } from './reconstruction-budget.js';
test('key presence or invalid owner policy never grants paid approval', () => {
  assert.equal(configuredImageProvider('').approved, false);
  assert.equal(configuredImageProvider('missing-policy.json').approved, false);
});
test('explicit approved policy consumes the preserved ledger rather than resetting it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-owner-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'ledger.json'),
    policy = path.join(dir, 'policy.json');
  const b = createReconstructionBudget({
    ledgerPath: ledger,
    priorSpendMicros: 20000,
    initialize: true,
  });
  b.settle(b.reserve(), 0.01);
  fs.writeFileSync(
    policy,
    JSON.stringify({
      approved: true,
      model: 'gpt-image-2.5-flare',
      quality: 'low',
      limitMicros: 1000000,
      priorSpendMicros: 20000,
      allocationMicros: 100000,
      ledger: 'ledger.json',
    }),
  );
  const p = configuredImageProvider(policy);
  assert.equal(p.approved, true);
  assert.equal(p.budgetStatus.remainingAttempts, 8);
  assert.equal(p.budgetStatus.reportedSpendUsd, 0.03);
});
