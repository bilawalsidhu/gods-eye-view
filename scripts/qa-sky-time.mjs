#!/usr/bin/env node
/**
 * Sky view final QA, headless Chromium against a
 * running GEV dev server:
 *
 *   node scripts/qa-sky-time.mjs --url http://127.0.0.1:4365 --out <dir>
 *        [--long-ms 600000] [--day-ms 24000] [--settle-ms 30000]
 *
 * 1. Presets through the UI at 3 sites (Houston, Sydney, Reykjavik): the
 *    Sunset button puts the drawn Sun (apparent, refraction-aware) at
 *    0 +/- 0.3 deg; Twilight end at -18 deg (airless); then screenshots at
 *    day (sunset - 4 h), dusk (sunset + 25 min) and night (twilight end
 *    + 1 h) = 9 shots, plus the ISS pass preset.
 * 2. x3600 for one simulated day (24 s wall) via the Play button: the worker
 *    backlog (satSky.stats.maxBacklog) never above 1 tick, every sampled
 *    Sky time = viewer.clock time, no console/page error.
 * 3. A 10-minute play-through at x60: backlog, heap at start/end, long tasks
 *    (> 50 ms) with Cesium's render loop on (software GL, info only), redraw
 *    p95, no console/page error.
 * Writes results.json, qa-log.txt and the screenshots. Exit 1 on a failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4365');
const OUT = path.resolve(arg('--out', 'qa-sky-time'));
const SETTLE_MS = Number(arg('--settle-ms', '30000'));
const DAY_WALL_MS = Number(arg('--day-ms', '24000'));
const LONG_WALL_MS = Number(arg('--long-ms', '600000'));
const SITES = [
  { name: 'houston', latDeg: 29.7604, lonDeg: -95.3698, groundM: 15 },
  { name: 'sydney', latDeg: -33.8688, lonDeg: 151.2093, groundM: 50 },
  { name: 'reykjavik', latDeg: 64.1466, lonDeg: -21.9426, groundM: 30 },
];
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (...parts) => {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  log.push(line);
  console.log(line);
};
const failures = [];
const check = (ok, what) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failures.push(what);
};

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 1800000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--font-render-hinting=none',
  ],
});
const errors = [];
const unrelated = [];

const HANDLE = `(async () => {
  const m = await import('/src/skyView/skyView.js');
  return m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;

const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };
// isMobile/hasTouch: Chromium then matches (pointer: coarse). Changing
// isMobile on a live page reloads it, so the phone check gets its own page.
const PHONE = {
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

async function openPage(viewport = DESKTOP) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('pageerror', (e) => errors.push(`page: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const entry = `${r.status()} ${r.url().slice(0, 200)}`;
    if (/\/skyView\/|\/api\/celestrak/.test(r.url())) errors.push(entry);
    else unrelated.push(entry);
  });
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  // waitForFunction, not waitForSelector: the shell re-renders early and a
  // node handle can go stale (DOM.resolveNode "does not belong")
  await page.waitForFunction(() => document.querySelector('.gev-sky-btn'), {
    timeout: 180000,
  });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape');
  // long-task observer for the whole session
  await page.evaluate(() => {
    window.__p5Long = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          window.__p5Long.push({ t: e.startTime, ms: e.duration });
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* not supported */
    }
  });
  return page;
}

async function enter(page, site, view) {
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(
      async (handleSrc, s, v) => {
        const h = await eval(handleSrc);
        if (!h.active || h.observer?.latDeg !== s.latDeg) {
          if (h.active) h.exit();
          await h.enterAt({
            latDeg: s.latDeg,
            lonDeg: s.lonDeg,
            source: 'manual',
            heightM: s.groundM,
            heightKnown: true,
          });
        }
        h.setView(v);
        return { active: h.active, status: h.content.status };
      },
      HANDLE,
      site,
      view,
    );
    if (state.active && state.status === 'ready') return;
    await sleep(2000);
  }
  throw new Error(`sky never ready at ${site.name}`);
}

/** Click a [data-sky] control (real UI click) and let it settle. */
async function press(page, name, wait = 300) {
  await page.click(`[data-sky="${name}"]`);
  await sleep(wait);
}

