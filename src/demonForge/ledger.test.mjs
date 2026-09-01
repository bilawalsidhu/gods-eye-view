import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendLedgerEvent, followUpDueAt, sha256Hex, verifyLedger } from './ledger.js';

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

test('ledger rejects non-JSON payloads rather than accepting hash collisions', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(
    () => appendLedgerEvent([], { type: 'REQUEST_DRAFTED', actor: 'operator', payload: { outcome: Number.NaN } }, 100),
    { code: 'LEDGER_PAYLOAD_INVALID' },
  );

  const ledger = appendLedgerEvent([], { type: 'REQUEST_DRAFTED', actor: 'operator', payload: { outcome: null } }, 100);
  ledger[0].payload = { outcome: Number.NaN };
  assert.equal(verifyLedger(ledger).code, 'LEDGER_TAMPERED');
});

test('ledger rejects cyclic and sparse payloads', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'synthetic';

  for (const payload of [cyclic, sparse]) {
    assert.throws(
      () => appendLedgerEvent([], { type: 'REQUEST_DRAFTED', actor: 'operator', payload }, 100),
      { code: 'LEDGER_PAYLOAD_INVALID' },
    );
  }
});
