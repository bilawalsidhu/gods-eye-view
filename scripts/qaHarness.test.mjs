import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_HARNESS_METRICS,
  engineLiteralLines,
  harnessGrowth,
  measureQaHarness,
  readBaseline,
  readQaSources,
  readTestSources,
} from './report-qa-harness.mjs';

test('QA harness duplication does not grow past the baseline', () => {
  assert.deepEqual(
    harnessGrowth(measureQaHarness(), readBaseline().metrics),
    [],
    'QA duplication grew; use the shared browser harness and src/globe/testing/fakeEngine.js for test engines.',
  );
});

test('the baseline names every metric', () => {
  assert.deepEqual(
    Object.keys(readBaseline().metrics).sort(),
    QA_HARNESS_METRICS.map(({ id }) => id).sort(),
  );
});

test('a metric that grows is reported, one that falls is not', () => {
  const baseline = Object.fromEntries(
    QA_HARNESS_METRICS.map(({ id }) => [id, 10]),
  );
  assert.deepEqual(
    harnessGrowth({ ...baseline, ownLaunch: 11, fixedSleeps: 3 }, baseline).map(
      ({ id }) => id,
    ),
    ['ownLaunch'],
  );
  assert.equal(harnessGrowth(baseline, {}).length, QA_HARNESS_METRICS.length);
});

test('QA sources include the harness and exclude tests and other reports', () => {
  const names = readQaSources().map(({ file }) => file);
  assert.ok(names.includes('scripts/qa-strict-harness.mjs'));
  assert.ok(!names.some((name) => name.endsWith('.test.mjs')));
  assert.ok(!names.includes('scripts/report-qa-harness.mjs'));
});

test('test sources include nested tests and exclude runtime files', () => {
  const names = readTestSources().map(({ file }) => file);
  assert.ok(names.includes('src/globe/testing/fakeEngine.test.mjs'));
  assert.ok(names.includes('scripts/qaHarness.test.mjs'));
  assert.ok(names.every((name) => name.endsWith('.test.mjs')));
});

test('engine literals include assignments, inline options and factory returns', () => {
  for (const source of [
    'const engine = {};',
    'let engine; engine = { camera: {} };',
    'scene.engine = { host: {} };',
    "scene['engine'] = {};",
    'init({ engine: {} });',
    'const state = { _engine: {} };',
    'const engineB = {}, trafficEngine = {};',
    "function createEngine() { return { kind: 'cesium' }; }",
    'const engine = () => ({ camera: {} });',
    'const fakeEngine = () => { return { host: {} }; };',
    'const factory = { createEngine() { return { render: {} }; } };',
    'inspect({ host: { size() {} }, camera: {} });',
    "const navara = { kind: 'navara', render: {} };",
  ])
    assert.ok(engineLiteralLines(source).length > 0, source);
  assert.deepEqual(
    engineLiteralLines('const engine = {};\ninit({ engine: {} });'),
    [1, 2],
  );
});

test('engine literal counting ignores source text, options and harness observations', () => {
  for (const source of [
    '// const engine = {};',
    "const source = 'const engine = {};';",
    'const source = `init({ engine: {} });`;',
    'const engine = createFakeEngine();',
    'init({ engine: createFakeEngine() });',
    'const options = { engineOptions: {} };',
    'const engineOptions = { canvas: {}, width: 800 };',
    "const headers = { host: 'localhost' };",
    'const overlay = { host: { setEntries() {} } };',
    'result[engine] = { camera: {} };',
    'function observedEngine() { return { engine, camera }; }',
    'function observedEngine() { return { snapshots: [] }; }',
    'function observedEngine() { return records.map(() => ({ camera: {} })); }',
  ])
    assert.deepEqual(engineLiteralLines(source), [], source);
});

test('engine literal metric counts test files once and rejects baseline growth', () => {
  const metric = QA_HARNESS_METRICS.find(
    ({ id }) => id === 'testEngineLiterals',
  );
  const measured = metric.measure([
    {
      file: 'src/one.test.mjs',
      text: 'const engine = {}; init({ engine: {} });',
    },
    {
      file: 'scripts/two.test.mjs',
      text: 'const engine = () => ({ host: {} });',
    },
    { file: 'src/three.test.mjs', text: 'const engine = createFakeEngine();' },
    { file: 'src/runtime.js', text: 'const engine = {};' },
  ]);
  assert.equal(measured, 2);
  const baseline = Object.fromEntries(
    QA_HARNESS_METRICS.map(({ id }) => [id, 0]),
  );
  assert.deepEqual(
    harnessGrowth({ ...baseline, testEngineLiterals: measured }, baseline).map(
      ({ id }) => id,
    ),
    ['testEngineLiterals'],
  );
});

test('metrics count scripts once and distinguish helpers from their callers', () => {
  const measure = (id, ...sources) =>
    QA_HARNESS_METRICS.find((metric) => metric.id === id).measure(
      sources.map((text) => ({ text })),
    );
  assert.equal(
    measure(
      'ownLaunch',
      'puppeteer.launch({}); puppeteer.launch({});',
      'launchBrowser();',
    ),
    1,
  );
  assert.equal(
    measure(
      'fixedSleeps',
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'await new Promise((resolve) => { setTimeout(resolve, 1000); });',
      'await new Promise((resolve) => setTimeout(resolve));',
      'new Promise((resolve) => requestAnimationFrame(resolve));',
      'setTimeout(() => reject(new Error()), 1000);',
    ),
    3,
  );
  assert.equal(
    measure(
      'loadingScreenReadiness',
      "page.waitForSelector('#loading-screen');",
      "page.waitForSelector('#loading-screen'); await waitForEngine(page);",
      "document.querySelector('#loading-screen');",
    ),
    1,
  );
  assert.equal(
    measure(
      'cesiumOnlyReads',
      'window.__godsEyeView?.viewer; window.__godsEyeView.tileset;',
      'const { scene } = window.__godsEyeView;',
      'const app = window.__godsEyeView; app.viewer;',
      'window.__godsEyeView.sceneDirector;',
      'window.__godsEyeView.engine;',
    ),
    3,
  );
  assert.equal(
    measure(
      'ownWaitHelpers',
      'async function waitForReady() {}',
      'const waitForReady = async (page) => page.ready();',
      'await waitForEngine(page);',
      "import { waitForEngine } from './qa-strict-harness.mjs';",
    ),
    2,
  );
});