const skyState = (page) =>
  page.evaluate(async (handleSrc) => {
    const h = await eval(handleSrc);
    const viewer = window.__godsEyeView.viewer;
    const eph = h.content.ephemeris;
    const s = h.satellites.stats;
    return {
      skyMs: h.time.getTime(),
      viewerMs: viewer.clock.currentTime
        ? viewer.clock.currentTime.constructor
            .toDate(viewer.clock.currentTime)
            .getTime()
        : null,
      mode: h.time.mode,
      rate: h.clock.rate,
      ephMs: eph?.ms ?? null,
      sunApparentDeg: eph?.sun?.elDeg ?? null,
      sunAzDeg: eph?.sun?.azDeg ?? null,
      moonDeg: eph?.moon?.elDeg ?? null,
      sats: {
        ticks: s.ticks,
        skipped: s.skipped,
        maxBacklog: s.maxBacklog,
        durationMs: s.durationMs,
        count: s.count,
        timeMs: s.timeMs,
      },
      tickMs: h.satellites.tickMs,
      status: document.querySelector('[data-sky=time-status]')?.textContent,
      banners: [...document.querySelectorAll('[data-banner]')].map((b) =>
        b.getAttribute('data-banner'),
      ),
      picker: document.querySelector('[data-sky=time]')?.value,
      live: document
        .querySelector('[data-sky=live]')
        ?.getAttribute('aria-pressed'),
      redraw: h.redrawPerf(),
      heapMB: performance.memory
        ? performance.memory.usedJSHeapSize / 1048576
        : null,
    };
  }, HANDLE);

const results = { base: BASE, sites: {}, presets: {} };
const page = await openPage();
const startMs = Date.now();

// ── 1. presets + 9 screenshots ────────────────────────────────────────────
for (const site of SITES) {
  await enter(page, site, { azDeg: 270, elDeg: 15, fovDeg: 90, rollDeg: 0 });
  await page.evaluate(
    async (handleSrc, t) => (await eval(handleSrc)).clock.setFixed(t),
    HANDLE,
    startMs,
  );
  await press(page, 'preset-sunset', 800);
  const sunset = await skyState(page);
  check(
    Math.abs(sunset.sunApparentDeg) <= 0.3 && sunset.ephMs === sunset.skyMs,
    `${site.name} Sunset preset: Sun apparent ${sunset.sunApparentDeg?.toFixed(3)} deg (|x| <= 0.3), ephemeris time = Sky time`,
  );
  check(
    Math.abs(sunset.viewerMs - sunset.skyMs) < 1000 && sunset.live === 'false',
    `${site.name} viewer.clock = Sky time; picker ${sunset.picker}; Live released`,
  );
  await press(page, 'preset-dusk', 800);
  const dusk18 = await skyState(page);
  const twilightOk = /does not end/.test(dusk18.status || '');
  const airless = await page.evaluate(
    async (s, t) => {
      const e = await import('/src/skyView/ephemeris.js');
      return e.bodyPosition('Sun', t, {
        latDeg: s.latDeg,
        lonDeg: s.lonDeg,
        heightM: s.groundM + 1.7,
      }).elDeg;
    },
    site,
    dusk18.skyMs,
  );
  check(
    twilightOk || Math.abs(airless + 18) < 0.05,
    `${site.name} Twilight end: Sun airless ${airless.toFixed(3)} deg (status "${dusk18.status}")`,
  );
  const shots = {};
  const times = {
    day: sunset.skyMs - 4 * 3600_000,
    dusk: sunset.skyMs + 25 * 60_000,
    night: twilightOk ? sunset.skyMs + 3 * 3600_000 : dusk18.skyMs + 3600_000,
  };
  for (const [phase, t] of Object.entries(times)) {
    const view =
      phase === 'night'
        ? { azDeg: 180, elDeg: 45, fovDeg: 90, rollDeg: 0 }
        : { azDeg: sunset.sunAzDeg, elDeg: 12, fovDeg: 90, rollDeg: 0 };
    await page.evaluate(
      async (handleSrc, ms, v) => {
        const h = await eval(handleSrc);
        h.clock.setFixed(ms);
        h.setView(v);
      },
      HANDLE,
      t,
      view,
    );
    await sleep(4000); // tiles, worker tick
    const state = await skyState(page);
    const file = path.join(OUT, `${site.name}-${phase}.png`);
    await page.screenshot({ path: file });
    shots[phase] = {
      file,
      skyIso: new Date(state.skyMs).toISOString(),
      sunApparentDeg: state.sunApparentDeg,
      satellitesAbove: state.sats.count,
      banners: state.banners,
    };
    say(site.name, phase, shots[phase]);
  }
  results.sites[site.name] = { sunset, dusk18, airless, shots };
}

