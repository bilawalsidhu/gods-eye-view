/**
 * Browser proof for review R2: the mounted app's search box
 * finds satellites from the satellite engine, animates the look-at and marks the
 * object; a satellite with no position reports it honestly.
 *   node scripts/qa-sky-satsearch.mjs --url http://127.0.0.1:4337 --out <dir>
 * Live Sky time (fresh elements), Houston, real worker + /api/celestrak.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4337');
const OUT = path.resolve(arg('--out', 'qa-sky-satsearch'));
const SETTLE_MS = Number(arg('--settle-ms', '20000'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...p) => {
  const line = p
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ');
  log.push(line);
  console.log(line);
};

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
    errors.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && /\/skyView\/|\/api\/celestrak\//.test(r.url()))
    errors.push(`${r.status()} ${r.url().slice(0, 200)}`);
});
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.viewer, {
  timeout: 180000,
});
await page.waitForSelector('.gev-sky-btn', { timeout: 180000 });
await sleep(SETTLE_MS);
await page.keyboard.press('Escape');

const HANDLE = `(async () => {
  const m = await import('/src/skyView/skyView.js');
  return m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;

let state = null;
for (let i = 0; i < 90; i++) {
  state = await page.evaluate(async (src) => {
    const h = await eval(src);
    if (!h.active)
      await h.enterAt({
        latDeg: 29.7604,
        lonDeg: -95.3698,
        source: 'manual',
        heightM: 15,
        heightKnown: true,
      });
    return {
      active: h.active,
      content: h.content.status,
      sats: h.satellites.status,
      meta: h.satellites.meta.length,
      ticks: h.satellites.stats.ticks,
    };
  }, HANDLE);
  if (state.active && state.sats === 'ready' && state.ticks > 0) break;
  await sleep(2000);
}
say('sky state', state);
if (!(state.active && state.sats === 'ready'))
  throw new Error('sats never ready');

/** Type into the real search box and submit; returns what the UI shows. */
async function searchBox(text, { waitMs = 1400 } = {}) {
  await page.evaluate(() => {
    const q = document.querySelector('[data-sky=sky-search-query]');
    q.value = '';
  });
  await page.click('[data-sky=sky-search-query]');
  await page.type('[data-sky=sky-search-query]', text);
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll('[data-sky=sky-search-result]')].map(
      (b) => b.textContent,
    ),
  );
  const before = await page.evaluate(
    async (src) => ({ ...(await eval(src)).view }),
    HANDLE,
  );
  // record the view on every animation frame for 2.5 s (proves animation)
  await page.evaluate(async (src) => {
    const h = await eval(src);
    // pause Cesium's own render loop (software GL: ~1 s per globe frame in
    // this headless browser) so animation frames come at display rate
    window.__godsEyeView.viewer.useDefaultRenderLoop = false;
    window.__lookSamples = [];
    const t0 = performance.now();
    const step = () => {
      window.__lookSamples.push([
        h.view.azDeg,
        h.view.elDeg,
        Math.round(performance.now() - t0),
      ]);
      if (performance.now() - t0 < 2500) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, HANDLE);
  await page.keyboard.press('Enter');
  await sleep(2600 + waitMs);
  const samples = await page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = true;
    return window.__lookSamples;
  });
  return page.evaluate(
    async ({ src, listed, before, samples }) => {
      const h = await eval(src);
      h.redraw();
      const marker = h.content.marker;
      const stats = h.content.lastStats;
      let target = null;
      let dot = null;
      if (marker?.target?.type === 'satellite') {
        const id = marker.target.id;
        const o = h.satellites
          .objectsAt(h.clock.getTime())
          .find((x) => x.index === id);
        target = o
          ? { name: o.name, noradId: o.noradId, azDeg: o.azDeg, elDeg: o.elDeg }
          : null;
        dot = h.satelliteModel?.dots?.find((d) => d.index === id) ?? null;
      }
      const top = h.content.lastResults[0];
      return {
        top: top
          ? { kind: top.kind, label: top.label, id: top.target?.id }
          : null,
        topNorad:
          top?.kind === 'satellite'
            ? h.satellites.meta[top.target.id]?.noradId
            : null,
        listed,
        status: document.querySelector('[data-sky=sky-search-status]')
          .textContent,
        marker: marker ? { label: marker.label, target: marker.target } : null,
        markerPx: stats.marker,
        dotPx: dot ? { x: dot.x, y: dot.y } : null,
        target,
        before: [before.azDeg, before.elDeg],
        samples,
        after: [h.view.azDeg, h.view.elDeg],
      };
    },
    { src: HANDLE, listed, before, samples },
  );
}

