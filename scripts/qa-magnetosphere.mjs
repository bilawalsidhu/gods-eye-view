#!/usr/bin/env node
/**
 * qa-magnetosphere — browser proof that the Magnetosphere layer draws the
 * field it claims to be drawing.
 *
 * The unit tests cover the field models to 1e-11 against the Python original,
 * so what is left for a browser gate is the wiring, and the wiring has exactly
 * one interesting failure mode: the layer can name an external model in its row
 * while the filaments on screen were never traced with one. That is not
 * hypothetical — it is how this layer shipped once, with the model imported and
 * never called, and nothing but the geometry would have caught it.
 *
 * So this gate measures the drawn polylines rather than trusting the label:
 *
 *   - filaments start at the Earth's surface and run past 25 Re, which only
 *     happens when an external field was in the integrator. Internal-only
 *     tracing stops at its 18 Re budget, so the two cannot be confused.
 *   - the magnetopause cage stands off from the surface instead of hugging it.
 *   - the row's named model and the geometry agree with each other.
 *
 * It then blocks `/api/magnetosphere` in a second session and asserts the
 * opposite: with no solar wind the layer still draws, names no model, and the
 * filaments stay inside the internal budget. A layer that quietly invented a
 * storm state would pass every other check here.
 *
 * Teardown is checked too, because two PolylineCollections are added to the
 * scene on enable and a leak there is invisible until the frame rate dies.
 *
 * Usage:
 *   node scripts/qa-magnetosphere.mjs [--url http://localhost:4173]
 *     [--headed] [--out qa-shots/magnetosphere] [--label live]
 *
 * Requires a running dev server. Writes <out>/<label>/results.json and a
 * screenshot. Exits non-zero on any failure; checks that depend on the live
 * NOAA feed are skipped, not failed, when that feed is down.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);
const rawUrl = arg('--url', 'http://localhost:4173');
const url = rawUrl.includes('welcome=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}welcome=0`;
const label = arg('--label', 'live');
const outDir = path.resolve(arg('--out', 'qa-shots/magnetosphere'), label);
mkdirSync(outDir, { recursive: true });

const LAYER_ID = 'magnetosphere';
/** Internal-only tracing stops here, so anything past it had help. */
const INTERNAL_BUDGET_RE = 18;
/** Comfortably above the internal budget and well below the external one. */
const EXTERNAL_EVIDENCE_RE = 25;
const BOOT_MS = 120_000;
const RETRACE_MS = 90_000;

const results = [];
let failures = 0;
let skips = 0;

/**
 * Record one assertion.
 *
 * @param {string} name What is being proven.
 * @param {boolean} passed Whether it held.
 * @param {string} [detail] Evidence, printed either way.
 */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

/**
 * Record an assertion that could not run for an environmental reason.
 *
 * @param {string} name What would have been proven.
 * @param {string} why Why it could not be.
 */
