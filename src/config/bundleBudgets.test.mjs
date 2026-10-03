import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../../src/testSupport/readSource.js';
import {
  BUNDLE_BUDGETS,
  DEFAULT_CHUNK_BUDGET,
  DIST_TOTAL_BUDGET,
  PRECACHE_FILE_LIMIT,
  PRECACHE_ROW_IDS,
  PRECACHE_TOTAL_BUDGET,
  classifyBundleFile,
  evaluateBundleBudgets,
} from './bundleBudgets.js';

/**
 * Bundle budgets (docs/PLAN.md Phase 7, issue #40): dist growth is a
 * reviewed decision, and the workbox per-file cap must never silently drop
 * the offline shell. These tests pin the policy table, the evaluator's
 * failure modes, and the wiring that makes CI actually run the gate.
 */

const readRepoFile = (relative) => readSource(relative, import.meta.url);

test('budget table is well-formed and the index chunk sits at the workbox cap', () => {
  assert.ok(BUNDLE_BUDGETS.length >= 5, 'the measured chunks each have a row');
  const ids = new Set();
  for (const row of BUNDLE_BUDGETS) {
    assert.ok(row.id, 'every row has an id');
    assert.ok(!ids.has(row.id), `row ids are unique (${row.id})`);
    ids.add(row.id);
    assert.ok(row.pattern instanceof RegExp, `${row.id} pattern is a RegExp`);
    assert.ok(!row.pattern.global, `${row.id} pattern must not be sticky across calls`);
    assert.ok(Number.isInteger(row.budget) && row.budget > 0, `${row.id} budget is a positive integer`);
    assert.ok(row.label, `${row.id} has a human label`);
    assert.ok(row.why, `${row.id} records the measured baseline it was set from`);
  }
  const indexRow = BUNDLE_BUDGETS.find((row) => row.id === 'index-chunk');
  assert.equal(indexRow.budget, PRECACHE_FILE_LIMIT, 'index chunk budget IS the workbox per-file cap');
  assert.equal(PRECACHE_FILE_LIMIT, 6 * 1024 * 1024);
  assert.ok(DEFAULT_CHUNK_BUDGET > 0 && DEFAULT_CHUNK_BUDGET < PRECACHE_FILE_LIMIT);
  assert.ok(PRECACHE_TOTAL_BUDGET > PRECACHE_FILE_LIMIT, 'the shell total allows the index chunk plus document and styles');
  assert.ok(DIST_TOTAL_BUDGET > PRECACHE_TOTAL_BUDGET);
  assert.deepEqual(
    [...PRECACHE_ROW_IDS].sort(),
    ['css', 'index-chunk', 'index-html'],
    'precache rows mirror the workbox globPatterns',
  );
});

test('classification of the measured 2026-09-13 build artifacts', () => {
  const expect = [
    ['assets/index-DJpUHRcE.js', 'index-chunk'],
    ['assets/index-BYt2_oYW.css', 'css'],
    ['index.html', 'index-html'],
    ['assets/egm96-universal.esm-D6y_VLZc.js', 'egm96'],
    ['assets/regions-RPMKg9pq.js', 'regions'],
    ['assets/marine-BJ61ZZ9E.js', 'marine'],
    ['assets/san-francisco-B-TUYeaR.js', 'san-francisco'],
    // The Phase 15A seam chunks each carry a deliberate row: a removed row
    // would drop the chunk onto the 512 KiB default ceiling instead of its
    // reviewed budget.
    ['assets/voice-c0I72W_Q.js', 'voice-seam'],
    ['assets/annotations-8ewpohNJ.js', 'annotations-seam'],
    ['assets/scenes-BYIcqdqj.js', 'scenes-seam'],
    ['assets/cockpitCloudEffects-D7aQ0GFe.js', 'cockpit-seam'],
    ['assets/firstRunExperience-BFpi_u0Z.js', 'first-run-seam'],
  ];
  for (const [file, id] of expect) {
    assert.equal(classifyBundleFile(file)?.id, id, `${file} classifies as ${id}`);
  }
  // Workers have no row — they fall to the default ceiling.
  assert.equal(classifyBundleFile('assets/detectionProjection.worker-DY6qzSar.js'), null);
  assert.equal(classifyBundleFile('assets/aisVisibility.worker-CvtoPNK-.js'), null);
});

test('over-budget chunks fail with the remedy and the measured-baseline why', () => {
  const { violations } = evaluateBundleBudgets({
    files: [
      { path: 'assets/egm96-universal.esm-D6y_VLZc.js', bytes: 3_100_000 },
      { path: 'assets/newFeature-AbCdEf123.js', bytes: DEFAULT_CHUNK_BUDGET + 1 },
      { path: 'assets/index-DJpUHRcE.js', bytes: 6_056_871 },
    ],
  });
  assert.equal(violations.length, 2);
  const egm96 = violations.find((violation) => violation.path.startsWith('assets/egm96'));
  assert.equal(egm96.code, 'OVER_BUDGET');
  assert.match(egm96.message, /raise its budget deliberately in src\/config\/bundleBudgets\.js/);
  assert.match(egm96.message, /2,770,496 B/, 'the measured baseline is quoted back');
  const unbudgeted = violations.find((violation) => violation.path.startsWith('assets/newFeature'));
  assert.equal(unbudgeted.code, 'OVER_BUDGET');
  assert.match(unbudgeted.message, /add an explicit budget row/, 'a new chunk cannot ship unbounded silently');
});

