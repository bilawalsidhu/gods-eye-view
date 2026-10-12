import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EFFECT_FAMILIES,
  cellsAt,
  compareLanes,
  createRunEffects,
  laneFrom,
  modelCardOf,
  outcomeOf,
} from './runEffects.js';

// Both cases of Foundation's examples/ground-rf-mission run, as World Model serves them.
const pair = JSON.parse(
  readFileSync(new URL('./fixtures/run-effects.pair.json', import.meta.url), 'utf8'),
);
const [comms, collection, navigation] = EFFECT_FAMILIES;
const at = (iso) => Date.parse(iso);

/** A source holding both runs: select by revision, and the revision's descriptors. */
function pairSource({ revisions = true } = {}) {
  const runs = Object.values(pair).filter((run) => run.revision_id);
  const byRevision = new Map(runs.map((run) => [run.revision_id, run]));
  const calls = [];
  return {
    calls,
    async select({ revisionId, query }) {
      calls.push(['select', revisionId, query.requested_layers[0]]);
      const run = byRevision.get(revisionId);
      return run.selections[query.requested_layers[0]] ?? { products: [] };
    },
    ...(revisions && {
      async getRevision({ revisionId }) {
        calls.push(['revision', revisionId]);
        return byRevision.get(revisionId).revision;
      },
    }),
  };
}

const lane = (run, entry) =>
  laneFrom(
    entry,
    pair[run].selections[entry.binding],
    pair[run].revision.descriptors[entry.binding].semantic.metadata,
  );

test('every published row is one cell, its state read from state_code', () => {
  const contested = lane('contested', comms);
  const rows = pair.contested.selections[comms.binding].products[0].values;
  assert.equal(contested.cells.length, rows.length);
  // The receiver went nominal -> degraded -> unavailable -> recovering under the emitter.
  const exchanges = Object.fromEntries(
    contested.cells.filter((c) => c.opportunity.startsWith('exchange-')).map((c) => [c.opportunity, c.stateName]),
  );
  assert.deepEqual(exchanges, {
    'exchange-0': 'nominal',
    'exchange-1': 'degraded',
    'exchange-2': 'unavailable',
    'exchange-3': 'recovering',
    'exchange-4': 'recovering',
    'exchange-5': 'nominal',
  });
});

test('opportunities sharing an epoch stay separate cells, stacked', () => {
  const contested = lane('contested', comms);
  const shared = cellsAt(contested, at('2026-08-12T02:00:12+00:00'));
  assert.deepEqual(shared.map((c) => c.opportunity).sort(), ['exchange-1', 'parallel-exchange']);
  assert.deepEqual(shared.map((c) => c.stack).sort(), [0, 1]);
  assert.equal(contested.depth, 2);
  // Two exchanges, two outcomes: 100 and 3 bytes attempted, never summed.
  const attempted = shared.map((c) => c.outcome.match(/of (\d+) B delivered$/)[1]).sort();
  assert.deepEqual(attempted, ['100', '3']);
});

test('unknown is its own state, never an outage, and says why', () => {
  const off = lane('contested', collection).cells.find((c) => c.opportunity === 'off-grid-observation');
  assert.equal(off.unknown, true);
  assert.equal(off.stateName, 'unknown');
  assert.equal(off.reason, 'missing_receiver_sample');
  assert.equal(off.available, null);
  assert.equal(off.outcome, null, 'an unknown row states no outcome');
  const outage = lane('contested', collection).cells.find((c) => c.opportunity === 'observation-2');
  assert.equal(outage.stateName, 'unavailable');
  assert.equal(outage.unknown, false);
  assert.equal(outage.outcome, 'observation lost');
});

test('reasons are named by the product legend, and a missing legend shows the code', () => {
  const named = lane('contested', comms).cells.find((c) => c.opportunity === 'exchange-2');
  assert.equal(named.reason, 'below_unavailable_threshold');
  const bare = laneFrom(comms, pair.contested.selections[comms.binding]);
  assert.match(bare.cells.find((c) => c.opportunity === 'exchange-2').reason, /^reason \d+$/);
});