const results = {};
// 1) ISS by name, whatever its elevation right now
results.iss = await searchBox('ISS');
say('ISS', results.iss);
await page.screenshot({ path: path.join(OUT, '20-search-iss.png') });

// 2) the highest uniquely named satellite now: look-at + marker on the dot
const pick = await page.evaluate(async (src) => {
  const h = await eval(src);
  const meta = h.satellites.meta;
  const n = new Map();
  for (const m of meta) n.set(m.name, (n.get(m.name) || 0) + 1);
  const objs = h.satellites
    .objectsAt(h.clock.getTime())
    .filter((o) => n.get(o.name) === 1 && o.elDeg > 20 && o.elDeg < 60)
    .sort((a, b) => b.elDeg - a.elDeg);
  const below = meta.findIndex(
    (m, i) => n.get(m.name) === 1 && !h.satellites.lookup(i)?.row,
  );
  // look the other way first so the look-at has to travel
  if (objs[0]) h.setView({ azDeg: (objs[0].azDeg + 150) % 360, elDeg: 20 });
  return {
    up: objs[0] ? { name: objs[0].name, index: objs[0].index } : null,
    below: below >= 0 ? meta[below].name : null,
  };
}, HANDLE);
say('picked', pick);
results.up = await searchBox(pick.up.name);
say('UP', results.up);
await page.screenshot({ path: path.join(OUT, '21-search-up.png') });
// 3) a satellite the worker reports no position for (below -2 deg)
results.below = await searchBox(pick.below, { waitMs: 300 });
say('BELOW', results.below);

const d = results.up;
const markerOnDot =
  d.markerPx && d.dotPx
    ? Math.hypot(d.markerPx.x - d.dotPx.x, d.markerPx.y - d.dotPx.y)
    : null;
// the look-at aims at the position at submit time, printed in the status
const m = /az ([\d.]+)°, alt (-?[\d.]+)°/.exec(d.status);
const aimed = m ? [Number(m[1]), Number(m[2])] : null;
const dAz = aimed
  ? Math.abs(((d.after[0] - aimed[0] + 540) % 360) - 180)
  : null;
const distinct = new Set(
  d.samples.map((x) => `${x[0].toFixed(4)},${x[1].toFixed(4)}`),
);
// intermediate frames: neither the start view nor the end view
const between = d.samples.filter(
  (x) =>
    Math.abs(x[0] - d.before[0]) > 1e-6 && Math.abs(x[0] - d.after[0]) > 1e-6,
).length;
const animated = distinct.size > 2 && between > 0;
const checks = {
  issTopIsStation:
    results.iss.top?.kind === 'satellite' && results.iss.topNorad === 25544,
  issStatus: /^ISS \(ZARYA\): az|No position for ISS \(ZARYA\) right now/.test(
    results.iss.status,
  ),
  issNotMeissa: results.iss.marker?.label !== 'Meissa',
  upMarker:
    d.marker?.target?.type === 'satellite' && d.marker.label === pick.up.name,
  upMarkerOnDotPx: markerOnDot,
  upLookAtAzErrDeg: dAz,
  upLookAtElErrDeg: aimed ? Math.abs(d.after[1] - aimed[1]) : null,
  upAnimated: animated,
  upAnimationFrames: d.samples.length,
  upIntermediateFrames: between,
  belowStatus: /below the horizon or not computed yet/.test(
    results.below.status,
  ),
  belowNoJump:
    results.below.after[0] === results.below.before[0] &&
    results.below.after[1] === results.below.before[1],
  pageErrors: errors.length,
};
say('CHECKS', checks);
const pass =
  checks.issTopIsStation &&
  checks.issStatus &&
  checks.issNotMeissa &&
  checks.upMarker &&
  markerOnDot != null &&
  markerOnDot < 3 &&
  dAz < 0.06 &&
  checks.upLookAtElErrDeg < 0.06 &&
  checks.upAnimated &&
  checks.belowStatus &&
  checks.belowNoJump &&
  errors.length === 0;
say(pass ? 'QA SATSEARCH PASS' : 'QA SATSEARCH FAIL', errors);
fs.writeFileSync(
  path.join(OUT, 'satsearch-results.json'),
  JSON.stringify({ state, pick, results, checks, errors, pass }, null, 2),
);
fs.writeFileSync(path.join(OUT, 'satsearch-log.txt'), log.join('\n'));
await browser.close();
process.exit(pass ? 0 : 1);