// ISS pass preset (Houston)
await enter(page, SITES[0], { azDeg: 200, elDeg: 40, fovDeg: 90, rollDeg: 0 });
await page.evaluate(
  async (handleSrc, t) => (await eval(handleSrc)).clock.setFixed(t),
  HANDLE,
  startMs,
);
await press(page, 'preset-iss', 3000);
results.presets.iss = await skyState(page);
check(
  /^ISS pass: /.test(results.presets.iss.status || '') ||
    /No ISS pass/.test(results.presets.iss.status || ''),
  `ISS pass preset: "${results.presets.iss.status}"`,
);

// ── 2. x3600 for one simulated day via the Play button ────────────────────
async function playRun(label, rate, wallMs, sampleMs) {
  await page.evaluate(
    async (handleSrc, t) => {
      const h = await eval(handleSrc);
      h.clock.setFixed(t);
      h.resetRedrawPerf();
      window.__p5Long.length = 0;
    },
    HANDLE,
    startMs,
  );
  await page.select('[data-sky="rate"]', String(rate));
  const errorsBefore = errors.length;
  const before = await skyState(page);
  await press(page, 'play', 0);
  const samples = [];
  let maxBacklog = 0;
  let worstClockSkewMs = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < wallMs) {
    await sleep(sampleMs);
    const s = await skyState(page);
    maxBacklog = Math.max(maxBacklog, s.sats.maxBacklog);
    // viewer.clock is applied once per play frame (<= 33 ms wall)
    worstClockSkewMs = Math.max(
      worstClockSkewMs,
      Math.abs(s.skyMs - s.viewerMs) / Math.abs(rate),
    );
    samples.push({
      wallMs: Date.now() - t0,
      skyIso: new Date(s.skyMs).toISOString(),
      ticks: s.sats.ticks,
      skipped: s.sats.skipped,
      maxBacklog: s.sats.maxBacklog,
      tickMs: s.tickMs,
      heapMB: s.heapMB,
    });
  }
  await press(page, 'play', 300);
  const after = await skyState(page);
  const long = await page.evaluate(() => window.__p5Long.slice());
  const longMs = long.map((l) => l.ms).sort((a, b) => a - b);
  const run = {
    rate,
    wallMs,
    from: new Date(before.skyMs).toISOString(),
    to: new Date(after.skyMs).toISOString(),
    simulatedHours: (after.skyMs - before.skyMs) / 3600_000,
    modeAfterPause: after.mode,
    ticks: after.sats.ticks - before.sats.ticks,
    skipped: after.sats.skipped - before.sats.skipped,
    maxBacklog,
    worstClockSkewWallMs: worstClockSkewMs,
    tickMs: samples.at(-1)?.tickMs,
    heapStartMB: samples[0]?.heapMB,
    heapEndMB: samples.at(-1)?.heapMB,
    redraw: after.redraw,
    longTasks: {
      count: longMs.length,
      over100: longMs.filter((x) => x > 100).length,
      max: longMs.at(-1) ?? 0,
      p95: longMs[Math.floor(0.95 * longMs.length)] ?? 0,
    },
    newErrors: errors.slice(errorsBefore),
    samples,
  };
  results[label] = run;
  say(label, { ...run, samples: `${samples.length} samples` });
  return run;
}

const day = await playRun('x3600-day', 3600, DAY_WALL_MS, 500);
check(
  day.simulatedHours >= 23.5 * (DAY_WALL_MS / 24000),
  `x3600: ${day.simulatedHours.toFixed(2)} simulated hours in ${DAY_WALL_MS} ms wall`,
);
check(
  day.maxBacklog <= 1,
  `x3600: worker backlog max ${day.maxBacklog} (<= 1 tick)`,
);
check(
  day.newErrors.length === 0,
  `x3600: no console/page errors (${day.newErrors.length})`,
);
check(
  day.ticks > 0,
  `x3600: ${day.ticks} worker ticks answered, ${day.skipped} skipped`,
);
check(day.modeAfterPause === 'fixed', 'Pause button stops the clock');