test('shell files the built sw.js failed to precache are violations, and stale entries are flagged', () => {
  const files = [
    { path: 'assets/index-DJpUHRcE.js', bytes: 6_056_871 },
    { path: 'assets/index-BYt2_oYW.css', bytes: 187_410 },
    { path: 'index.html', bytes: 55_022 },
  ];
  // Manifest missing the CSS: exactly what the workbox cap's silent drop looks like.
  const missingCss = evaluateBundleBudgets({ files, precacheManifestUrls: ['index.html', 'assets/index-DJpUHRcE.js'] });
  assert.deepEqual(
    missingCss.violations.filter((violation) => violation.code === 'NOT_PRECACHED').map((violation) => violation.path),
    ['assets/index-BYt2_oYW.css'],
  );
  // Manifest listing something the build never emitted: a stale service worker.
  const stale = evaluateBundleBudgets({
    files,
    precacheManifestUrls: [...files.map((file) => file.path), 'assets/index-STALE123.js'],
    knownPaths: files.map((file) => file.path),
  });
  assert.deepEqual(
    stale.violations.filter((violation) => violation.code === 'STALE_PRECACHE_ENTRY').map((violation) => violation.path),
    ['assets/index-STALE123.js'],
  );
  // Manifest entries outside the budgeted set (icons, svgs) resolve against
  // the full dist listing, not just the budgeted artifacts.
  const withIcons = evaluateBundleBudgets({
    files,
    precacheManifestUrls: [...files.map((file) => file.path), 'icon.svg', 'icons/icon-192.png'],
    knownPaths: [...files.map((file) => file.path), 'icon.svg', 'icons/icon-192.png', 'cesium/Assets/see Ionic.jpg'],
  });
  assert.equal(withIcons.violations.length, 0, 'non-shell precache entries do not false-positive');
  // No manifest provided (sw.js absent): the size checks still run, membership checks do not.
  const noManifest = evaluateBundleBudgets({ files, precacheManifestUrls: null });
  assert.equal(noManifest.violations.length, 0);
  assert.equal(noManifest.precacheTotal, 6_056_871 + 187_410 + 55_022);
});

test('shell-total and dist-total ceilings fire with their own remedy', () => {
  const overShell = evaluateBundleBudgets({
    files: [{ path: 'assets/index-DJpUHRcE.js', bytes: PRECACHE_TOTAL_BUDGET - 100_000 }, { path: 'assets/index-BYt2_oYW.css', bytes: 200_000 }],
  });
  assert.equal(overShell.violations.at(-1).code, 'OVER_PRECACHE_TOTAL');
  assert.match(overShell.violations.at(-1).message, /PRECACHE_TOTAL_BUDGET/);
  const overDist = evaluateBundleBudgets({
    files: [{ path: 'assets/index-DJpUHRcE.js', bytes: 6_056_871 }],
    distTotal: DIST_TOTAL_BUDGET + 1,
  });
  assert.equal(overDist.violations.at(-1).code, 'OVER_DIST_TOTAL');
  assert.match(overDist.violations.at(-1).message, /something large was added/);
});

test('the workbox precache contract in vite.config.js stays pinned to this table', () => {
  const viteConfig = readRepoFile('../../vite.config.js');
  assert.match(
    viteConfig,
    /globPatterns: \['index\.html', 'assets\/index-\*\.js', 'assets\/\*\.css'\]/,
    'the precache globs define the shell this module budgets — keep PRECACHE_ROW_IDS in sync',
  );
  assert.match(
    viteConfig,
    /maximumFileSizeToCacheInBytes: 6 \* 1024 \* 1024/,
    'the workbox per-file cap must equal PRECACHE_FILE_LIMIT',
  );
});

test('CI runs the gate after the production build', () => {
  const packageJson = JSON.parse(readRepoFile('../../package.json'));
  assert.equal(packageJson.scripts['check:budgets'], 'node scripts/check-bundle-budgets.mjs');
  const ci = readRepoFile('../../.github/workflows/ci.yml');
  const buildStep = ci.indexOf('- name: Production build');
  const gateStep = ci.indexOf('npm run check:budgets');
  assert.notEqual(buildStep, -1, 'the build job builds');
  assert.notEqual(gateStep, -1, 'the build job runs the budget gate');
  assert.ok(gateStep > buildStep, 'the gate runs on the fresh build output');
});