function skip(name, why) {
  results.push({ name, passed: null, detail: why });
  console.log(`[SKIP] ${name}  — ${why}`);
  skips += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch a browser.
 *
 * The two sessions below each get their own. Sharing one leaves the second
 * session contending with the first's Cesium scene for the renderer, and the
 * tracer - which yields between field lines - is the part that loses.
 *
 * @returns {Promise<import('puppeteer').Browser>} A fresh browser.
 */
const launch = () =>
  puppeteer.launch({
  headless: flag('--headed') ? false : 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1280,900',
    // The tracer yields with setTimeout between field lines. Chrome clamps
    // those timers in a backgrounded tab, which turns a few seconds of work
    // into minutes once this gate opens its second session.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

let browser = await launch();

/**
 * Open the app with the globe ready and the layer rows built.
 *
 * @param {(page: import('puppeteer').Page) => Promise<void>} [before] Runs
 *   after the page exists but before it navigates, for request interception.
 * @returns {Promise<object>} The page plus its collected errors.
 */
async function boot(before) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Unrelated optional providers: no key configured in a bare checkout.
    if (/403|setup\/status|nearby-places/.test(text)) return;
    errors.push(`console: ${text}`.slice(0, 200));
  });
  const serverErrors = [];
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().slice(0, 120)}`);
  });
  if (before) await before(page);
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: BOOT_MS });
  await page.waitForFunction(
    () => document.querySelectorAll('.data-toggle-row').length > 0,
    { timeout: BOOT_MS },
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__godsEyeView?.viewer, { timeout: BOOT_MS });
  return { page, errors, serverErrors };
}

/**
 * Measure every polyline collection on the scene.
 *
 * Duck-typed rather than matched on constructor name, which a bundler is free
 * to rename. Radii come back in Earth radii because that is the unit every
 * threshold in this gate is expressed in.
 *
 * @param {import('puppeteer').Page} page The page to measure.
 * @returns {Promise<object>} Primitive total and one entry per collection.
 */
const measure = (page) =>
  page.evaluate(() => {
    const scene = window.__godsEyeView.viewer.scene;
    const prims = scene.primitives;
    const collections = [];
    for (let i = 0; i < prims.length; i += 1) {
      const p = prims.get(i);
      if (!p || typeof p.get !== 'function' || typeof p.length !== 'number') continue;
      if (p.length === 0) continue;
      let first;
      try {
        first = p.get(0);
      } catch {
        continue;
      }
      if (!first || !Array.isArray(first.positions)) continue;
      let minRe = Infinity;
      let maxRe = 0;
      let points = 0;
      for (let k = 0; k < p.length; k += 1) {
        for (const c of p.get(k).positions) {
          const r = Math.hypot(c.x, c.y, c.z) / 6371000;
          if (r < minRe) minRe = r;
          if (r > maxRe) maxRe = r;
          points += 1;
        }
      }
      collections.push({
        lines: p.length,
        points,
        minRe: Number(minRe.toFixed(2)),
        maxRe: Number(maxRe.toFixed(2)),
      });
    }
    return { primitives: prims.length, collections };
  });

const metaText = (page) =>
  page.evaluate(
    (id) =>
      document.querySelector(`[data-layer-id="${id}"] .data-toggle-meta`)
        ?.textContent || '',
    LAYER_ID,
  );

const toggle = (page) =>
  page.evaluate((id) => {
    document.querySelector(`[data-layer-id="${id}"] .data-toggle-btn`).click();
  }, LAYER_ID);

/**
 * Filaments touch the surface; the magnetopause cage does not. That is the one
 * property that tells the two collections apart without depending on the order
 * they were added in.
 *
 * @param {object[]} collections Measured collections.
 * @returns {{filaments: ?object, boundary: ?object}} The split.
 */
function classify(collections) {
  const filaments = collections.find((c) => c.minRe <= 1.05) || null;
  const boundary = collections.find((c) => c !== filaments && c.minRe > 1.05) || null;
  return { filaments, boundary };
}

// ---------------------------------------------------------------- live feed

const live = await boot();
const baseline = await measure(live.page);
check(
  'the scene carries no magnetosphere polylines before the layer is enabled',
  baseline.collections.length === 0,
  `${baseline.primitives} primitive(s), ${baseline.collections.length} polyline collection(s)`,
);

const feed = await live.page.evaluate(async () => {
  try {
    const r = await fetch('/api/magnetosphere');
    return { status: r.status, body: await r.json() };
  } catch (e) {
    return { status: 0, body: null, error: String(e) };
  }
});
const feedUsable = feed.status === 200 && feed.body?.unavailable === false;
check(
  '/api/magnetosphere answers with the shape the client validates',
  feed.status === 200 && feed.body?.schemaVersion === 1,
  `HTTP ${feed.status}, schemaVersion ${feed.body?.schemaVersion}, unavailable ${feed.body?.unavailable}`,
);

await toggle(live.page);

// The first trace is internal-only and lands quickly; the external re-trace
// follows once the feed resolves. Wait for the geometry, not just the label.
let drawn = null;
let meta = '';
const deadline = Date.now() + RETRACE_MS;
while (Date.now() < deadline) {
  await sleep(2000);
  drawn = await measure(live.page);
  meta = await metaText(live.page);
  const { filaments } = classify(drawn.collections);
  if (filaments && (!feedUsable || filaments.maxRe > EXTERNAL_EVIDENCE_RE)) break;
}
const { filaments, boundary } = classify(drawn.collections);

check(
  'enabling the layer adds the filament and magnetopause collections',
  drawn.collections.length === 2 && Boolean(filaments) && Boolean(boundary),
  `${drawn.collections.length} collection(s): ${JSON.stringify(drawn.collections)}`,
);
check(
  'filaments are traced from the surface outward',
  Boolean(filaments) && filaments.lines >= 40 && filaments.minRe <= 1.05,
  filaments
    ? `${filaments.lines} lines, ${filaments.points} points, ${filaments.minRe}–${filaments.maxRe} Re`
    : 'no surface-touching collection found',
);
check(
  'the magnetopause stands off from the surface rather than hugging it',
  Boolean(boundary) && boundary.minRe > 3 && boundary.minRe < 25,
  boundary ? `nearest approach ${boundary.minRe} Re, ${boundary.lines} lines` : 'no boundary collection found',
);

const named = /T96|T89/.exec(meta)?.[0] || null;
if (!feedUsable) {
  skip(
    'the row names the external model driving the filaments',
    `live feed unusable (HTTP ${feed.status}, unavailable ${feed.body?.unavailable})`,
  );
  skip(
    'the external field actually reached the integrator',
    'depends on the live feed',
  );
} else {
  check(
    'the row names the external model driving the filaments',
    Boolean(named),
    `meta: "${meta}"`,
  );
  // The assertion this gate exists for. A named model with internal-only
  // geometry is the bug that shipped once already.
  check(
    'the external field actually reached the integrator, not just the label',
    Boolean(filaments) && filaments.maxRe > EXTERNAL_EVIDENCE_RE,
    filaments
      ? `farthest filament ${filaments.maxRe} Re (internal-only budget is ${INTERNAL_BUDGET_RE} Re)`
      : 'no filaments measured',
  );
}

await live.page.screenshot({ path: path.join(outDir, 'enabled.png') });

const enabledPrimitives = drawn.primitives;
await toggle(live.page);
await sleep(3000);
const off = await measure(live.page);
// Disable empties the two collections but deliberately keeps them on the scene
// to reuse, so the primitive count stays where enabling left it. What must not
// happen is a fresh pair being added every time.
check(
  'disabling the layer draws nothing while keeping its collections for reuse',
  off.collections.length === 0 && off.primitives === enabledPrimitives,
  `${off.collections.length} non-empty collection(s), ${off.primitives} primitive(s) held`,
);

await toggle(live.page);
await sleep(8000);
const again = await measure(live.page);
check(
  're-enabling draws again rather than leaving an empty scene',
  again.collections.length === 2,
  `${again.collections.length} collection(s)`,
);

// Three more round trips. A collection leaked per enable would show up here as
// a primitive count that climbs, long before it was visible as a dropped frame.
for (let i = 0; i < 3; i += 1) {
  await toggle(live.page);
  await sleep(1500);
  await toggle(live.page);
  await sleep(4000);
}
const cycled = await measure(live.page);
check(
  'repeated toggling does not accumulate primitives',
  cycled.primitives === enabledPrimitives,
  `${cycled.primitives} primitive(s) after four enable/disable cycles, was ${enabledPrimitives}`,
);

check('no console errors across the live run', live.errors.length === 0, live.errors.slice(0, 3).join(' | ') || 'clean');
check('no HTTP 5xx across the live run', live.serverErrors.length === 0, live.serverErrors.slice(0, 3).join(' | ') || 'clean');

// ------------------------------------------------------------- feed blocked

// Done with the live session. A fresh browser for the next one, so nothing
// the first session built can affect what the second measures.
await browser.close();
browser = await launch();

const blocked = await boot(async (page) => {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/api/magnetosphere')) return req.abort();
    return req.continue();
  });
});
// Chrome logs the aborted fetch as a failed resource load. That error is this
// gate's own doing, so it is not evidence against the layer; anything else is.
const injected = blocked.errors.splice(0, blocked.errors.length).filter(
  (e) => !/ERR_FAILED|ERR_ABORTED|Failed to load resource/.test(e),
);
blocked.errors.push(...injected);
await toggle(blocked.page);
// The internal trace is seconds of arithmetic yielded a line at a time, and how
// long that takes depends on the machine. Poll for the geometry rather than
// guessing a sleep long enough for the slowest CI box.
let dark = null;
let darkFilaments = null;
const darkDeadline = Date.now() + RETRACE_MS;
while (Date.now() < darkDeadline) {
  await sleep(2000);
  dark = await measure(blocked.page);
  darkFilaments = classify(dark.collections).filaments;
  if (darkFilaments && darkFilaments.lines >= 40) break;
}
const darkMeta = await metaText(blocked.page);

check(
  'with no solar wind the layer still draws the internal field',
  Boolean(darkFilaments) && darkFilaments.lines >= 40,
  darkFilaments ? `${darkFilaments.lines} lines, ${darkFilaments.minRe}–${darkFilaments.maxRe} Re` : 'nothing drawn',
);
// Inventing a storm state would look completely plausible on screen, so the
// absence of external-field geometry is the thing worth pinning.
check(
  'and does not invent an external field it has no inputs for',
  Boolean(darkFilaments) && darkFilaments.maxRe <= INTERNAL_BUDGET_RE + 2,
  darkFilaments
    ? `farthest filament ${darkFilaments.maxRe} Re, within the ${INTERNAL_BUDGET_RE} Re internal budget`
    : 'nothing drawn',
);
check(
  'and does not claim a model in the row',
  !/T96|T89/.test(darkMeta),
  `meta: "${darkMeta}"`,
);
const appErrors = blocked.errors.filter(
  (e) => !/ERR_FAILED|ERR_ABORTED|Failed to load resource/.test(e),
);
check(
  'a dead feed is handled rather than thrown',
  appErrors.length === 0,
  appErrors.slice(0, 3).join(' | ') ||
    'clean (the aborted fetch itself is this gate\'s doing and is excluded)',
);

await browser.close();

const passed = results.filter((r) => r.passed === true).length;
writeFileSync(
  path.join(outDir, 'results.json'),
  `${JSON.stringify({ url, label, feedUsable, named, baseline, drawn, off, again, cycled, dark, results }, null, 2)}\n`,
);
console.log(`\nWrote evidence to ${outDir}`);
console.log(`RESULT: ${passed} passed, ${failures} failed, ${skips} skipped`);
process.exitCode = failures ? 1 : 0;