test('outcomes come from the row and say when there is none', () => {
  assert.equal(outcomeOf('communications', { available: true, delivered_bytes: 100, attempted_bytes: 100 }), '100 B of 100 B delivered');
  assert.equal(outcomeOf('collection', { available: true, observation_retained: true }), 'observation kept');
  assert.equal(outcomeOf('navigation', { available: false, position_sigma_m: null }), 'no fix');
  assert.equal(outcomeOf('navigation', { available: true, position_sigma_m: 4.2 }), 'position σ 4.2 m');
  assert.equal(outcomeOf('navigation', { available: null }), null);
});

test('the model card says the models are illustrative and lists each assumption once', () => {
  const metadata = Object.fromEntries(
    EFFECT_FAMILIES.map((e) => [e.family, pair.contested.revision.descriptors[e.binding].semantic.metadata]),
  );
  const card = modelCardOf(metadata);
  assert.equal(card.models.length, 3);
  assert.ok(card.models.every((m) => m.calibrationStatus && !m.validated));
  assert.equal(card.uncalibrated, true);
  assert.equal(new Set(card.assumptions).size, card.assumptions.length);
  assert.equal(modelCardOf({}), null, 'no header read: no card, never an implied validated model');
});

test('contested against nominal: the cells whose state differs, and only those', () => {
  const contested = EFFECT_FAMILIES.map((e) => lane('contested', e));
  const nominal = EFFECT_FAMILIES.map((e) => lane('nominal', e));
  const differences = compareLanes(contested, nominal);
  assert.ok(differences.length > 0);
  assert.ok(differences.every((d) => d.nominal === 'nominal' && d.contested !== 'nominal'));
  // The off-grid observation is unknown in both cases: not a difference.
  assert.ok(!differences.some((d) => d.opportunity === 'off-grid-observation'));
  assert.ok(differences.some((d) => d.family === 'navigation'));
  assert.deepEqual(compareLanes(nominal, nominal), []);
});

test('a run is read once per revision, with its headers when the source can say', async () => {
  const source = pairSource();
  const effects = createRunEffects(source);
  const first = await effects.read({ revisionId: pair.contested.revision_id });
  const again = await effects.read({ revisionId: pair.contested.revision_id });
  assert.equal(first, again);
  assert.deepEqual(first.lanes.map((l) => l.family), ['communications', 'collection', 'navigation']);
  assert.equal(first.card.uncalibrated, true);
  assert.equal(source.calls.filter(([kind]) => kind === 'select').length, 3);
  assert.equal(first.lanes[0].cells.find((c) => c.opportunity === 'exchange-2').reason, 'below_unavailable_threshold');
});

test('without revision headers the lanes still draw, and there is no card', async () => {
  const effects = createRunEffects(pairSource({ revisions: false }));
  const read = await effects.read({ revisionId: pair.nominal.revision_id });
  assert.equal(read.lanes.length, 3);
  assert.equal(read.card, null);
});

test('a run without mission effects has no lanes', async () => {
  const effects = createRunEffects({ select: async () => ({ products: [] }) });
  assert.deepEqual(await effects.read({ head: 'sim/x' }), { lanes: [], card: null });
});

test('a run with effects and no track still plays, at the effects\' own epochs', async () => {
  const { effectsTimeline, effectsBannerText, lanesGeometry } = await import('./runEffects.js');
  const lanes = EFFECT_FAMILIES.map((e) => lane('contested', e));
  const timeline = effectsTimeline(lanes);
  const epochs = new Set(lanes.flatMap((l) => l.cells.map((c) => c.at)));
  assert.equal(timeline.rows.length, epochs.size);
  assert.equal(timeline.cadenceMs, 30_000);
  // The off-grid observation's epoch is a published epoch: it is a step, not interpolated.
  assert.ok(timeline.rows.some((r) => r.validAt === '2026-08-12T02:00:27Z'));
  assert.equal(
    effectsBannerText(lanes, at('2026-08-12T02:00:42+00:00')),
    'COMMS unavailable · COLLECTION unavailable · NAVIGATION unavailable',
  );
  const geometry = lanesGeometry(
    lanes.map((l) => ({ lane: l, label: l.label, run: 'contested' })),
    { x: (ms) => (ms - timeline.start) / 1000, cadenceMs: timeline.cadenceMs },
  );
  assert.equal(geometry.rows.length, 3);
  assert.ok(geometry.rows[0].height > geometry.rows[1].height, 'the stacked comms lane is taller');
  assert.ok(geometry.rows.every((row, i) => i === 0 || row.y > geometry.rows[i - 1].y));
});
