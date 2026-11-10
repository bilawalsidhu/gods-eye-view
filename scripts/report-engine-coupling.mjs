#!/usr/bin/env node
/**
 * How tightly the application is still tied to one globe engine: counts of
 * engine-specific code outside the engines (src/globe/cesium, src/globe/navara).
 * The renderer-abstraction work drives every number down; none may grow.
 * engineCoupling.test.mjs (npm test) compares a fresh count with
 * scripts/engine-coupling-baseline.json.
 *
 * Only production sources count: `.js` and `.vue` under src. Tests, fixtures
 * and test doubles are `.mjs`.
 *
 *   node scripts/report-engine-coupling.mjs            # table
 *   node scripts/report-engine-coupling.mjs --json
 *   node scripts/report-engine-coupling.mjs --write-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPLICATION_LAYER_DIRECTORY } from '../src/app/layers/directory.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_PATH = path.join(
  ROOT,
  'scripts',
  'engine-coupling-baseline.json',
);

const inEngine = (file) =>
  file.startsWith('src/globe/cesium/') || file.startsWith('src/globe/navara/');
const inGlobe = (file) => file.startsWith('src/globe/');
const isLayerRenderer = (engine) => (file) =>
  file.startsWith('src/layers/') &&
  new RegExp(`/render/${engine}([^/]*\\.js|/.+\\.js)$`).test(file);
const isRenderer = (file) => /\/render\//.test(file);

const lines = (text) => text.split('\n');
const countLines = (text, pattern) =>
  lines(text).filter((line) => pattern.test(line)).length;
const countMatches = (text, pattern) =>
  (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
const layerIds = new Set(APPLICATION_LAYER_DIRECTORY.map(({ id }) => id));

/**
 * The metrics, in report order. `measure(files)` gets every production
 * source as `{ file, text }` (file relative to the repository, with `/`).
 */
