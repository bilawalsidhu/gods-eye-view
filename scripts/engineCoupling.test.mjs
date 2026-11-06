import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_COUPLING_METRICS,
  couplingGrowth,
  measureEngineCoupling,
  readBaseline,
} from './report-engine-coupling.mjs';

test('engine coupling does not grow past the baseline', () => {
  const growth = couplingGrowth(
    measureEngineCoupling(),
    readBaseline().metrics,
  );
  assert.deepEqual(
    growth,
    [],
    'Code outside the globe engines grew more engine-specific. Draw through ' +
      'the globe contract instead; only a deliberate exception may raise ' +
      'scripts/engine-coupling-baseline.json (--write-baseline).',
  );
});

test('the baseline names every metric', () => {
  const { metrics } = readBaseline();
  assert.deepEqual(
    Object.keys(metrics).sort(),
    ENGINE_COUPLING_METRICS.map(({ id }) => id).sort(),
  );
});

test('a metric that grows is reported, one that falls is not', () => {
  const baseline = Object.fromEntries(
    ENGINE_COUPLING_METRICS.map(({ id }) => [id, 10]),
  );
  const measured = { ...baseline, viewerLines: 11, navaraKindChecks: 3 };
  assert.deepEqual(
    couplingGrowth(measured, baseline).map(({ id }) => id),
    ['viewerLines'],
  );
});
