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

test('renderer attachment counts definitions once per module, not calls', () => {
  const { measure } = ENGINE_COUPLING_METRICS.find(
    ({ id }) => id === 'attachRendererWithViewer',
  );
  assert.equal(
    measure([
      {
        text: 'attachRenderer(viewer, options = {}) {}\nattachRenderer(scene) {}',
      },
      { text: 'function attachRenderer(\n _viewer, options\n) {}' },
      { text: 'const attachRenderer = (nextViewer) => {};' },
      {
        text: 'attachRenderer(_scene); layer.attachRenderer(viewer, options);',
      },
      { text: 'attachRenderer(engine) {}' },
      { text: 'attachRenderer(viewerState) {}' },
    ]),
    3,
  );
});

test('restore flags count layer directories and surface calls exclude globe', () => {
  const measure = (id, files) =>
    ENGINE_COUPLING_METRICS.find((metric) => metric.id === id).measure(files);
  assert.equal(
    measure('restoreFlagCopies', [
      {
        file: 'src/layers/traffic/lifecycle.js',
        text: 'state._restoringViewport = true;',
      },
      {
        file: 'src/layers/traffic/viewport.js',
        text: 'state._restoringViewport',
      },
      { file: 'src/layers/alpr/index.js', text: 'let restoringView = false;' },
      {
        file: 'src/layers/streetLevel/index.js',
        text: 'let waitingForView = false;',
      },
      { file: 'src/app/view.js', text: 'let restoringView = false;' },
    ]),
    3,
  );
  const text = [
    'terrainHeight',
    'sampleHeight',
    'sampleHeightDetailed',
    'sampleTerrainMostDetailed',
    'clampToHeight',
    'raycast',
  ]
    .map((name) => `engine.surface.${name}(point);`)
    .join('\n');
  assert.equal(
    measure('surfaceCallsOutsideGlobe', [
      { file: 'src/globe/navara/surface.js', text },
      { file: 'src/layers/traffic/viewport.js', text },
      {
        file: 'src/app/view.js',
        text: 'engine.surface?.raycast?.(ray); surface.tilesLoaded();',
      },
    ]),
    7,
  );
});

test('engine switch layer ids count lines and follow the catalog', () => {
  const { measure } = ENGINE_COUPLING_METRICS.find(
    ({ id }) => id === 'engineSwitchLayerIds',
  );
  assert.equal(
    measure([
      {
        file: 'src/standalone/engineSwitch.js',
        text: "get('directions'); get('satellites');\nget('traffic');\nget('not-a-layer');",
      },
      { file: 'src/app/view.js', text: "get('directions');" },
    ]),
    2,
  );
});
