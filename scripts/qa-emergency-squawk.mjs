#!/usr/bin/env node
/**
 * qa-emergency-squawk.mjs — headless proof for transponder emergency highlighting.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * `/api/flights` and `/api/military` are stubbed in the page so the codes
 * are deterministic; everything downstream (normalizers, records, rendering,
 * Cockpit HUD) is production code.
 *
 *   (i)   TINT — a civil 7600 and a military ADS-B `general` emergency are
 *         drawn red; a normal civil flight stays white, a normal military
 *         flight stays amber, and a military `minfuel` priority stays amber.
 *         POLL/MODELS verify existing untracked billboards and 3D models
 *         repaint when emergency status starts and clears.
 *   (ii)  HUD — tracking the military emergency and entering Cockpit names
 *         the broadcast code on the aircraft-meta line, in red.
 *   (iii) CLEAR — the next poll drops the code: the HUD line returns to its
 *         normal wording (the status is not sticky).
 *   (iv)  RELEASE — the code returns and tracking stops: the restored fleet
 *         billboard is red, not the plain military amber.
 *
 * Screenshots saved to qa-shots/emergency-*.png (gitignored).
 *
 * Run:  node scripts/qa-emergency-squawk.mjs --url http://localhost:4173
 * Optional: --timeout-ms 180000 for a slow boot.
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const TIMEOUT_MS = Number(getOpt('--timeout-ms', '60000'));
const CENTER = { lon: 4.0, lat: 53.5 };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OpenSky state vector: squawk sits at index 14. */
const civilRow = (icao24, callsign, lon, lat, squawk) => [
  icao24,
  callsign,
  'Netherlands',
  null,
  null,
  lon,
  lat,
  10000,
  false,
  230,
  90,
  0,
  null,
  10050,
  squawk,
  false,
  0,
];

/** readsb row as adsb.lol /v2/mil returns it. */
const milRow = (hex, flight, lon, lat, squawk, emergency) => ({
  hex,
  flight,
  lon,
  lat,
  alt_baro: 24000,
  alt_geom: 24200,
  gs: 380,
  track: 270,
  t: 'C17',
  r: `QA-${hex}`,
  squawk,
  emergency,
  seen: 1,
  seen_pos: 1,
});

/** Page-side route stubs; `__squawkQaPhase` switches the military emergency off. */
function installStubs() {
  const realFetch = window.fetch.bind(window);
  window.__squawkQaPhase = 'emergency';
  const json = (body) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const now = Date.now();
    const { civil, mil } = window.__squawkQaFixtures;
    if (
      url.includes('/api/flights/track') ||
      url.includes('/api/military/track')
    )
      return json({ path: [] });
    if (url.includes('/api/flights')) {
      const t = Math.floor(now / 1000);
      return json({
        time: t,
        states: civil.map((row) => {
          const copy = [...row];
          copy[3] = t - 1;
          copy[4] = t - 1;
          return copy;
        }),
      });
    }
    if (url.includes('/api/military')) {
      const cleared = window.__squawkQaPhase === 'cleared';
      return json({
        msg: 'No error',
        now,
        ac: mil.map((row) =>
          cleared && row.hex === 'ae7700'
            ? { ...row, squawk: '4521', emergency: 'none' }
            : row,
        ),
      });
    }
    return realFetch(input, init);
  };
}

/** Colour of every shown fleet billboard whose id is one of `ids`. */
function billboardColors(ids) {
  const { viewer } = window.__godsEyeView;
  const found = {};
  const seen = new Set();
  const visit = (primitive) => {
    if (!primitive || seen.has(primitive)) return;
    seen.add(primitive);
    if (
      typeof primitive.length !== 'number' ||
      typeof primitive.get !== 'function'
    )
      return;
    for (let i = 0; i < primitive.length; i++) {
      const item = primitive.get(i);
      if (item?.color && ids.includes(item.id) && item.show !== false) {
        found[item.id] = {
          r: Math.round(item.color.red * 255),
          g: Math.round(item.color.green * 255),
          b: Math.round(item.color.blue * 255),
        };
      } else visit(item);
    }
  };
  visit(viewer.scene.primitives);
  return found;
}

