#!/usr/bin/env node
/**
 * Browser QA still doing work owned by scripts/qa-strict-harness.mjs.
 * Each metric counts scripts, so repeated uses in one script count once.
 *
 *   node scripts/report-qa-harness.mjs
 *   node scripts/report-qa-harness.mjs --json
 *   node scripts/report-qa-harness.mjs --write-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_PATH = path.join(
  ROOT,
  'scripts',
  'qa-harness-baseline.json',
);

const readsCesiumState = (text) => {
  const names = [
    '__godsEyeView',
    ...[
      ...text.matchAll(
        /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:window\.)?__godsEyeView\s*[;,]/g,
      ),
    ].map((match) => match[1]),
  ];
  return names.some((name) =>
    new RegExp(
      `\\b${name}\\s*\\??\\.\\s*(?:viewer|tileset|scene)\\b|\\{[^{}]*\\b(?:viewer|tileset|scene)\\b[^{}]*\\}\\s*=\\s*(?:window\\.)?${name}\\b`,
    ).test(text),
  );
};

export const QA_HARNESS_METRICS = Object.freeze([
  {
    id: 'ownLaunch',
    label: 'Scripts launching puppeteer themselves',
    measure: (files) =>
      files.filter(({ text }) => /\bpuppeteer\.launch\s*\(/.test(text)).length,
  },
  {
    id: 'fixedSleeps',
    label: 'Scripts with setTimeout-based pauses',
    measure: (files) =>
      files.filter(({ text }) =>
        /new\s+Promise\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*(?:\{\s*(?:return\s+)?)?setTimeout\s*\(\s*\1\s*[,)]/.test(
          text,
        ),
      ).length,
  },
  {
    id: 'loadingScreenReadiness',
    label: 'Scripts waiting for #loading-screen without waitForEngine',
    measure: (files) =>
      files.filter(
        ({ text }) =>
          /\bwaitFor(?:Selector|Function)\s*\([^;]*#loading-screen\b/.test(
            text,
          ) && !/\bwaitForEngine\s*\(/.test(text),
      ).length,
  },
  {
    id: 'cesiumOnlyReads',
    label: 'Scripts reading __godsEyeView viewer, tileset or scene',
    measure: (files) =>
      files.filter(({ text }) => readsCesiumState(text)).length,
  },
  {
    id: 'ownWaitHelpers',
    label: 'Scripts defining their own waitFor functions',
    measure: (files) =>
      files.filter(({ text }) =>
        /\bfunction\s+waitFor\w*\s*\(|\b(?:const|let|var)\s+waitFor\w*\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(
          text,
        ),
      ).length,
  },
]);

/** QA scripts, including the shared harness itself, but excluding tests. */
export function readQaSources(root = ROOT) {
  return fs
    .readdirSync(path.join(root, 'scripts'))
    .filter((name) => /^qa-.*\.mjs$/.test(name) && !name.endsWith('.test.mjs'))
    .sort()
    .map((name) => ({
      file: `scripts/${name}`,
      text: fs.readFileSync(path.join(root, 'scripts', name), 'utf8'),
    }));
}

export function measureQaHarness(root = ROOT) {
  const files = readQaSources(root);
  return Object.fromEntries(
    QA_HARNESS_METRICS.map(({ id, measure }) => [id, measure(files)]),
  );
}

export function harnessGrowth(measured, baseline) {
  return QA_HARNESS_METRICS.filter(
    ({ id }) => !(measured[id] <= (baseline[id] ?? -Infinity)),
  ).map(({ id, label }) => ({
    id,
    label,
    measured: measured[id],
    baseline: baseline[id],
  }));
}

export function readBaseline(file = BASELINE_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(args) {
  const measured = measureQaHarness();
  if (args.includes('--write-baseline')) {
    const note = args.find((arg) => arg.startsWith('--note='))?.slice(7);
    fs.writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ metrics: measured, ...(note ? { measuredAt: note } : {}) }, null, 2)}\n`,
    );
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(measured, null, 2));
    return;
  }
  const baseline = fs.existsSync(BASELINE_PATH) ? readBaseline().metrics : {};
  for (const { id, label } of QA_HARNESS_METRICS) {
    const was = baseline[id];
    const change =
      was === undefined
        ? ''
        : ` (baseline ${was}, ${measured[id] - was >= 0 ? '+' : ''}${measured[id] - was})`;
    console.log(`${String(measured[id]).padStart(7)}  ${label}${change}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main(process.argv.slice(2));
