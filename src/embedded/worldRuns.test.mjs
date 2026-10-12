import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRun } from './worldRuns.js';
import { DRAWABLE_REPRESENTATIONS, productLayerId } from './worldProducts.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../layers/worldModel/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const runStatus = fixture('simulated-run.status.json');
const [runHead] = Object.keys(fixture('simulated-run.heads.json')).filter((h) =>
  h.startsWith('sim/'),
);

/** A manager holding a row for every drawable simulated product, as discovery registers. */
function managerFor(status, { refuse = false } = {}) {
  const layers = new Map();
  for (const b of status.bindings)
    if (
      b.modality === 'simulated' &&
      b.representations.some((r) => DRAWABLE_REPRESENTATIONS.includes(r.kind))
    )
      layers.set(productLayerId(b.binding), { params: {}, enabled: false });
  return {
    layers,
    setLayerParams(id, params) {
      if (refuse) return false;
      Object.assign(layers.get(id).params, params);
      return true;
    },
    async setEnabled(id, on) {
      layers.get(id).enabled = on;
    },
  };
}

const source = (status) => ({ getStatus: async () => status });

test('opening a run points every row the run has a product for at the run, and only those', async () => {
  const manager = managerFor(runStatus);
  const result = await openRun({
    manager,
    source: source(runStatus),
    head: runHead,
  });
  const simulated = runStatus.bindings.filter(
    (b) => b.modality === 'simulated',
  );
  assert.ok(simulated.length > 0 && result.opened.length > 0);
  assert.equal(
    result.opened.length + result.undrawable.length,
    simulated.length,
  );
  for (const { binding, layerId, validAt } of result.opened) {
    const row = manager.layers.get(layerId);
    assert.equal(row.enabled, true);
    assert.equal(row.params.head, runHead);
    const entry = simulated.find((b) => b.binding === binding);
    assert.equal(
      validAt,
      entry.valid.earliest,
      'opens at the product first epoch',
    );
  }
  // The run's base (observed) products are not the run: no row of theirs moves.
  assert.ok(runStatus.bindings.some((b) => b.modality === 'observed'));
  assert.ok(
    result.opened.every(({ binding }) =>
      simulated.some((b) => b.binding === binding),
    ),
  );
});

test('a requested time wins, and a product with nothing to draw is named rather than dropped', async () => {
  const rf = {
    binding: 'simulation.rf.navigation',
    modality: 'simulated',
    representations: [{ kind: 'numeric_samples/v1' }],
    valid: { earliest: '2026-08-12T01:59:00Z' },
  };
  const status = { ...runStatus, bindings: [...runStatus.bindings, rf] };
  const manager = managerFor(status);
  const at = '2026-08-12T02:00:00Z';
  const result = await openRun({
    manager,
    source: source(status),
    head: runHead,
    validAt: at,
  });
  assert.ok(result.opened.every((o) => o.validAt === at));
  assert.deepEqual(result.undrawable, [
    { binding: 'simulation.rf.navigation', reason: 'no position to draw' },
  ]);
});

test('only a run head is opened, and a row that refuses the head fails loudly', async () => {
  await assert.rejects(
    openRun({
      manager: managerFor(runStatus),
      source: source(runStatus),
      head: 'world/main',
    }),
    /sim\//,
  );
  await assert.rejects(
    openRun({
      manager: managerFor(runStatus, { refuse: true }),
      source: source(runStatus),
      head: runHead,
    }),
    /refused head/,
  );
});

// --- GEN-299: the receipt's revision, exactly ---------------------------------------------------

const chainOf = (...ids) => ({
  head: runHead,
  revisions: ids.map((id) => ({ id, parent_id: null, created_at: '2026-10-08T00:00:00Z', bindings: [] })),
});

test("a receipt's revision pins every row to it, and the run's interval is reported", async () => {
  const manager = managerFor(runStatus);
  const result = await openRun({
    manager,
    source: { ...source(runStatus), getRevisions: async () => chainOf('rev-1') },
    head: runHead,
    revisionId: 'rev-1',
  });
  assert.equal(result.revisionId, 'rev-1');
  assert.equal(result.headAdvanced, false);
  for (const { layerId } of result.opened) {
    const { params } = manager.layers.get(layerId);
    assert.equal(params.follow, 'pinned');
    assert.equal(params.revisionId, 'rev-1');
    assert.equal(params.head, runHead);
  }
  const simulated = runStatus.bindings.filter((b) => b.modality === 'simulated');
  const earliest = simulated.map((b) => Date.parse(b.valid.earliest));
  const latest = simulated.map((b) => Date.parse(b.valid.latest));
  assert.equal(Date.parse(result.interval.start), Math.min(...earliest));
  assert.equal(Date.parse(result.interval.end), Math.max(...latest));
});

test('a head that has moved past the receipt is reported, and the receipt is still what opens', async () => {
  const manager = managerFor(runStatus);
  const result = await openRun({
    manager,
    source: { ...source(runStatus), getRevisions: async () => chainOf('rev-2', 'rev-1') },
    head: runHead,
    revisionId: 'rev-1',
  });
  assert.equal(result.headAdvanced, true);
  assert.ok(result.opened.every(({ layerId }) => manager.layers.get(layerId).params.revisionId === 'rev-1'));
});

test('a revision that is not on the head is refused with a reason, and nothing moves', async () => {
  const manager = managerFor(runStatus);
  await assert.rejects(
    openRun({
      manager,
      source: { ...source(runStatus), getRevisions: async () => chainOf('rev-2') },
      head: runHead,
      revisionId: 'rev-1',
    }),
    (error) => error.code === 'revision-not-on-head' && /is not on sim\//.test(error.message),
  );
  assert.ok([...manager.layers.values()].every((row) => !row.enabled));
});

test('a head with no simulated product is refused rather than shown as an empty globe', async () => {
  const observedOnly = {
    ...runStatus,
    bindings: runStatus.bindings.filter((b) => b.modality !== 'simulated'),
  };
  await assert.rejects(
    openRun({ manager: managerFor(runStatus), source: source(observedOnly), head: runHead }),
    (error) => error.code === 'no-simulated-products' && /Retry the publication/.test(error.message),
  );
});

test('the pair\'s nominal case is focused for comparison, and a bad one is reported without blocking the run', async () => {
  const { runFocus } = await import('../layers/worldModel/runFocus.js');
  const nominalHead = 'sim/sha256:' + 'ab'.repeat(32);
  const revisions = { [runHead]: chainOf('rev-1'), [nominalHead]: chainOf('rev-n') };
  const pairSource = { ...source(runStatus), getRevisions: async ({ head }) => revisions[head] };
  const result = await openRun({
    manager: managerFor(runStatus),
    source: pairSource,
    head: runHead,
    revisionId: 'rev-1',
    compare: { head: nominalHead, revisionId: 'rev-n' },
  });
  assert.equal(result.compareError, null);
  assert.deepEqual(
    { head: runFocus().head, revisionId: runFocus().revisionId, compare: { ...runFocus().compare } },
    { head: runHead, revisionId: 'rev-1', compare: { head: nominalHead, revisionId: 'rev-n', label: 'nominal' } },
  );
  assert.equal(runFocus().source, pairSource);

  const stale = await openRun({
    manager: managerFor(runStatus),
    source: pairSource,
    head: runHead,
    revisionId: 'rev-1',
    compare: { head: nominalHead, revisionId: 'rev-gone' },
  });
  assert.ok(stale.opened.length > 0, 'the run itself still opens');
  assert.match(stale.compareError, /nominal run cannot be compared: Revision rev-gone is not on/);
  assert.equal(runFocus().compare, null);
});