const long = await playRun('x60-10min', 60, LONG_WALL_MS, 5000);
check(
  long.maxBacklog <= 1,
  `x60 10 min: worker backlog max ${long.maxBacklog}`,
);
check(
  long.newErrors.length === 0,
  `x60 10 min: no console/page errors (${long.newErrors.length})`,
);
check(
  Math.abs(long.simulatedHours - LONG_WALL_MS / 60_000) < 0.2,
  `x60 10 min: ${long.simulatedHours.toFixed(2)} simulated hours`,
);
if (long.heapStartMB != null)
  check(
    long.heapEndMB - long.heapStartMB < 30,
    `x60 10 min: heap ${long.heapStartMB.toFixed(1)} -> ${long.heapEndMB.toFixed(1)} MB (< +30)`,
  );

// desktop: the Layers/search tools hang below the (taller) toolbar
results.desktopLayout = await page.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  return {
    barBottom: r('.gev-sky-bar')?.bottom,
    toolsTop: r('.gev-sky-tools')?.top,
  };
});
check(
  results.desktopLayout.toolsTop >= results.desktopLayout.barBottom,
  `desktop: tools top ${results.desktopLayout.toolsTop} below toolbar bottom ${results.desktopLayout.barBottom}`,
);

// ── 4. phone width: time rows wrap, tools hang below the toolbar, 44 px ──
const phonePage = await openPage(PHONE);
await enter(phonePage, SITES[2], {
  azDeg: 180,
  elDeg: 45,
  fovDeg: 90,
  rollDeg: 0,
});
await phonePage.evaluate(
  async (handleSrc, t) => (await eval(handleSrc)).clock.setFixed(t),
  HANDLE,
  results.sites.reykjavik.shots.night
    ? Date.parse(results.sites.reykjavik.shots.night.skyIso)
    : startMs,
);
await sleep(4000);
await phonePage.screenshot({
  path: path.join(OUT, 'reykjavik-night-phone.png'),
});
const foldedBottom = await phonePage.evaluate(
  () => document.querySelector('.gev-sky-bar').getBoundingClientRect().bottom,
);
await phonePage.click('[data-sky="time-fold"]');
await sleep(1500);
await phonePage.screenshot({
  path: path.join(OUT, 'reykjavik-night-phone-time-open.png'),
});
results.layout = await phonePage.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  const bar = r('.gev-sky-bar');
  const tools = r('.gev-sky-tools');
  const small = [
    ...document.querySelectorAll(
      '.gev-sky-bar button, .gev-sky-bar select, .gev-sky-bar input',
    ),
  ]
    .filter((n) => n.offsetParent)
    .map((n) => n.getBoundingClientRect())
    .filter((b) => b.height < 44 || b.width < 44).length;
  return {
    timeOpen:
      document
        .querySelector('[data-sky=time-fold]')
        ?.getAttribute('aria-expanded') === 'true',
    coarse: matchMedia('(pointer: coarse)').matches,
    barBottom: bar?.bottom,
    toolsTop: tools?.top,
    controlsUnder44px: small,
  };
});
results.layout.foldedBarBottom = foldedBottom;
check(results.layout.coarse, 'phone profile matches (pointer: coarse)');
check(
  results.layout.timeOpen,
  `phone: time rows fold (toolbar bottom folded ${foldedBottom}, open ${results.layout.barBottom})`,
);
check(
  results.layout.toolsTop >= results.layout.barBottom,
  `phone: tools top ${results.layout.toolsTop} below toolbar bottom ${results.layout.barBottom}`,
);
check(
  results.layout.controlsUnder44px === 0,
  `phone (coarse pointer): ${results.layout.controlsUnder44px} toolbar controls under 44 px`,
);
await phonePage.close();

results.errors = errors;
results.unrelatedHttp = [...new Set(unrelated)];
results.failures = failures;
writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, 'qa-log.txt'), log.join('\n') + '\n');
await browser.close();
say(
  failures.length
    ? `QA sky time FAIL (${failures.length})`
    : 'QA sky time PASS',
);
process.exit(failures.length ? 1 : 0);
