import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Microdollars avoid floating-point drift. This guards this app's allocations,
// not the provider's invoice or unrelated API calls. Never stores image/text/key.
export function createReconstructionBudget({
  ledgerPath,
  limitMicros = 1_000_000,
  priorSpendMicros = 0,
  allocationMicros = 100_000,
  initialize = false,
} = {}) {
  if (
    !ledgerPath ||
    ![limitMicros, priorSpendMicros, allocationMicros].every(
      Number.isSafeInteger,
    ) ||
    priorSpendMicros < 0 ||
    allocationMicros <= 0 ||
    limitMicros <= priorSpendMicros
  )
    throw Error('Invalid reconstruction allowance');
  const fresh = () => ({
    version: 1,
    limitMicros,
    priorSpendMicros,
    allocationMicros,
    locked: false,
    entries: [],
  });
  function read() {
    if (!fs.existsSync(ledgerPath))
      throw Error('Reconstruction allowance ledger is missing');
    if (fs.statSync(ledgerPath).size > 65536)
      throw Error('Allowance ledger too large');
    const value = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (
      value.version !== 1 ||
      value.limitMicros !== limitMicros ||
      value.priorSpendMicros !== priorSpendMicros ||
      value.allocationMicros !== allocationMicros ||
      typeof value.locked !== 'boolean' ||
      !Array.isArray(value.entries) ||
      value.entries.length > 100 ||
      value.entries.some(
        (e) =>
          !e ||
          typeof e.id !== 'string' ||
          e.allocationMicros !== allocationMicros ||
          !['reserved', 'complete', 'uncertain'].includes(e.state) ||
          (e.costMicros !== null &&
            (!Number.isSafeInteger(e.costMicros) || e.costMicros < 0)),
      )
    )
      throw Error('Allowance ledger is invalid; generation stopped');
    return value;
  }
  function write(value) {
    const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, ledgerPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function change(action) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + '.lock';
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      const state = read();
      const result = action(state);
      write(state);
      return result;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.unlinkSync(lockPath);
      }
    }
  }
  // Only initialization creates the ledger. A missing ledger later is a blocker.
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  if (initialize && !fs.existsSync(ledgerPath)) {
    try {
      fs.writeFileSync(ledgerPath, JSON.stringify(fresh(), null, 2) + '\n', {
        flag: 'wx',
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  function status() {
    try {
      if (fs.existsSync(ledgerPath + '.lock'))
        throw Error('Allowance update in progress or stale lock; fail closed');
      const state = read();
      const allocated =
        priorSpendMicros + state.entries.length * allocationMicros;
      const spent =
        priorSpendMicros +
        state.entries.reduce((n, e) => n + (e.costMicros ?? 0), 0);
      const pending = state.entries.some((e) => e.state !== 'complete');
      const remaining = Math.max(0, limitMicros - allocated);
      return {
        limitUsd: limitMicros / 1e6,
        priorSpendUsd: priorSpendMicros / 1e6,
        reportedSpendUsd: spent / 1e6,
        allocatedUsd: allocated / 1e6,
        remainingAllocationUsd: remaining / 1e6,
        perAttemptAllocationUsd: allocationMicros / 1e6,
        remainingAttempts:
          state.locked || pending
            ? 0
            : Math.floor(remaining / allocationMicros),
        locked: state.locked || pending,
        basis:
          'Local allocation guard; provider invoice and unrelated API usage are not capped. Each sent attempt permanently uses $0.10 of this allowance. Unknown charges stop further generation.',
      };
    } catch {
      return {
        locked: true,
        remainingAttempts: 0,
        error: 'Allowance ledger unavailable or invalid. Generation stopped.',
      };
    }
  }
  return {
    status,
    reserve() {
      return change((state) => {
        if (
          state.locked ||
          state.entries.some((e) => e.state !== 'complete') ||
          priorSpendMicros + (state.entries.length + 1) * allocationMicros >
            limitMicros
        )
          throw Object.assign(
            Error(
              'Image allowance unavailable, exhausted, or awaiting charge reconciliation.',
            ),
            { code: 'BUDGET_BLOCKED' },
          );
        const id = randomUUID();
        state.entries.push({
          id,
          utc: new Date().toISOString(),
          allocationMicros,
          state: 'reserved',
          costMicros: null,
        });
        return id;
      });
    },
    settle(id, costUsd) {
      return change((state) => {
        const entry = state.entries.find((e) => e.id === id);
        if (!entry || entry.state !== 'reserved')
          throw Error('Invalid allowance reservation');
        if (!Number.isFinite(costUsd) || costUsd < 0) {
          entry.state = 'uncertain';
          state.locked = true;
        } else {
          entry.costMicros = Math.ceil(costUsd * 1e6);
          entry.state = 'complete';
          if (entry.costMicros > allocationMicros) state.locked = true;
        }
      });
    },
  };
}
