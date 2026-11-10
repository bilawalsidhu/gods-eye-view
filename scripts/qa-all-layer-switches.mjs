import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { APPLICATION_LAYER_DIRECTORY } from '../src/app/layers/directory.js';
import {
  assertPreviewPortAvailable,
  createStrict,
  ENGINES,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { closeBrowser, exitAfterFlush } from './qa/browser.mjs';
import { runScenario } from './qa/process.mjs';
import {
  classifyAttempt,
  historyLine,
  retryStatus,
  statusCounts,
} from './qa/acceptance.mjs';

// The strict acceptance: every browser scenario against one keyless local
// preview, under the strict network policy (scripts/qa-strict-harness.mjs),
// writing <output>/acceptance.json, one log and one assertion manifest per
// scenario. A timed-out pass is hung; a retry that passes is flaky and does
// not fail the run. QA_EXIT_DIAGNOSTICS=1 preserves Chrome resources and
// reports them five seconds after strict completion instead of forcing exit.
// Pages start at 2026-11-03T18:30:00Z unless createStrict's time overrides it.
//
//   node scripts/qa-all-layer-switches.mjs http://127.0.0.1:4208 <output>
//     [--serve[=<commit>]]  build <commit> (default HEAD) keyless in a clean
//                           worktree and serve it with every .env key blank
//     [--scratch=DIR]       where --serve puts its checkout and build
//     [--only=a,b]          run only these labels
//     [--no-retry]          disable the one retry of a non-passing scenario
//     [--history=FILE]      append a JSONL run summary; inspect it with
//                           node scripts/report-acceptance-flake.mjs FILE
//     [--quick]             the soak with 2 runs of 10 switches and 100
//                           switches for the long run
//
// The run fails when a scenario fails, when any catalog layer (read from
// the live page and cross-checked with src/app/layers/directory.js) has no
// assertion on either engine, or when any network policy violation shows.

const startedAt = new Date().toISOString();
const base = localPreview(process.argv[2]);
const output = process.argv[3]?.startsWith('--')
  ? mkdtempSync(join(tmpdir(), 'gev-acceptance-'))
  : resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), 'gev-acceptance-')));
const flag = (name) =>
  process.argv
    .find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
    ?.split('=')[1] ?? (process.argv.includes(`--${name}`) ? true : null);
const only = flag('only') ? String(flag('only')).split(',') : null;
const quick = Boolean(flag('quick'));
mkdirSync(join(output, 'evidence'), { recursive: true });
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const dirty = () =>
  git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));

// Fail once, with the fix, instead of once per scenario.
let chrome;
try {
  const browser = await puppeteer.launch({ headless: true });
  chrome = await browser.version();
  await closeBrowser(browser);
} catch (error) {
  console.error(
    'Puppeteer cannot start Chrome: ' +
      String(error?.message)
        .split('\n')[0]
        .replace(/ This can occur.*/, '') +
      '\nPoint PUPPETEER_EXECUTABLE_PATH at an installed Chrome, for example\n' +
      '  PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
      'or download the pinned build with `npx puppeteer browsers install chrome`.',
  );
  process.exit(2);
}

