#!/usr/bin/env node
/**
 * The W1 layer parity checklist (plan, "Чек-лист паритета"), engine-neutral:
 * everything goes through the globe engine and the QA probe
 * (window.__godsEyeView.layers), the layer's data through the QA fixture
 * sources (?qaFeed=, src/app/layers/qaSources.js). The same run on Cesium and
 * on Navara writes comparable JSON; --compare diffs two runs.
 *
 *   node scripts/qa-w1-layers.mjs --base-url=http://localhost:PORT/
 *     --layer=flights --engine=cesium|navara [--feed=flights:synthetic:10000]
 *     [--out=qa-artifacts/w1-layers/<layer>-<engine>.json]
 *   node scripts/qa-w1-layers.mjs --compare=A.json,B.json
 *
 * Sections (the checklist's numbers). Filled now: 1 view (object counts per
 * pose, screen points of 5 known objects), 8 idle (frames drawn in 2 s with
 * the layer on and the camera still), 9 errors (console errors; the layer
 * on/off 10 times leaves no mover sets behind). 2 click, 3 focus, 4 tracking,
 * 5 voice (window.__gevVoiceCommands.runner), 6 share link and 7 the layer's
 * own qa:* scripts are filled by each layer's task (*b); until then they
 * report TODO. A layer the engine does not have is SKIPPED with its reason.
 *
 * The server is the caller's (never ports 4185-4189). Browsers are always
 * headless. Exits 1 on a failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188, 4189]);
const POSES = {
  global: [-40, 30, 15_000_000, 0, -90],
  city: [-73.78, 40.64, 60_000, 0, -90],
  orbit: [-73.78, 40.64, 1_500_000, 0, -90],
};
const KNOWN_OBJECTS = 5;
const SCREEN_TOLERANCE_PX = 2;
const DEFAULT_FEEDS = {
  flights: 'flights:synthetic:10000',
  'ais-live-vessels': 'vessels:fixture',
};
const TODO_SECTIONS = {
  2: 'click',
  3: 'focus',
  4: 'tracking',
  5: 'voice',
  6: 'share link',
  7: "the layer's own qa:* scripts",
};

function compare(files) {
  const [a, b] = files.map((file) =>
    JSON.parse(fs.readFileSync(path.resolve(repoRoot, file), 'utf8')),
  );
  const differences = [];
  for (const pose of Object.keys(a.view ?? {})) {
    const left = a.view[pose];
    const right = b.view?.[pose];
    if (!right) {
      differences.push(`${pose}: missing in ${files[1]}`);
      continue;
    }
    if (left.onScreen !== right.onScreen)
      differences.push(
        `${pose}: ${left.onScreen} vs ${right.onScreen} objects on screen`,
      );
    for (const known of left.known) {
      const other = right.known.find(({ id }) => id === known.id);
      if (!known.screen || !other?.screen) {
        if (Boolean(known.screen) !== Boolean(other?.screen))
          differences.push(`${pose} ${known.id}: on screen on one engine only`);
        continue;
      }
      const d = Math.max(
        Math.abs(known.screen.x - other.screen.x),
        Math.abs(known.screen.y - other.screen.y),
      );
      if (d > SCREEN_TOLERANCE_PX)
        differences.push(`${pose} ${known.id}: ${d.toFixed(2)} px apart`);
    }
  }
  for (const line of differences) console.log(`[w1-layers] DIFF ${line}`);
  console.log(
    `[w1-layers] ${a.engine} vs ${b.engine} (${a.layer}): ${
      differences.length ? `${differences.length} difference(s)` : 'parity'
    }`,
  );
  process.exit(differences.length ? 1 : 0);
}

const compareArg = argument('compare');
if (compareArg) compare(compareArg.split(','));

const baseUrl = argument('base-url');
const layer = argument('layer');
const engineKind = argument('engine') ?? 'cesium';
if (!baseUrl || !layer) {
  console.error('--base-url=URL and --layer=ID are required');
  process.exit(2);
}
if (RESERVED_PORTS.has(Number(new URL(baseUrl).port))) {
  console.error('ports 4185-4189 are reserved');
  process.exit(2);
}
const feed = argument('feed') ?? DEFAULT_FEEDS[layer] ?? null;
const outFile =
  argument('out') ?? `qa-artifacts/w1-layers/${layer}-${engineKind}.json`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
};
const report = { layer, engine: engineKind, feed, view: {}, sections: {} };

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  const url = new URL(baseUrl);
  url.searchParams.set('engine', engineKind);
  if (feed) url.searchParams.set('qaFeed', feed);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
    timeout: 180_000,
    polling: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const available = await page.evaluate(
    (id) => window.__godsEyeView.layers.available(id),
    layer,
  );
  if (!available) {
    report.skipped = `no ${layer} layer on ${engineKind}`;
    console.log(`[w1-layers] SKIP ${report.skipped}`);
  } else {
    await page.evaluate((id) => window.__godsEyeView.layers.enable(id), layer);
    // 1. view: objects per pose, screen points of 5 known objects.
    let known = null;
    for (const [pose, camera] of Object.entries(POSES)) {
      const read = await page.evaluate(
        async ([lon, lat, height, heading, pitch], id) => {
          const geo = await import('/src/geo/index.js');
          const { engine, layers } = window.__godsEyeView;
          const rad = geo.math.toRadians;
          engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(lon, lat, height),
            orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
          });
          for (let frame = 0; frame < 30; frame++) {
            engine.render.request('qa-w1-layers');
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          const { width, height: h } = engine.host.size();
          const objects = layers.objects(id, 1_000_000);
          const inView = objects.filter(
            ({ screen }) =>
              screen &&
              screen.x >= 0 &&
              screen.y >= 0 &&
              screen.x <= width &&
              screen.y <= h,
          );
          return { total: objects.length, inView };
        },
        camera,
        layer,
      );
      known ??= read.inView
        .map(({ id }) => id)
        .sort()
        .slice(0, KNOWN_OBJECTS);
      report.view[pose] = {
        total: read.total,
        onScreen: read.inView.length,
        known: known.map((id) => ({
          id,
          screen: read.inView.find((row) => row.id === id)?.screen ?? null,
        })),
      };
      check(
        `1 view ${pose}: objects drawn`,
        read.total > 0,
        `${read.inView.length}/${read.total} on screen`,
      );
    }
    // 8. idle: the camera still for 2 s.
    const idleFrames = await page.evaluate(async () => {
      const { layers } = window.__godsEyeView;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const before = layers.framesDrawn();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return layers.framesDrawn() - before;
    });
    report.sections[8] = { framesIn2s: idleFrames };
    console.log(
      `  [INFO] 8 idle: ${idleFrames} frames in 2 s with ${layer} on`,
    );
    // 9. on/off 10 times: no mover sets left behind.
    const leftover = await page.evaluate(async (id) => {
      const { layers } = window.__godsEyeView;
      await layers.disable(id);
      const baseline = layers.movers().length;
      for (let i = 0; i < 10; i++) {
        await layers.enable(id);
        await layers.disable(id);
      }
      return { baseline, after: layers.movers().length };
    }, layer);
    report.sections[9] = { ...leftover, consoleErrors: consoleErrors.length };
    check(
      '9 on/off ×10 leaves no mover sets',
      leftover.after <= leftover.baseline,
      JSON.stringify(leftover),
    );
    check(
      '9 no console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || '0',
    );
    for (const [number, name] of Object.entries(TODO_SECTIONS)) {
      report.sections[number] = 'TODO';
      console.log(
        `  [TODO] ${number} ${name} — filled by the ${layer} layer task`,
      );
    }
  }
} finally {
  await browser.close();
}
const file = path.resolve(repoRoot, outFile);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 2));
const failed = results.filter(({ pass }) => !pass).length;
console.log(
  `[w1-layers] ${layer} on ${engineKind}: ${results.length - failed}/${results.length} passed → ${outFile}`,
);
process.exit(failed ? 1 : 0);
