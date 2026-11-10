import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_HARNESS_METRICS,
  harnessGrowth,
  measureQaHarness,
  readBaseline,
  readQaSources,
} from './report-qa-harness.mjs';

test('QA harness duplication does not grow past the baseline', () => {
  assert.deepEqual(
    harnessGrowth(measureQaHarness(), readBaseline().metrics),
    [],
    'QA harness duplication grew; use scripts/qa-strict-harness.mjs helpers for browser launch, engine readiness and camera waits instead.',
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