// Every name the checkout's .env files define, plus key-like names in this
// environment: all blank for the build and the preview.
const KEY_LIKE = /(_KEY|_TOKEN|_SECRET|_CLIENT_ID|PASSWORD)$/;
/** The [name, value] pairs of the checkout's .env and .env.local, in order. */
const dotenv = () =>
  ['.env', '.env.local']
    .filter((file) => existsSync(join(root, file)))
    .flatMap((file) => readFileSync(join(root, file), 'utf8').split('\n'))
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)/))
    .filter(Boolean)
    .map(([, name, raw]) => [name, raw.trim().replace(/^["']|["']$/g, '')]);
const dotenvNames = () => [...new Set(dotenv().map(([name]) => name))].sort();
const envNames = () =>
  [
    ...new Set([
      ...dotenvNames(),
      ...Object.keys(process.env).filter((name) => KEY_LIKE.test(name)),
    ]),
  ].sort();
// Credentials only (model names and URLs are settings the code may also
// carry as defaults).
const envValues = () =>
  dotenv()
    .filter(([name, value]) => KEY_LIKE.test(name) && value.length >= 8)
    .map(([, value]) => value);
const scrubbed = () => ({
  ...process.env,
  ...Object.fromEntries(envNames().map((name) => [name, ''])),
});

// The report names no local directory: the output, the served checkout and
// this repository become placeholders (logs carry stack traces).
const machinePaths = (text) => {
  let out = String(text);
  for (const [path, name] of [
    [served?.scratch, '<scratch>'],
    [output, '<output>'],
    [root.replace(/\/$/, ''), '<repo>'],
  ])
    if (path) out = out.split(path).join(name);
  return out;
};
let served = null;
let preview = null;
const cleanup = () => {
  if (preview && !preview.killed) preview.kill('SIGTERM');
  if (served?.worktree)
    try {
      git('worktree', 'remove', '--force', served.worktree);
      served.worktree = null;
    } catch (error) {
      console.error('Could not remove', served.worktree, error.message);
    }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

if (flag('serve')) {
  const commit = git(
    'rev-parse',
    flag('serve') === true ? 'HEAD' : String(flag('serve')),
  ).trim();
  // --scratch=DIR keeps the checkout and build out of the system temp.
  const scratchRoot = flag('scratch')
    ? resolve(String(flag('scratch')))
    : tmpdir();
  mkdirSync(scratchRoot, { recursive: true });
  await assertPreviewPortAvailable(base.href);
  const scratch = mkdtempSync(join(scratchRoot, 'gev-acceptance-build-'));
  const worktree = join(scratch, 'checkout');
  const dist = join(scratch, 'dist');
  git('worktree', 'add', '--detach', worktree, commit);
  symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'));
  served = {
    scratch,
    commit,
    worktree,
    dist,
    // Names from .env files only; other key-like variables of this shell
    // are blanked too but only counted.
    blankedEnv: dotenvNames(),
    otherKeyLikeVariablesBlanked: envNames().filter(
      (name) => !dotenvNames().includes(name),
    ).length,
    envFilesInCheckout: ['.env', '.env.local'].filter((f) =>
      existsSync(join(worktree, f)),
    ),
  };
  console.log('Building', commit, 'keyless into', dist);
  const build = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist],
    { cwd: worktree, env: scrubbed(), encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (build.status !== 0) {
    console.error(build.stdout + build.stderr);
    process.exit(2);
  }
  // No .env credential value may reach the built files.
  const values = envValues();
  let leaks = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(js|html|json|css|webmanifest)$/.test(name)) {
        const text = readFileSync(file, 'utf8');
        for (const value of values) if (text.includes(value)) leaks++;
      }
    }
  };
  walk(dist);
  served.distCredentialValuesFound = leaks;
  served.mainChunk = JSON.parse(
    spawnSync(
      process.execPath,
      [join(root, 'scripts/check-main-chunk.mjs'), `--dist=${dist}`, '--json'],
      { cwd: root, encoding: 'utf8' },
    ).stdout || 'null',
  );
  preview = spawn(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--outDir',
      dist,
      '--host',
      base.hostname,
      '--port',
      base.port,
      '--strictPort',
    ],
    { cwd: worktree, env: scrubbed(), stdio: 'ignore' },
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base.origin + '/')).ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

try {
  const response = await fetch(base.origin + '/', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
} catch (error) {
  console.error(
    'No preview answers at ' + base.origin + ' (' + error.message + ').',
  );
  process.exit(2);
}

// The preview reports no paid key: its own keyless status routes.
const probe = async (path) => {
  try {
    const r = await fetch(base.origin + path, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (error) {
    return { error: error.message };
  }
};
const keys = {
  openaiHudSummary: await probe('/api/openai/hud-summary/status'),
  firms: await probe('/api/firms/status'),
  tomtom: await probe('/api/tomtom/status'),
  mapillary: await probe('/api/mapillary/status'),
};
const paidKeysConfigured = [
  keys.openaiHudSummary.body?.configured !== false && 'OpenAI',
  keys.firms.body?.hasKey !== false && 'FIRMS',
  keys.tomtom.body?.hasKey !== false && 'TomTom',
  keys.mapillary.body?.configured !== false && 'Mapillary',
].filter(Boolean);

const dirtyFiles = dirty();
const soakRuns = quick
  ? ['--runs=2', '--swaps=10']
  : ['--runs=6', '--swaps=50'];
const longRun = quick ? '--swaps=100' : '--swaps=500';
// label, script, layers, extra arguments, timeout in seconds.
const runs = [
  ['engine-switch', 'engine-switch', ['earthquakes']],
  ['director-engine-switch', 'director-engine-switch', []],
  ['layer-handoff', 'layer-handoff', ['flights']],
  ['layer-handoff--military', 'layer-handoff', ['military'], ['--military']],
  [
    'ground-layer-switch',
    'ground-layer-switch',
    ['ais-live-vessels', 'air-quality', 'gnss-integrity', 'fire-perimeters'],
  ],
  [
    'contact-switch',
    'contact-switch',
    ['military-awareness', 'military-installations'],
  ],
  ['local-adsb-engine-switch', 'local-adsb-engine-switch', ['local-adsb']],
  ['ghostmaps-switch', 'ghostmaps-switch', ['s2-ghostmaps']],
  ['wildlife-switch', 'wildlife-switch', ['wildlife-sightings']],
  [
    'open-layers-switch',
    'open-layers-switch',
    ['drone-airspace', 'osm-places', 'sea-marks', 'ski-pistes'],
  ],
  [
    'weather-engine-switch',
    'weather-engine-switch',
    [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ],
  ],
  ['wind-engine-switch', 'wind-engine-switch', ['wind']],
  [
    'infrastructure-engine-switch',
    'infrastructure-engine-switch',
    ['local-dams', 'local-datacenters'],
  ],
  [
    'submarine-cables-engine-switch',
    'submarine-cables-engine-switch',
    ['telegeography-submarine-cables'],
  ],
  ['directions-engine-switch', 'directions-engine-switch', ['directions']],
  ['nepal-locator-switch', 'nepal-locator-switch', ['bhote-koshi-locator']],
  ['nepal-event-switch', 'nepal-event-switch', ['bhote-koshi-2026']],
  ['traffic-engine-switch', 'traffic-engine-switch', ['traffic']],
  [
    'traffic-engine-switch--simulation',
    'traffic-engine-switch',
    ['traffic'],
    ['--simulation'],
  ],
  [
    'street-level-engine-switch',
    'street-level-engine-switch',
    ['street-level'],
  ],
  [
    'street-level-engine-switch--panoramax',
    'street-level-engine-switch',
    ['street-level'],
    ['--panoramax'],
  ],
  ['radio-engine-switch', 'radio-engine-switch', ['radio']],
  ['imagery-contract', 'imagery-contract', ['recent-imagery']],
  ['fire-camera-switch', 'fire-camera-switch', ['alpr-cameras']],
  [
    'fire-camera-switch--fires',
    'fire-camera-switch',
    ['local-firms'],
    ['--fires'],
  ],
  ['urban-engine-switch', 'urban-engine-switch', ['bikeshare']],
  [
    'urban-engine-switch--transit',
    'urban-engine-switch',
    ['transit'],
    ['--transit'],
  ],
  ['cctv-engine-switch', 'cctv-engine-switch', ['cctv']],
  ['space-engine-switch', 'space-engine-switch', ['satellites']],
  [
    'space-engine-switch--missions',
    'space-engine-switch',
    ['rocket-launches'],
    ['--missions'],
  ],
  // One application per page, and voice across a switch: these block paid
  // routes themselves but do not run under the strict harness, so they add
  // no assertion manifest and no network ledger.
  ['app-once', 'app-once', [], [], 600, true],
  ['voice-engine-switch', 'voice-engine-switch', [], [], 300, true],
  ['strict-rapid-switch', 'strict-rapid-switch', []],
  ['strict-hidden-switch', 'strict-hidden-switch', []],
  ['strict-context-loss', 'strict-context-loss', []],
  ['strict-parked-release', 'strict-parked-release', []],
  ['strict-navara-hd', 'strict-navara-hd', []],
  ['strict-failure-matrix', 'strict-failure-matrix', [], [], 600],
  ['strict-cold-chunks', 'strict-cold-chunks', []],
  ['strict-prod-smoke', 'strict-prod-smoke', []],
  // The app's visual styles, bloom, contact sonar, cockpit clouds, and the
  // annotations, Draw, Import and the scope mask with the celestial ring on
  // Navara (those are tools and display overlays, not catalog layers:
  // TOOL_IDS).
  ['navara-visual-styles', 'navara-visual-styles', []],
  ['navara-bloom', 'navara-bloom', []],
  ['navara-sonar', 'navara-sonar', []],
  ['navara-cockpit-clouds', 'navara-cockpit-clouds', []],
  ['navara-annotations', 'navara-annotations', ['annotations']],
  ['navara-draw', 'navara-draw', ['draw']],
  ['navara-geo-import', 'navara-geo-import', ['geo-import']],
  ['navara-scope', 'navara-scope', ['scope-mask', 'celestial-ring']],
  ['strict-soak', 'strict-soak', [], soakRuns, 1200],
  [
    'strict-soak--long',
    'strict-soak',
    [],
    ['--runs=1', longRun, '--assert'],
    1800,
  ],
];
// Ids a scenario covers that are tools, not catalog layers: their
// assertions are recorded, but the catalog comparison leaves them out.
const TOOL_IDS = new Set([
  'annotations',
  'draw',
  'geo-import',
  'scope-mask',
  'celestial-ring',
]);
const scenarioIds = [
  ...new Set(
    runs.flatMap(([, , ids]) => ids).filter((id) => !TOOL_IDS.has(id)),
  ),
].sort();
const directoryIds = APPLICATION_LAYER_DIRECTORY.map((l) => l.id).sort();

// The catalog as the live page has it, on both engines.
const liveCatalog = {};
{
  const strict = createStrict({
    origin: base.origin,
    layers: [],
    name: 'catalog',
  });
  const browser = await strict.launch();
  try {
    for (const engine of ENGINES) {
      const page = await browser.newPage();
      await page.goto(
        `${base.origin}/?engine=${engine}&welcome=0#v=2&lat=30.27&lon=-97.74&alt=12000&pitch=-90&map=osm&l=`,
      );
      await waitForEngine(page, engine);
      liveCatalog[engine] = await page.evaluate(() =>
        [...window.__godsEyeView.dataManager.layers.keys()].sort(),
      );
      await page.close();
    }
  } finally {
    await closeBrowser(browser);
  }
  liveCatalog.violations = strict.ledger.violations;
}

const scenarios = [];
const report = {
  commit: git('rev-parse', 'HEAD').trim(),
  dirty: dirtyFiles.length > 0,
  dirtyFiles,
  dirtyFilesAtEnd: null,
  chrome,
  puppeteerExecutable: process.env.PUPPETEER_EXECUTABLE_PATH || null,
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  baseUrl: base.origin,
  preview: served
    ? {
        servedByRunner: true,
        appCommit: served.commit,
        appCheckoutClean: true,
        scenariosFrom: 'the same clean checkout',
        envFilesInCheckout: served.envFilesInCheckout,
        blankedEnv: served.blankedEnv,
        otherKeyLikeVariablesBlanked: served.otherKeyLikeVariablesBlanked,
        distCredentialValuesFound: served.distCredentialValuesFound,
      }
    : { servedByRunner: false },
  keyProbes: keys,
  paidKeysConfigured,
  mainChunk: served?.mainChunk ?? null,
  networkPolicy: {
    blockedFirst:
      'Google (*.googleapis.com, *.google.com, maps.google.*, *.gstatic.com), Cesium ion (*.cesium.com), preview /api/openai/*, /api/realtime/*, /api/google/*',
    allowed:
      'the preview origin, each scenario’s declared fixture URLs, keyless probes answered by the harness, and the free tile hosts answered from the disk cache',
    keylessProbes: (await import('./qa-map-policy.mjs')).KEYLESS_PROBES.map(
      (p) => p.pattern,
    ),
    tileHosts: (await import('./qa-map-policy.mjs')).STRICT_TILE_HOSTS,
  },
  catalog: {
    directory: directoryIds,
    live: liveCatalog,
    scenarios: scenarioIds,
  },
  startedAt,
  finishedAt: null,
  passed: 0,
  failed: 0,
  counts: statusCounts([]),
  networkViolations: 0,
  coverage: null,
  uncovered: null,
  scenarios,
};
const save = () =>
  writeFileSync(
    join(output, 'acceptance.json'),
    machinePaths(JSON.stringify(report, null, 2)) + '\n',
  );
save();

for (const [label, name, layers, extra = [], seconds = 300, external] of runs) {
  if (only && !only.includes(label)) continue;
  const script = 'scripts/qa-' + name + '.mjs';
  const evidence = join(output, 'evidence', label + '.json');
  const args = [base.origin, ...extra];
  if (external) args.splice(0, 1, base.origin + '/');
  else args.push(`--layers=${layers.join(',')}`, `--evidence=${evidence}`);
  const start = Date.now();
  // With --serve the scenarios run from the same clean checkout the app was
  // built from, so other work in this tree cannot change them.
  const scripts = served?.worktree ?? root;
  const attempts = [];
  for (let attempt = 1; attempt <= (flag('no-retry') ? 1 : 2); attempt++) {
    rmSync(evidence, { force: true });
    const attemptStart = Date.now();
    const run = await runScenario(
      process.execPath,
      [join(scripts, script), ...args],
      {
        timeout: seconds * 1000,
        env: scrubbed(),
      },
    );
    const log = machinePaths(
      (run.stdout || '') + (run.stderr || '') + (run.error?.message || ''),
    );
    let manifest = null;
    let evidenceError = null;
    if (existsSync(evidence)) {
      try {
        manifest = JSON.parse(machinePaths(readFileSync(evidence, 'utf8')));
      } catch (error) {
        evidenceError = 'Invalid evidence: ' + error.message;
      }
    }
    const status =
      evidenceError && !run.error
        ? 'fail'
        : classifyAttempt(run, manifest, { external });
    const logFile = `${label}.attempt-${attempt}.log`;
    const evidenceFile = manifest
      ? `evidence/${label}.attempt-${attempt}.json`
      : null;
    writeFileSync(join(output, logFile), log);
    if (manifest)
      writeFileSync(
        join(output, evidenceFile),
        JSON.stringify(manifest, null, 2) + '\n',
      );
    attempts.push({
      status,
      exitCode: run.status,
      seconds: Math.round((Date.now() - attemptStart) / 100) / 10,
      log: logFile,
      logSha256: createHash('sha256').update(log).digest('hex'),
      evidence: evidenceFile,
      error: evidenceError ?? manifest?.error ?? run.error?.message ?? null,
    });
    writeFileSync(join(output, label + '.log'), log);
    if (manifest)
      writeFileSync(evidence, JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      status.toUpperCase(),
      label,
      attempts.at(-1).seconds,
      `attempt ${attempt}`,
    );
    if (status === 'pass' || attempt === 2 || flag('no-retry')) break;
  }
  const last = attempts.at(-1);
  const status = retryStatus(attempts[0].status, attempts[1]?.status);
  const manifest = last.evidence
    ? JSON.parse(readFileSync(join(output, last.evidence), 'utf8'))
    : null;
  scenarios.push({
    label,
    script,
    args: args.map((arg) =>
      arg.includes(output) ? arg.replace(output, '<output>') : arg,
    ),
    layers,
    external: Boolean(external),
    status,
    exitCode: last.exitCode,
    seconds: Math.round((Date.now() - start) / 100) / 10,
    log: label + '.log',
    logSha256: last.logSha256,
    attempts,
    evidence: manifest ? 'evidence/' + label + '.json' : null,
    assertions: manifest?.assertions.length ?? 0,
    coverage: manifest?.coverage ?? null,
    picks: manifest?.picks ?? [],
    network: manifest
      ? {
          requests: manifest.network.requests,
          violations: manifest.network.violations,
          external: manifest.network.external,
          tileCache: manifest.network.tileCache,
          probes: manifest.network.probes,
          routes: manifest.network.routes,
          previewApi: manifest.network.previewApi,
          fixtures: manifest.network.fixtures,
        }
      : null,
    contracts: manifest?.contracts ?? null,
    error: last.error,
  });
  if (manifest?.soak) scenarios.at(-1).soak = manifest.soak;
  report.counts = statusCounts(scenarios);
  report.passed = report.counts.pass + report.counts.flaky;
  report.failed = scenarios.length - report.passed;
  report.networkViolations =
    scenarios.reduce(
      (sum, row) => sum + (row.network?.violations.length ?? 0),
      0,
    ) + liveCatalog.violations.length;
  save();
  console.log(status.toUpperCase(), label, scenarios.at(-1).seconds);
}

// Coverage that cannot be faked: every catalog id needs an assertion on each
// engine from some scenario's manifest.
const catalogIds = [
  ...new Set([...directoryIds, ...(liveCatalog.navara ?? [])]),
].sort();
report.coverage = Object.fromEntries(
  catalogIds.map((id) => [
    id,
    Object.fromEntries(
      ENGINES.map((engine) => [
        engine,
        scenarios.reduce(
          (sum, row) => sum + (row.coverage?.[id]?.[engine] ?? 0),
          0,
        ),
      ]),
    ),
  ]),
);
report.uncovered = Object.entries(report.coverage).flatMap(([id, counts]) =>
  ENGINES.filter((engine) => !counts[engine]).map(
    (engine) => `${id}@${engine}`,
  ),
);
report.catalogMatches =
  JSON.stringify(liveCatalog.navara) === JSON.stringify(directoryIds) &&
  JSON.stringify(liveCatalog.cesium) === JSON.stringify(directoryIds) &&
  JSON.stringify(scenarioIds) === JSON.stringify(directoryIds);
report.finishedAt = new Date().toISOString();
report.dirtyFilesAtEnd = dirty();
save();
if (flag('history'))
  appendFileSync(
    resolve(String(flag('history'))),
    JSON.stringify(historyLine(report)) + '\n',
  );
console.log(
  `${catalogIds.length} catalog layers, ${report.uncovered.length} engine slots without an assertion, ` +
    `${report.networkViolations} network violations, ${report.passed}/${scenarios.length} scenarios, ` +
    Object.entries(report.counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ') +
    ', ' +
    `paid keys configured: ${paidKeysConfigured.join(', ') || 'none'}. ${join(output, 'acceptance.json')}`,
);
if (
  report.failed ||
  (!only && report.uncovered.length) ||
  report.networkViolations ||
  paidKeysConfigured.length ||
  !report.catalogMatches
)
  process.exitCode = 1;
// The preview child would keep this process alive: stop it and drop the
// checkout now.
cleanup();
await exitAfterFlush();