const isRed = (c) => Boolean(c) && c.r > 200 && c.g < 110 && c.b < 110;
const isWhite = (c) => Boolean(c) && c.r > 220 && c.g > 220 && c.b > 220;
const isAmber = (c) =>
  Boolean(c) && c.r > 180 && c.g > 110 && c.b < 140 && !isRed(c);

async function shoot(page, name) {
  await page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      { timeout: 30000 },
    )
    .catch(() => {});
  await sleep(600);
  await page.screenshot({
    path: path.join(SHOTS_DIR, `emergency-${name}.png`),
  });
}

async function main() {
  console.log('\nEmergency squawk proof (qa-emergency-squawk)');
  console.log(`  App URL : ${APP_URL}\n`);
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(
      `\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`,
    );
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (await puppeteer.executablePath().catch(() => null)) ||
    undefined;
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    protocolTimeout: 180000,
    ...(executablePath && fs.existsSync(executablePath)
      ? { executablePath }
      : {}),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });

  let exitCode = 0;
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    const { lon, lat } = CENTER;
    await page.evaluateOnNewDocument(
      (fixtures) => {
        window.__squawkQaFixtures = fixtures;
      },
      {
        civil: [
          civilRow('4847a1', 'KLM7600 ', lon - 0.6, lat + 0.25, '7600'),
          civilRow('4847a2', 'KLM1234 ', lon - 0.6, lat - 0.25, '2000'),
        ],
        mil: [
          milRow('ae7700', 'RCH7700', lon + 0.6, lat + 0.25, '1200', 'general'),
          milRow('ae0f01', 'RCH0F01', lon + 0.6, lat - 0.25, '1234', 'minfuel'),
          milRow('ae0001', 'RCH0001', lon, lat - 0.5, '4520', 'none'),
        ],
      },
    );
    // Stub in-page rather than with request interception: an intercepted page
    // stalls Cesium's workers (see qa-gnss.mjs).
    await page.evaluateOnNewDocument(installStubs);
    await page.goto(`${APP_URL}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: TIMEOUT_MS },
    );
    await sleep(5000);
    await page.keyboard.press('Escape');
    await page.evaluate(
      (lo, la) => {
        const gev = window.__godsEyeView;
        const d2r = Math.PI / 180;
        try {
          gev.viewer.camera.cancelFlight();
        } catch {
          /* no flight active */
        }
        gev.viewer.camera.setView({
          destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian(
            {
              longitude: lo * d2r,
              latitude: la * d2r,
              height: 260000,
            },
          ),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        gev.viewer.scene.requestRender?.();
      },
      lon,
      lat,
    );

    // ── (i) TINT ──────────────────────────────────────────────────────────
    console.log('(i) TINT — emergency codes through the real layers...');
    await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('flights', true, { origin: 'user' });
      await dm.setEnabled('military', true, { origin: 'user' });
    });
    const ids = ['4847a1', '4847a2', 'ae7700', 'ae0f01', 'ae0001'];
    const probe = `(${billboardColors})(${JSON.stringify(ids)})`;
    await page
      .waitForFunction(`Object.keys(${probe}).length === ${ids.length}`, {
        timeout: TIMEOUT_MS,
        polling: 500,
      })
      .catch(() => {});
    await sleep(1500);
    const colors = await page.evaluate(probe);
    const show = (id) => JSON.stringify(colors[id] ?? null);
    record(
      'TINT: civil squawk 7600 is red',
      isRed(colors['4847a1']),
      show('4847a1'),
    );
    record(
      'TINT: normal civil flight stays white',
      isWhite(colors['4847a2']),
      show('4847a2'),
    );
    record(
      'TINT: military ADS-B general emergency is red',
      isRed(colors.ae7700),
      show('ae7700'),
    );
    record(
      'TINT: military minimum-fuel priority stays amber',
      isAmber(colors.ae0f01),
      show('ae0f01'),
    );
    record(
      'TINT: normal military flight stays amber',
      isAmber(colors.ae0001),
      show('ae0001'),
    );
    await shoot(page, 'globe-tint');

    // Existing untracked billboards and models must repaint in both directions.
    await page.evaluate(async () => {
      window.__squawkQaPhase = 'cleared';
      await window.__godsEyeView.dataManager.refreshLayer('military');
    });
    record(
      'POLL: existing military billboard clears to amber',
      isAmber((await page.evaluate(probe)).ae7700),
    );
    await page.evaluate(async () => {
      window.__squawkQaPhase = 'emergency';
      await window.__godsEyeView.dataManager.refreshLayer('military');
    });
    record(
      'POLL: existing military billboard turns red again',
      isRed((await page.evaluate(probe)).ae7700),
    );
    const modelProbe = () => {
      const found = {};
      const visit = (items) => {
        for (let i = 0; i < items.length; i++) {
          const item = items.get(i);
          if (item.ready && item.color && typeof item.id === 'string')
            found[item.id] = {
              r: Math.round(item.color.red * 255),
              g: Math.round(item.color.green * 255),
              b: Math.round(item.color.blue * 255),
            };
          else if (item.get) visit(item);
        }
      };
      visit(window.__godsEyeView.viewer.scene.primitives);
      return found;
    };
    await page.waitForFunction(
      `(${modelProbe})()['4847a1'] && (${modelProbe})().ae7700`,
      { timeout: TIMEOUT_MS, polling: 250 },
    );
    const beforeModels = await page.evaluate(modelProbe);
    record(
      'MODELS: civil and military emergency models are red',
      isRed(beforeModels['4847a1']) && isRed(beforeModels.ae7700),
      JSON.stringify(beforeModels),
    );
    await page.evaluate(async () => {
      window.__squawkQaFixtures.civil[0][14] = '2000';
      window.__squawkQaFixtures.civil[1][14] = '7600';
      window.__squawkQaPhase = 'cleared';
      const dm = window.__godsEyeView.dataManager;
      await dm.refreshLayer('flights');
      await dm.refreshLayer('military');
    });
    await page.waitForFunction(
      `(${modelProbe})()['4847a1']?.g > 220 && (${modelProbe})()['4847a2']?.g < 110 && (${modelProbe})().ae7700?.g > 110`,
      { timeout: TIMEOUT_MS, polling: 250 },
    );
    const afterModels = await page.evaluate(modelProbe);
    record(
      'MODELS: existing civil models start and clear, military clears',
      isWhite(afterModels['4847a1']) &&
        isRed(afterModels['4847a2']) &&
        isAmber(afterModels.ae7700),
      JSON.stringify(afterModels),
    );
    await page.evaluate(async () => {
      window.__squawkQaFixtures.civil[0][14] = '7600';
      window.__squawkQaFixtures.civil[1][14] = '2000';
      window.__squawkQaFixtures.mil[0].squawk = '7700';
      window.__squawkQaPhase = 'emergency';
      const dm = window.__godsEyeView.dataManager;
      await dm.refreshLayer('flights');
      await dm.refreshLayer('military');
    });
    // ── (ii) HUD ──────────────────────────────────────────────────────────
    console.log('\n(ii) HUD — track the emergency and enter Cockpit...');
    const tracked = await page.evaluate(() =>
      Boolean(
        window.__godsEyeView.dataManager.layers
          .get('military')
          .module.trackById('ae7700', { origin: 'user' }),
      ),
    );
    record(
      'HUD: emergency aircraft can be tracked',
      tracked,
      `tracked=${tracked}`,
    );
    // Cockpit entry is gated on the Contacts (flights) context mode.
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._contextControls._selectContextMode(
        'flights',
      ),
    );
    await page
      .waitForFunction(
        () => {
          const entry = document.getElementById('cockpit-entry');
          return entry && !entry.hidden && !entry.disabled;
        },
        { timeout: 20000 },
      )
      .catch(() => {});
    await page
      .$eval('#cockpit-entry', (entry) => entry.click())
      .catch(() => {});
    const hudReady = await page
      .waitForFunction(
        () =>
          document.body.classList.contains('cockpit-mode') &&
          /SQUAWK 7700/.test(
            document.getElementById('cockpit-aircraft-meta')?.textContent || '',
          ),
        { timeout: 30000 },
      )
      .then(
        () => true,
        () => false,
      );
    const hud = await page.evaluate(() => {
      const meta = document.getElementById('cockpit-aircraft-meta');
      return {
        cockpit: document.body.classList.contains('cockpit-mode'),
        text: meta?.textContent || '',
        emergencyClass: meta?.classList.contains('emergency') || false,
        color: meta ? getComputedStyle(meta).color : null,
      };
    });
    record(
      'HUD: meta line names the broadcast code',
      hudReady && hud.text.includes('SQUAWK 7700 · GENERAL EMERGENCY'),
      JSON.stringify(hud),
    );
    record(
      'HUD: meta line is styled as an emergency',
      hud.emergencyClass && /255,\s*68,\s*68/.test(hud.color || ''),
      `class=${hud.emergencyClass} color=${hud.color}`,
    );
    const trackedBroadcast = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('military')
          .module.getTrackedInfo().emergencyBroadcast,
    );
    record(
      'TRACKED: voice-facing status quotes the broadcast',
      trackedBroadcast === 'broadcasting squawk 7700 (general emergency)',
      trackedBroadcast,
    );
    await shoot(page, 'cockpit-hud');

    // ── (iii) CLEAR ───────────────────────────────────────────────────────
    console.log('\n(iii) CLEAR — the next poll drops the code...');
    await page.evaluate(async () => {
      window.__squawkQaPhase = 'cleared';
      await window.__godsEyeView.dataManager.refreshLayer('military');
    });
    const cleared = await page
      .waitForFunction(
        () =>
          !document
            .getElementById('cockpit-aircraft-meta')
            ?.classList.contains('emergency'),
        { timeout: 20000 },
      )
      .then(
        () => true,
        () => false,
      );
    const after = await page.evaluate(
      () => document.getElementById('cockpit-aircraft-meta')?.textContent || '',
    );
    record(
      'CLEAR: HUD returns to its normal wording',
      cleared && !after.includes('SQUAWK') && after.includes('COURSE ALIGNED'),
      JSON.stringify(after),
    );
    await shoot(page, 'cockpit-cleared');

    // ── (iv) RELEASE ──────────────────────────────────────────────────────
    console.log('\n(iv) RELEASE — the code returns, then tracking stops...');
    await page.evaluate(async () => {
      window.__squawkQaPhase = 'emergency';
      const dm = window.__godsEyeView.dataManager;
      await dm.refreshLayer('military');
      dm.layers.get('military').module.stopTracking({ origin: 'user' });
    });
    const releaseProbe = `(${billboardColors})(["ae7700"])`;
    const released = await page
      .waitForFunction(`Boolean((${releaseProbe}).ae7700)`, {
        timeout: 20000,
        polling: 250,
      })
      .then(
        () => true,
        () => false,
      );
    const releasedColor = (await page.evaluate(releaseProbe)).ae7700;
    record(
      'RELEASE: untracked emergency billboard is red',
      released && isRed(releasedColor),
      JSON.stringify(releasedColor ?? null),
    );
    record(
      'no uncaught browser errors',
      errors.length === 0,
      errors.slice(0, 3).join(' | '),
    );
  } catch (err) {
    console.error('\x1b[31mHarness error:\x1b[0m', err);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`  Shots : ${SHOTS_DIR}/emergency-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
