#!/usr/bin/env node
/**
 * Browser QA and tests still duplicating the shared harness or fake engine.
 * Each metric counts files, so repeated uses in one file count once.
 *
 *   node scripts/report-qa-harness.mjs
 *   node scripts/report-qa-harness.mjs --json
 *   node scripts/report-qa-harness.mjs --write-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_PATH = path.join(
  ROOT,
  'scripts',
  'qa-harness-baseline.json',
);

/** Engine assignments, inline options and engine factory returns, not strings or comments. */
export function engineLiteralLines(text) {
  const lines = [];
  const engineName = (name) =>
    !/Options$/.test(name ?? '') &&
    /^(?:_?engine(?:[A-Z0-9]\w*)?|\w+Engine(?:[A-Z0-9]\w*)?)$/.test(name ?? '');
  function walk(node, parent, factory) {
    if (!node || typeof node !== 'object') return;
    if (/Function|ObjectMethod/.test(node.type))
      factory = node.id?.name ?? parent?.id?.name ?? node.key?.name;
    if (node.type === 'ObjectExpression') {
      const name =
        parent?.type === 'VariableDeclarator'
          ? parent.id?.name
          : parent?.type === 'AssignmentExpression'
            ? parent.left?.computed
              ? parent.left.property?.value
              : (parent.left?.property?.name ?? parent.left?.name)
            : parent?.type === 'ObjectProperty'
              ? (parent.key?.name ?? parent.key?.value)
              : null;
      const keys = node.properties.map((property) => property.key?.name);
      const host = node.properties.find(
        (property) => property.key?.name === 'host',
      )?.value;
      const globeHost =
        host?.type === 'ObjectExpression' &&
        host.properties.some((property) =>
          ['canvas', 'container', 'size'].includes(property.key?.name),
        );
      const adapterKind = node.properties.some(
        (property) =>
          property.key?.name === 'kind' &&
          ['cesium', 'navara'].includes(property.value?.value),
      );
      const returned =
        parent?.type === 'ReturnStatement' ||
        parent?.type === 'ArrowFunctionExpression';
      // A factory's { engine, ...observations } is a harness, not its engine.
      if (
        engineName(name) ||
        globeHost ||
        (adapterKind &&
          keys.some((key) =>
            ['camera', 'render', 'credits', 'maps'].includes(key),
          )) ||
        (returned &&
          engineName(factory) &&
          !keys.includes('engine') &&
          keys.some((key) =>
            [
              'kind',
              'host',
              'camera',
              'frames',
              'render',
              'credits',
              'maps',
            ].includes(key),
          ))
      )
        lines.push(node.loc.start.line);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value))
        for (const child of value) walk(child, node, factory);
      else if (value && typeof value === 'object') walk(value, node, factory);
    }
  }
  walk(parsers.babel.parse(text));
  return lines;
}

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
  {
    id: 'testEngineLiterals',
    label: 'Test files with their own engine literal',
    measure: (files) =>
      files.filter(
        ({ file, text }) =>
          file.endsWith('.test.mjs') && engineLiteralLines(text).length,
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

export function readTestSources(root = ROOT) {
  return ['build', 'scripts', 'server', 'src'].flatMap((directory) => {
    const base = path.join(root, directory);
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base, { recursive: true })
      .sort()
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => ({
        file: `${directory}/${name.split(path.sep).join('/')}`,
        text: fs.readFileSync(path.join(base, name), 'utf8'),
      }));
  });
}

export function measureQaHarness(root = ROOT) {
  const files = readQaSources(root);
  const tests = readTestSources(root);
  return Object.fromEntries(
    QA_HARNESS_METRICS.map(({ id, measure }) => [
      id,
      measure(id === 'testEngineLiterals' ? tests : files),
    ]),
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
