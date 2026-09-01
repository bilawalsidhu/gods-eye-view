import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendLedgerEvent, followUpDueAt, verifyLedger } from './ledger.js';

test('ledger is append-only and detects a tampered chain', () => {
  const first = appendLedgerEvent([], { type: 'REQUEST_DRAFTED', actor: 'operator', payload: { draftId: 'synthetic-1' } }, 100);
  const second = appendLedgerEvent(first, { type: 'REQUEST_APPROVED', actor: 'case-owner' }, 101);

  assert.equal(verifyLedger(second).ok, true);
  assert.equal(first.length, 1);
  second[1].previousHash = 'tampered';
  assert.equal(verifyLedger(second).code, 'LEDGER_TAMPERED');
});

test('ledger rejects missing sequences and follow-up is only a review date', () => {
  assert.equal(verifyLedger([{ atMs: 1 }]).code, 'LEDGER_SEQUENCE_MISSING');
  assert.equal(followUpDueAt(1_000), 1_000 + 31 * 24 * 60 * 60 * 1000);
});