export const ENGINE_COUPLING_METRICS = Object.freeze([
  {
    id: 'attachRendererWithViewer',
    label: 'Modules defining attachRenderer with a viewer or scene parameter',
    measure: (files) =>
      files.filter(({ text }) =>
        /\battachRenderer\s*(?:(?:=|:)\s*(?:async\s+)?(?:function\s*)?)?\(\s*(?:viewer|_viewer|nextViewer|_scene|scene)\s*(?:,[^)]*|=[^)]*)?\)\s*(?:\{|=>)/.test(
          text,
        ),
      ).length,
  },
  {
    id: 'restoreFlagCopies',
    label: 'Layer directories keeping their own view-restore flag',
    measure: (files) =>
      new Set(
        files
          .filter(
            ({ file, text }) =>
              file.startsWith('src/layers/') &&
              /\b(?:_restoringViewport|restoringView|waitingForView)\b/.test(
                text,
              ),
          )
          .map(({ file }) => file.split('/')[2]),
      ).size,
  },
  {
    id: 'surfaceCallsOutsideGlobe',
    label: 'Surface sampling calls outside src/globe',
    measure: (files) =>
      files
        .filter(({ file }) => !inGlobe(file))
        .reduce(
          (sum, { text }) =>
            sum +
            countMatches(
              text,
              /\bsurface\??\.\s*(?:terrainHeight|sampleHeight|sampleHeightDetailed|sampleTerrainMostDetailed|clampToHeight|raycast)\s*(?:\?\.)?\(/,
            ),
          0,
        ),
  },
  {
    id: 'engineSwitchLayerIds',
    label: 'Lines naming catalog layer ids in src/standalone/engineSwitch.js',
    measure: (files) =>
      files
        .filter(({ file }) => file === 'src/standalone/engineSwitch.js')
        .reduce(
          (sum, { text }) =>
            sum +
            lines(text).filter((line) =>
              [...line.matchAll(/(['"])([^'"\n]+)\1/g)].some((match) =>
                layerIds.has(match[2]),
              ),
            ).length,
          0,
        ),
  },
  {
    id: 'cesiumLayerRendererLines',
    label: 'Lines in src/layers/**/render/cesium*',
    measure: (files) =>
      files
        .filter(({ file }) => isLayerRenderer('cesium')(file))
        .reduce((sum, { text }) => sum + lines(text).length, 0),
  },
  {
    id: 'navaraLayerRendererLines',
    label: 'Lines in src/layers/**/render/navara*',
    measure: (files) =>
      files
        .filter(({ file }) => isLayerRenderer('navara')(file))
        .reduce((sum, { text }) => sum + lines(text).length, 0),
  },
  {
    id: 'cesiumImportFiles',
    label: "Files importing 'cesium' outside src/globe/cesium and render/",
    measure: (files) =>
      files.filter(
        ({ file, text }) =>
          !file.startsWith('src/globe/cesium/') &&
          !isRenderer(file) &&
          /from\s+['"]cesium['"]|import\(\s*['"]cesium['"]\s*\)/.test(text),
      ).length,
  },
  {
    id: 'viewerLines',
    label: 'Lines naming `viewer` outside src/globe/cesium',
    measure: (files) =>
      files
        .filter(({ file }) => !file.startsWith('src/globe/cesium/'))
        .reduce((sum, { text }) => sum + countLines(text, /\bviewer\b/), 0),
  },
  {
    id: 'navaraKindChecks',
    label: "`kind === 'navara'` checks outside src/globe",
    measure: (files) =>
      files
        .filter(({ file }) => !inGlobe(file))
        .reduce(
          (sum, { text }) =>
            sum + countMatches(text, /kind\s*[!=]==?\s*['"]navara['"]/),
          0,
        ),
  },
  {
    id: 'engineSniffCalls',
    label: 'isGlobeEngine calls outside src/globe',
    measure: (files) =>
      files
        .filter(({ file }) => !inGlobe(file))
        .reduce(
          (sum, { text }) => sum + countMatches(text, /\bisGlobeEngine\(/),
          0,
        ),
  },
  {
    id: 'engineExtensionReads',
    label: 'Reads of engine.extensions (cesium, navara) outside src/globe',
    measure: (files) =>
      files
        .filter(({ file }) => !inGlobe(file))
        .reduce(
          (sum, { text }) =>
            sum + countMatches(text, /\bextensions\??\.(?:navara|cesium)\b/),
          0,
        ),
  },
  {
    id: 'groundEffectPasses',
    label: 'Navara ground passes (defineGroundEffect calls)',
    measure: (files) =>
      files.reduce(
        (sum, { text }) =>
          // Calls only: the helper's own declaration is not a pass.
          sum + countMatches(text, /(?<!function )\bdefineGroundEffect\(\s*\{/),
        0,
      ),
  },
  {
    id: 'cesiumSdkLoads',
    label: 'Cesium SDK loads outside the engines and loadCesium.js',
    measure: (files) =>
      files
        .filter(
          ({ file }) => !inEngine(file) && file !== 'src/app/loadCesium.js',
        )
        .reduce(
          (sum, { text }) =>
            sum + countMatches(text, /\b(?:loadCesiumSdk|whenCesiumSdk)\(/),
          0,
        ),
  },
  {
    id: 'screenSpaceHandlerFiles',
    label: 'Files in src/layers and src/data using ScreenSpaceEventHandler',
    measure: (files) =>
      files.filter(
        ({ file, text }) =>
          (file.startsWith('src/layers/') || file.startsWith('src/data/')) &&
          /ScreenSpaceEventHandler/.test(text),
      ).length,
  },
  {
    id: 'engineNameLines',
    label:
      "Lines with an engine name literal ('navara', 'cesium') outside src/globe",
    measure: (files) =>
      files
        .filter(({ file }) => !inGlobe(file))
        .reduce(
          (sum, { text }) =>
            sum + countLines(text, /['"](?:navara|cesium)['"]/),
          0,
        ),
  },
]);

/** Production sources under `root`/src: `.js` and `.vue`. */
export function readProductionSources(root = ROOT) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        /\.(?:js|vue)$/.test(entry.name) &&
        !/\.test\./.test(entry.name)
      )
        files.push({
          file: path.relative(root, absolute).split(path.sep).join('/'),
          text: fs.readFileSync(absolute, 'utf8'),
        });
    }
  };
  visit(path.join(root, 'src'));
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** Every metric's value for the sources under `root`. */
export function measureEngineCoupling(root = ROOT) {
  const files = readProductionSources(root);
  return Object.fromEntries(
    ENGINE_COUPLING_METRICS.map(({ id, measure }) => [id, measure(files)]),
  );
}

/** The metrics that grew past `baseline`, with both values. */
export function couplingGrowth(measured, baseline) {
  return ENGINE_COUPLING_METRICS.filter(
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
  const measured = measureEngineCoupling();
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
  for (const { id, label } of ENGINE_COUPLING_METRICS) {
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
