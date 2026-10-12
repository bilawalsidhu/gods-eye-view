import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReconstructionBudget } from './reconstruction-budget.js';
import {
  createOpenAiReconstructionProvider,
  CAMERA_RECONSTRUCTION_MODEL,
} from './camera-reconstruction.js';
function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-image-allowance-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    ledgerPath: path.join(directory, 'ledger.json'),
    priorSpendMicros: 20_000,
  };
  return {
    budget: createReconstructionBudget({ ...options, initialize: true }),
    options,
  };
}
test('prior spend and nine fixed allocations survive restarts', (t) => {
  const { budget, options } = fixture(t);
  assert.equal(budget.status().reportedSpendUsd, 0.02);
  for (let n = 0; n < 9; n++) {
    const b = createReconstructionBudget(options);
    b.settle(b.reserve(), 0.01);
  }
  const b = createReconstructionBudget(options);
  assert.equal(b.status().remainingAttempts, 0);
  assert.equal(b.status().allocatedUsd, 0.92);
  assert.equal(b.status().reportedSpendUsd, 0.11);
  assert.throws(() => b.reserve(), /allowance/);
});
test('concurrent clients and restarts cannot bypass a pending reservation', (t) => {
  const { budget, options } = fixture(t);
  const id = budget.reserve();
  const second = createReconstructionBudget(options);
  assert.equal(second.status().locked, true);
  assert.throws(() => second.reserve(), /reconciliation/);
  budget.settle(id, 0.00727);
  assert.equal(second.status().remainingAttempts, 8);
});
test('unknown charges block all future sends persistently', (t) => {
  const { budget, options } = fixture(t);
  budget.settle(budget.reserve(), null);
  assert.equal(createReconstructionBudget(options).status().locked, true);
  assert.throws(() => budget.reserve());
});
test('missing/corrupt ledger is not reset on restart', (t) => {
  const { budget, options } = fixture(t);
  fs.unlinkSync(options.ledgerPath);
  assert.equal(
    createReconstructionBudget(options).status().remainingAttempts,
    0,
  );
  assert.equal(fs.existsSync(options.ledgerPath), false);
  assert.throws(() => budget.reserve());
  fs.writeFileSync(options.ledgerPath, '{}');
  assert.equal(
    createReconstructionBudget(options).status().remainingAttempts,
    0,
  );
});
test('upstream failure keeps allocation and disables later sends', async (t) => {
  const { budget, options } = fixture(t);
  let edits = 0;
  const p = createOpenAiReconstructionProvider({
    approved: true,
    budget,
    quality: 'low',
    resolveApiKey: () => 'fixture',
    fetchImpl: async (url) => {
      if (url.endsWith('/models'))
        return new Response(
          JSON.stringify({ data: [{ id: CAMERA_RECONSTRUCTION_MODEL }] }),
        );
      edits++;
      throw Error('fixture timeout');
    },
  });
  await assert.rejects(
    p.generate({
      sourceImage: 'data:image/png;base64,Zg==',
      scope: 'whole',
      note: '',
    }),
  );
  assert.equal(edits, 1);
  assert.equal(p.approved, false);
  assert.equal(createReconstructionBudget(options).status().locked, true);
  assert.ok(!fs.readFileSync(options.ledgerPath, 'utf8').includes('fixture'));
});
