/**
 * Headless-Chromium proof for Sky view "Point at the sky".
 * Drives the REAL mounted app with Chrome's virtual sensors (CDP
 * Emulation.setSensorOverrideReadings, type absolute-orientation) on an
 * emulated phone (touch, 412x915, DPR 2.625), and records:
 *   A. the button is offered on a touch device; tap -> state on (source)
 *   B. phone pointed at the Moon's MAGNETIC azimuth -> view centre on the
 *      Moon's TRUE position (declination applied), screenshot with the
 *      centre circle on the drawn Moon
 *   C. landscape (screen angle 90) same pose -> same az/el, roll 0
 *   D. smoothing: a 90 deg turn settles within 1 s without overshoot
 *   E. battery: still phone -> no view changes; moving -> <= 30 per second
 *   F. a drag takes over (state off, roll 0, camera moves)
 *   G. sensors denied (Browser.setPermission) -> "denied" message, drag works
 *   H. insecure http host (not localhost) -> "insecure" message with https URL
 * Clear view (clearView.js):
 *   I. pointing on a touch phone enters Clear view with the one-off hint;
 *      only the sky canvases, centre circle, eye and message line are
 *      visible (computed style), every tap point hits the sky, the overlay
 *      fills the screen, and the Moon is still centred (miss <= 0.1 deg)
 *   J. landscape: still clear; double-tap brings the controls back and
 *      clears again; the view does not move
 *   K. eye, H (the app's H = HUD does not fire), Escape and double-tap
 *      toggle it with the view unchanged; holding H down (real autorepeat
 *      keydowns) toggles it once and never toggles the HUD;
 *      the eye fades after 3 s and a touch wakes it
 *   L. denied and insecure messages stay visible over the clear sky
 * Attribution in Clear view (): while map
 *   tiles are drawn the app's credit line (#cesium-credits) stays painted in
 *   full: dim, bottom-left (the app's credit placement), wrapping inside the
 *   corner with no credit clipped, cut off or off screen, tap-through, clear
 *   of the centre circle and the eye; its "Data attribution" link still opens
 *   the full credit list over the clear sky; the flat horizon (no tiles)
 *   hides it; the Moon stays centred.
 * This is the synthetic part only; real phones need a manual pass.
 *   node scripts/qa-sky-phone.mjs --url http://127.0.0.1:4338 --out <dir>
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { moonState } from '../src/skyView/ephemeris.js';
import { declinationDeg } from '../src/skyView/declination.js';
import { cameraBasis } from '../src/skyView/skyMath.js';
import { quatFromAxes, wrap180 } from '../src/skyView/orientationMath.js';
import { doubleTapWithRetry } from '../src/skyView/qaDoubleTap.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4338');
const OUT = path.resolve(arg('--out', 'qa-sky-phone'));
const SETTLE_MS = Number(arg('--settle-ms', '15000'));
// H needs a plain-http, non-loopback origin (not a secure context). Vite only
// accepts IP or localhost Host headers, so a short-lived TCP proxy on the
// host's LAN address forwards to the dev server for that one check.
const LAN_IP = arg(
  '--lan-ip',
  Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address ??
    '127.0.0.1',
);
const LAN_PORT = Number(arg('--lan-port', '4339'));
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
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  say(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};

// ── a fixed time when the Moon is up over Houston ──────────────────────────
// Pinned: the old search started at Date.now(), so every run saw
// a different Moon pose and the result depended on the time of day. Default:
// the first whole hour from a fixed start (2026-11-01T00:00Z) with the Moon at
// 25-55 deg. Override with --sky-time <ISO> to probe another pose.
const OBS = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
const FIXED_START = Date.UTC(2026, 10, 1, 0, 0, 0);
let skyTime = null;
const skyTimeArg = arg('--sky-time', null);
if (skyTimeArg) {
  skyTime = Date.parse(skyTimeArg);
  if (!Number.isFinite(skyTime)) throw new Error('bad --sky-time');
} else {
  for (let h = 0; h < 24 * 20 && skyTime == null; h += 1) {
    const t = FIXED_START + h * 3_600_000;
    const m = moonState(t, OBS, { refraction: true });
    if (m.elDeg > 25 && m.elDeg < 55) skyTime = t;
  }
}
const moon = moonState(skyTime, OBS, { refraction: true });
const decl = declinationDeg(OBS.latDeg, OBS.lonDeg, skyTime);
say(
  'sky time',
  new Date(skyTime).toISOString(),
  'moon',
  {
    az: moon.azDeg,
    el: moon.elDeg,
  },
  'declination',
  decl,
);

/** Virtual-sensor quaternion for the back of the phone at az/el (screen angle). */
function pose(azDeg, elDeg, screenAngle = 0, rollDeg = 0) {
  const { forward, right, up } = cameraBasis({
    azDeg,
    elDeg,
    rollDeg,
    fovDeg: 60,
  });
  const t = (screenAngle * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // device axes from screen axes (inverse of orientationMath.screenBasis)
  const x = right.map((r, i) => c * r + s * up[i]);
  const y = right.map((r, i) => -s * r + c * up[i]);
  const z = forward.map((f) => -f);
  const [qx, qy, qz, qw] = quatFromAxes(x, y, z);
  return { x: qx, y: qy, z: qz, w: qw };
}

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
const PHONE = {
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

async function openSky(base, { sensors = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport(PHONE);
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  const cdp = await page.createCDPSession();
  if (sensors)
    await cdp.send('Emulation.setSensorOverrideEnabled', {
      enabled: true,
      type: 'absolute-orientation',
    });
  const iso = new Date(skyTime).toISOString().replace(/\.\d+Z$/, 'Z');
  await page.goto(`${base}/?sv=${OBS.latDeg},${OBS.lonDeg},180,30,70,${iso}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await sleep(SETTLE_MS);
  await page.keyboard.press('Escape'); // the first-launch chooser
  await sleep(500);
  return { page, cdp };
}

const HANDLE = `(async () => {
  const m = await import('/src/skyView/skyView.js');
  return m.skyViewFor(window.__godsEyeView.viewer) ||
    m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;
const handleEval = (page, fn, arg) =>
  page.evaluate(
    async (src, fnSrc, a) => {
      const h = await eval(src);
      return eval(fnSrc)(h, a);
    },
    HANDLE,
    fn.toString(),
    arg,
  );

/** What is painted (computed style) and what a tap hits, for Clear view. */
function clearAudit() {
  const vw = innerWidth;
  const vh = innerHeight;
  const tiles = document.body.classList.contains('gev-sky-tiles');
  const ALLOWED =
    '.cesium-widget > canvas, .gev-sky-canvas, .gev-sky-crosshair, .gev-sky-clear-btn, .gev-sky-clear-btn *, .gev-sky-clear-note, .gev-sky-clear-note *' +
    (tiles ? ', #cesium-credits, #cesium-credits *' : '');
  const sky = document.querySelector('.gev-sky-canvas');
  const globe = document.querySelector('.cesium-widget > canvas');
  const name = (el) => {
    if (el.id) return `#${el.id}`;
    const ds = el.getAttribute('data-sky');
    if (ds) return `[data-sky=${ds}]`;
    const cls = [...el.classList].slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const shown = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    if (Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    shown.push(el);
  }
  const set = new Set(shown);
  const outer = shown.filter(
    (el) =>
      !set.has(el.parentElement) && !el.contains(sky) && !el.contains(globe),
  );
  const hits = {};
  for (let y = 5; y < vh; y += 20)
    for (let x = 5; x < vw; x += 20) {
      const e = document.elementFromPoint(x, y);
      const k = e === sky ? 'sky' : e ? name(e) : 'none';
      hits[k] = (hits[k] || 0) + 1;
    }
  const r = sky.getBoundingClientRect();
  const eye = document.querySelector('[data-sky=clear]');
  const box = (el) => {
    const q = el?.getBoundingClientRect();
    return q ? [q.left, q.top, q.right, q.bottom].map(Math.round) : null;
  };
  const overlaps = (a, b) =>
    Boolean(a && b) && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const credits = document.getElementById('cesium-credits');
  const creditInfo = credits
    ? (() => {
        const cs = getComputedStyle(credits);
        const painted = [...credits.querySelectorAll('*')].filter((e) => {
          const c = getComputedStyle(e);
          const q = e.getBoundingClientRect();
          return (
            c.visibility === 'visible' &&
            c.display !== 'none' &&
            q.width >= 1 &&
            q.height >= 1 &&
            q.left < vw &&
            q.right > 0
          );
        });
        // #cesium-credits is a 0x0 fixed box; the line is Cesium's
        // absolutely placed .cesium-widget-credits inside it
        const line = credits.querySelector('.cesium-widget-credits') ?? credits;
        const rect = box(line);
        const lineStyle = getComputedStyle(line);
        const crosshair = document.querySelector('.gev-sky-crosshair');
        return {
          visible: cs.visibility === 'visible',
          painted: painted.length,
          text: (credits.textContent || '').trim().slice(0, 120),
          logos: credits.querySelectorAll('img').length,
          opacity: Number(cs.opacity),
          // dim like normal mode: text colour alpha < 1, never faded out
          colorAlpha: (() => {
            const m = cs.color.match(/rgba?\(([^)]*)\)/);
            const parts = m ? m[1].split(/[ ,/]+/).filter(Boolean) : [];
            return parts.length === 4 ? Number(parts[3]) : 1;
          })(),
          pointerEvents: cs.pointerEvents,
          // tap-through except the "Data attribution" link (the full list)
          childPointer: painted.every(
            (e) =>
              getComputedStyle(e).pointerEvents === 'none' ||
              e.matches('.cesium-credit-expand-link'),
          ),
          // completeness (review R1): every painted credit element is fully
          // on screen and not clipped by its own box or by any box between
          // it and #cesium-credits (overflow), and nothing is ellipsised
          clipped: [...credits.querySelectorAll('*')]
            .filter((e) => {
              const c = getComputedStyle(e);
              const q = e.getBoundingClientRect();
              return (
                c.visibility === 'visible' &&
                c.display !== 'none' &&
                q.width >= 1 &&
                q.height >= 1
              );
            })
            .filter((e) => {
              const q = e.getBoundingClientRect();
              if (
                q.left < -1 ||
                q.top < -1 ||
                q.right > vw + 1 ||
                q.bottom > vh + 1
              )
                return true;
              const own = getComputedStyle(e);
              if (
                own.textOverflow === 'ellipsis' &&
                own.overflowX !== 'visible'
              )
                return true;
              if (
                own.overflowX !== 'visible' &&
                e.scrollWidth > e.clientWidth + 1
              )
                return true;
              if (
                own.overflowY !== 'visible' &&
                e.scrollHeight > e.clientHeight + 1
              )
                return true;
              for (let a = e.parentElement; a; a = a.parentElement) {
                const ac = getComputedStyle(a);
                if (ac.overflowX !== 'visible' || ac.overflowY !== 'visible') {
                  const b = a.getBoundingClientRect();
                  if (
                    q.left < b.left - 1 ||
                    q.top < b.top - 1 ||
                    q.right > b.right + 1 ||
                    q.bottom > b.bottom + 1
                  )
                    return true;
                }
                if (a === credits) break;
              }
              return false;
            })
            .map(
              (e) =>
                `${e.tagName}.${String(e.className).slice(0, 40)}:${(e.textContent || '').trim().slice(0, 40)}`,
            ),
          fullText: (credits.textContent || '').replace(/\s+/g, ' ').trim(),
          expand: (() => {
            const e = credits.querySelector('.cesium-credit-expand-link');
            if (!e || getComputedStyle(e).display === 'none') return null;
            const q = e.getBoundingClientRect();
            const cx = (q.left + q.right) / 2;
            const cy = (q.top + q.bottom) / 2;
            const hit = document.elementFromPoint(cx, cy);
            return {
              point: [Math.round(cx), Math.round(cy)],
              pointer: getComputedStyle(e).pointerEvents,
              visible: getComputedStyle(e).visibility === 'visible',
              onTop: Boolean(hit) && (hit === e || e.contains(hit)),
            };
          })(),
          rect,
          inside:
            Boolean(rect) &&
            rect[0] >= 0 &&
            rect[1] >= 0 &&
            rect[2] <= vw &&
            rect[3] <= vh,
          size: rect ? [rect[2] - rect[0], rect[3] - rect[1]] : null,
          lineVisible: lineStyle.visibility === 'visible',
          overCircle:
            crosshair && !crosshair.hidden
              ? overlaps(rect, box(crosshair))
              : false,
          overEye: eye && !eye.hidden ? overlaps(rect, box(eye)) : false,
        };
      })()
    : null;
  return {
    tiles,
    credits: creditInfo,
    clear: document.body.classList.contains('gev-sky-clear'),
    outer: [...new Set(outer.map(name))],
    notAllowed: [
      ...new Set(shown.filter((el) => !el.matches(ALLOWED)).map(name)),
    ],
    hits,
    skyRect: [r.left, r.top, r.width, r.height],
    viewport: [vw, vh],
    note: document.querySelector('[data-sky=clear-note]')?.hidden
      ? ''
      : document.querySelector('[data-sky=clear-text]')?.textContent,
    eyeOpacity: eye ? Number(getComputedStyle(eye).opacity) : null,
    hud: document.getElementById('intel-hud')?.className ?? null,
  };
}
const audit = (page) => page.evaluate(clearAudit);
// The "Data attribution" link (credits shown only while tiles are drawn) is
// the one tappable part of the credits: it opens the full credit list
// (review R1). It may take a tap point, never more than 1 % of
// them; the rest of the credit text is tap-through.
const LINK_HIT = 'a.cesium-credit-expand-link';
const onlySky = (a) => {
  const total = Object.values(a.hits).reduce((n, v) => n + v, 0);
  return (
    a.clear &&
    a.notAllowed.length === 0 &&
    Object.keys(a.hits).every(
      (k) =>
        /^(sky|\[data-sky=clear\]|span\.gev-sky-clear-icon)$/.test(k) ||
        (k === LINK_HIT && a.tiles && a.hits[k] <= total / 100),
    ) &&
    a.skyRect[0] === 0 &&
    a.skyRect[1] === 0 &&
    a.skyRect[2] === a.viewport[0] &&
    a.skyRect[3] === a.viewport[1]
  );
};
/** Clear view keeps the complete attribution while tiles are drawn. */
const attributionOk = (a) =>
  a.tiles &&
  a.credits?.visible &&
  a.credits.painted > 0 &&
  a.credits.lineVisible &&
  a.credits.size[0] >= 20 &&
  a.credits.size[1] >= 6 &&
  (a.credits.text.length > 0 || a.credits.logos > 0) &&
  a.credits.opacity === 1 &&
  a.credits.colorAlpha < 1 &&
  a.credits.pointerEvents === 'none' &&
  a.credits.childPointer &&
  a.credits.inside &&
  a.credits.clipped.length === 0 &&
  (a.credits.expand == null ||
    (a.credits.expand.visible &&
      a.credits.expand.pointer === 'auto' &&
      a.credits.expand.onTop)) &&
  !a.credits.overCircle &&
  !a.credits.overEye &&
  a.credits.rect[0] < a.viewport[0] / 2 &&
  a.credits.rect[3] > a.viewport[1] / 2;
/** A point where a tap reaches the sky canvas (nearest the screen centre). */
const skyPoint = (page) =>
  page.evaluate(() => {
    const sky = document.querySelector('.gev-sky-canvas');
    let best = null;
    for (let y = 30; y < innerHeight - 30; y += 15)
      for (let x = 30; x < innerWidth - 30; x += 15) {
        const ok = [
          [0, 0],
          [-12, -12],
          [12, 12],
          [-12, 12],
          [12, -12],
        ].every(
          ([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === sky,
        );
        if (!ok) continue;
        const d = Math.hypot(x - innerWidth / 2, y - innerHeight / 2 + 60);
        if (!best || d < best.d) best = { x, y, d };
      }
    return best;
  });
/** Two quick taps; returns what each pointerup hit (diagnostics). */
async function doubleTap(page, x, y) {
  await page.evaluate(() => {
    globalThis.__gevQaTaps = [];
    globalThis.__gevQaTapRec ??= (e) => {
      const t = e.target;
      globalThis.__gevQaTaps?.push({
        type: e.type,
        t: Math.round(e.timeStamp),
        target:
          t?.getAttribute?.('data-sky') || t?.id || t?.className || t?.tagName,
      });
    };
    for (const type of ['pointerdown', 'pointerup'])
      document.addEventListener(type, globalThis.__gevQaTapRec, true);
  });
  await page.touchscreen.tap(x, y);
  await sleep(60);
  await page.touchscreen.tap(x, y);
  await sleep(400);
  return page.evaluate(() => globalThis.__gevQaTaps);
}
const clearOn = (page) =>
  page.evaluate(() => document.body.classList.contains('gev-sky-clear'));

async function ensureEntered(page) {
  for (let i = 0; i < 60; i += 1) {
    const s = await handleEval(page, (h) => ({
      active: h.active,
      mode: h.clock.mode,
    }));
    if (s.active) {
      // fold the satellite list so the sky (and the drag area) is clear
      await page.evaluate(() => {
        const fold = document.querySelector('[data-sky=sats-fold]');
        if (fold?.getAttribute('aria-expanded') !== 'false') fold?.click();
      });
      return s;
    }
    await handleEval(page, (h, o) => h.enterAt({ ...o, source: 'manual' }), {
      latDeg: OBS.latDeg,
      lonDeg: OBS.lonDeg,
      heightM: 15,
      heightKnown: true,
    });
    await sleep(2000);
  }
  throw new Error('sky never entered');
}

/**
 * Roll tolerance for the landscape check. Chromium quantises the
 * emulated absolute-orientation quaternion (about 4e-4 per component, ~0.05
 * deg; probed: sent 0.1234568 got 0.1235998), which shows up as up to ~0.15
 * deg of roll at Moon elevation ~53. The app maths itself is exact
 * (viewFromQuaternion gives roll 0 for el 10-80 and screen angles 0/90/270),
 * so 0.1 deg was tighter than the test channel. 0.3 deg still catches a real
 * roll error (a wrong screen basis gives 90 deg).
 */
const LANDSCAPE_ROLL_TOL_DEG = 0.3;

const readSensor = (cdp, q) =>
  cdp.send('Emulation.setSensorOverrideReadings', {
    type: 'absolute-orientation',
    reading: { quaternion: q },
  });

/** Sample h.view on every animation frame for ms (Cesium loop paused). */
async function sampleViews(page, ms, during) {
  await page.evaluate(
    async (src, ms) => {
      const h = await eval(src);
      window.__godsEyeView.viewer.useDefaultRenderLoop = false;
      window.__p4 = [];
      const t0 = performance.now();
      const step = () => {
        const v = h.view;
        window.__p4.push([v.azDeg, v.elDeg, v.rollDeg, performance.now() - t0]);
        if (performance.now() - t0 < ms) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    HANDLE,
    ms,
  );
  if (during) await during();
  await sleep(ms + 300);
  return page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = true;
    return window.__p4;
  });
}

// ── A-F: sensors allowed ───────────────────────────────────────────────────
let hiddenList = [];
{
  const { page, cdp } = await openSky(BASE);
  await ensureEntered(page);
  const offered = await page.evaluate(() => {
    const b = document.querySelector('[data-sky=point]');
    return {
      hidden: b?.hidden,
      coarse: matchMedia('(any-pointer: coarse)').matches,
      secure: isSecureContext,
      aos: typeof AbsoluteOrientationSensor,
    };
  });
  check(
    'A: button offered on a touch phone',
    offered.hidden === false,
    offered,
  );
  const withControls = await audit(page);
  await page.screenshot({ path: path.join(OUT, '00-controls-portrait.png') });

  const magAz = moon.azDeg - decl;
  await readSensor(cdp, pose(magAz, moon.elDeg));
  await page.tap('[data-sky=point]');
  await sleep(1500);
  const on = await handleEval(page, (h) => ({
    state: h.orientation.state,
    source: h.orientation.source,
    info: h.orientation.info,
    view: h.view,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  say('pointing', on);
  check(
    'A: tap -> pointing on (virtual absolute-orientation sensor)',
    on.state === 'on',
    { state: on.state, source: on.source },
  );
  // B: centre on the Moon (true az = magnetic + declination)
  const missAz = wrap180(on.view.azDeg - moon.azDeg);
  const missEl = on.view.elDeg - moon.elDeg;
  check(
    "B: phone at the Moon's magnetic azimuth -> view centre on the true Moon (declination applied)",
    Math.abs(missAz) < 0.1 && Math.abs(missEl) < 0.1,
    { missAz, missEl, decl, status: on.status },
  );
  const drawn = await handleEval(page, (h) => {
    h.redraw();
    const c = document.querySelector('[data-sky=crosshair]');
    const r = c.getBoundingClientRect();
    return {
      crosshair: {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        hidden: c.hidden,
      },
      bodies: h.content.lastStats?.bodyNames,
      canvas: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  check(
    'B: centre circle shown at the screen centre; Moon drawn',
    !drawn.crosshair.hidden &&
      Math.abs(drawn.crosshair.x - drawn.canvas.w / 2) < 2 &&
      drawn.bodies?.includes('Moon'),
    drawn,
  );
  // I: pointing entered Clear view by itself (touch phone)
  const clearPortrait = await audit(page);
  const hidden = withControls.outer.filter(
    (n) => !clearPortrait.outer.includes(n),
  );
  say('clear view hides', hidden);
  hiddenList = hidden;
  check(
    'I: pointing on a touch phone enters Clear view with the one-off hint',
    clearPortrait.clear &&
      /Double-tap to show controls/.test(clearPortrait.note),
    { note: clearPortrait.note },
  );
  check(
    'I: Clear view: only the sky canvases, centre circle, eye and message are painted; every tap point hits the sky (the Data attribution link excepted); the overlay fills the screen',
    onlySky(clearPortrait) && hidden.length >= 8,
    {
      painted: clearPortrait.outer,
      notAllowed: clearPortrait.notAllowed,
      hits: clearPortrait.hits,
      skyRect: clearPortrait.skyRect,
      viewport: clearPortrait.viewport,
      hiddenCount: hidden.length,
    },
  );
  const inClear = await handleEval(page, (h) => h.view);
  const clearMissAz = wrap180(inClear.azDeg - moon.azDeg);
  const clearMissEl = inClear.elDeg - moon.elDeg;
  check(
    'I: Moon still centred in Clear view (miss <= 0.1 deg)',
    Math.abs(clearMissAz) <= 0.1 && Math.abs(clearMissEl) <= 0.1,
    { clearMissAz, clearMissEl },
  );
  check(
    'I: attribution: the credit line stays in Clear view while tiles are drawn, complete (no credit clipped or cut off), dim, bottom-left, tap-through, clear of the centre circle and the eye',
    attributionOk(clearPortrait),
    { tiles: clearPortrait.tiles, credits: clearPortrait.credits },
  );
  // flat horizon: no tiles, so no credit line; the view does not move
  await page.evaluate(() => document.querySelector('[data-sky=flat]').click());
  await sleep(800);
  const flatClear = await audit(page);
  await page.evaluate(() => document.querySelector('[data-sky=flat]').click());
  await sleep(800);
  const tilesAgain = await audit(page);
  const afterFlat = await handleEval(page, (h) => h.view);
  check(
    'I: attribution: flat horizon (no tiles) hides the credit line; real horizon brings it back; still only the sky; Moon still centred',
    !flatClear.tiles &&
      flatClear.credits?.visible === false &&
      flatClear.credits.painted === 0 &&
      onlySky(flatClear) &&
      attributionOk(tilesAgain) &&
      onlySky(tilesAgain) &&
      Math.abs(wrap180(afterFlat.azDeg - moon.azDeg)) <= 0.1 &&
      Math.abs(afterFlat.elDeg - moon.elDeg) <= 0.1,
    {
      flat: { tiles: flatClear.tiles, credits: flatClear.credits },
      again: { tiles: tilesAgain.tiles, painted: tilesAgain.credits?.painted },
      missAz: wrap180(afterFlat.azDeg - moon.azDeg),
      missEl: afterFlat.elDeg - moon.elDeg,
    },
  );
  // the credits Cesium lists only behind "Data attribution" stay reachable:
  // a tap on the link opens the full list over the clear sky; closing it
  // returns to the clear sky; the view does not move (review R1)
  const expandAt = tilesAgain.credits?.expand;
  let lightbox = null;
  let lightboxClosed = null;
  if (expandAt) {
    await page.touchscreen.tap(expandAt.point[0], expandAt.point[1]);
    await sleep(800);
    lightbox = await page.evaluate(() => {
      const o = document.querySelector('.cesium-credit-lightbox-overlay');
      const l = o?.querySelector('.cesium-credit-lightbox');
      const close = l?.querySelector('.cesium-credit-lightbox-close');
      const shown = (e) =>
        Boolean(e) &&
        getComputedStyle(e).display !== 'none' &&
        getComputedStyle(e).visibility === 'visible';
      const r = l?.getBoundingClientRect();
      return {
        clear: document.body.classList.contains('gev-sky-clear'),
        overlay: shown(o),
        box: shown(l),
        close: shown(close),
        items: [...(l?.querySelectorAll('li') ?? [])].filter(shown).length,
        inside:
          Boolean(r) &&
          r.left >= -1 &&
          r.top >= -1 &&
          r.right <= innerWidth + 1 &&
          r.bottom <= innerHeight + 1,
      };
    });
    await page.evaluate(() =>
      document.querySelector('.cesium-credit-lightbox-close')?.click(),
    );
    await sleep(500);
    lightboxClosed = await page.evaluate(() => {
      const o = document.querySelector('.cesium-credit-lightbox-overlay');
      return {
        clear: document.body.classList.contains('gev-sky-clear'),
        overlay: Boolean(o) && getComputedStyle(o).display !== 'none',
      };
    });
  }
  const afterList = await handleEval(page, (h) => h.view);
  check(
    'I: attribution: "Data attribution" opens the full credit list over the clear sky (still Clear view), it closes again, the view does not move',
    Boolean(expandAt) &&
      lightbox?.clear &&
      lightbox.overlay &&
      lightbox.box &&
      lightbox.close &&
      lightbox.items > 0 &&
      lightbox.inside &&
      lightboxClosed?.clear &&
      lightboxClosed.overlay === false &&
      Math.abs(wrap180(afterList.azDeg - moon.azDeg)) <= 0.1 &&
      Math.abs(afterList.elDeg - moon.elDeg) <= 0.1,
    { expandAt, lightbox, lightboxClosed },
  );
  await sleep(4000);
  await page.screenshot({
    path: path.join(OUT, '01-pointing-moon-portrait.png'),
  });

  // C: landscape, same pose of the phone's back
  await page.setViewport({
    ...PHONE,
    width: 915,
    height: 412,
    isLandscape: true,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 915,
    height: 412,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenOrientation: { type: 'landscapePrimary', angle: 90 },
  });
  await readSensor(cdp, pose(magAz, moon.elDeg, 90));
  await sleep(3000); // the 90 deg screen turn is smoothed (~1 s to < 1 deg)
  const land = await handleEval(page, (h) => {
    const bar = document
      .querySelector('[data-sky=bar]')
      .getBoundingClientRect();
    const ring = document
      .querySelector('[data-sky=crosshair]')
      .getBoundingClientRect();
    const tools = document.querySelector('.gev-sky-tools');
    return {
      view: h.view,
      angle: screen.orientation?.angle,
      barBottom: bar.bottom,
      ringTop: ring.top,
      toolsShown: tools ? getComputedStyle(tools).display !== 'none' : null,
    };
  });
  check(
    'C: landscape (angle 90) -> same az/el, roll 0',
    land.angle === 90 &&
      Math.abs(wrap180(land.view.azDeg - moon.azDeg)) < 0.1 &&
      Math.abs(land.view.elDeg - moon.elDeg) < 0.1 &&
      Math.abs(land.view.rollDeg) < LANDSCAPE_ROLL_TOL_DEG,
    land,
  );
  check(
    'C: landscape pointing keeps the centre circle clear (compact toolbar, tools folded)',
    land.barBottom < land.ringTop && land.toolsShown === false,
    {
      barBottom: land.barBottom,
      ringTop: land.ringTop,
      toolsShown: land.toolsShown,
    },
  );
  await sleep(4000);
  await page.screenshot({
    path: path.join(OUT, '02-pointing-moon-landscape.png'),
  });
  // J: landscape Clear view; double-tap brings the controls back and clears
  const clearLand = await audit(page);
  const viewLand = await handleEval(page, (h) => h.view);
  const landPt = await skyPoint(page);
  await doubleTap(page, landPt.x, landPt.y);
  const landControls = await clearOn(page);
  await sleep(1500);
  await page.screenshot({
    path: path.join(OUT, '02b-landscape-controls.png'),
  });
  const landPt2 = await skyPoint(page); // a sky point with the controls shown
  await doubleTap(page, landPt2.x, landPt2.y);
  const landAgain = await clearOn(page);
  const viewLand2 = await handleEval(page, (h) => h.view);
  check(
    'J: landscape: Clear view stays, only the sky is painted; double-tap shows the controls and clears again; view unchanged',
    onlySky(clearLand) &&
      landControls === false &&
      landAgain === true &&
      Math.abs(wrap180(viewLand2.azDeg - viewLand.azDeg)) < 0.1 &&
      Math.abs(viewLand2.elDeg - viewLand.elDeg) < 0.1,
    {
      notAllowed: clearLand.notAllowed,
      hits: clearLand.hits,
      skyRect: clearLand.skyRect,
      landControls,
      landAgain,
      tapAt: [landPt, landPt2],
      viewLand,
      viewLand2,
    },
  );
  check(
    'J: landscape attribution: the credit line stays complete (no credit clipped or cut off), dim, bottom-left, tap-through, clear of the centre circle and the eye',
    attributionOk(clearLand),
    { tiles: clearLand.tiles, credits: clearLand.credits },
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await page.setViewport(PHONE);
  await readSensor(cdp, pose(90 - decl, 20));
  await sleep(1500);

  // D: 90 deg turn (true 90 -> 180)
  const turn = await sampleViews(page, 1500, () =>
    readSensor(cdp, pose(180 - decl, 20)),
  );
  const startIdx = turn.findIndex((s) => s[0] > 90.05);
  const t0 = startIdx >= 0 ? turn[startIdx][3] : NaN;
  const within = turn.find((s, i) => i >= startIdx && 180 - s[0] < 1);
  const overshoot = Math.max(...turn.map((s) => s[0])) - 180;
  // By design a 90 deg step is within 1 deg after ~0.92 s (0.15 per 1/30 s);
  // headless frames come every 50-100 ms here, so the measured time can land
  // up to one frame gap later than the true crossing.
  const gaps = turn.slice(1).map((s, i) => s[3] - turn[i][3]);
  const frameGap = Math.max(...gaps);
  check(
    'D: 90 deg turn settles within 1 s (to < 1 deg; + one headless frame gap), no overshoot',
    within && within[3] - t0 < 1000 + frameGap && overshoot < 0.05,
    {
      frames: turn.length,
      settleMs: within ? Math.round(within[3] - t0) : null,
      frameGapMs: Math.round(frameGap),
      overshoot,
      last: turn.at(-1),
    },
  );
  await sleep(2500); // let the last smoothing steps finish before "still"

  // E: battery - still phone: no view changes; moving: <= 30 changes/s
  const still = await sampleViews(page, 2000);
  const changes = (samples) =>
    samples.filter(
      (s, i) =>
        i > 0 && (s[0] !== samples[i - 1][0] || s[1] !== samples[i - 1][1]),
    ).length;
  const stillChanges = changes(still);
  let k = 0;
  const moving = await sampleViews(page, 2000, async () => {
    for (let i = 0; i < 40; i += 1) {
      k += 1;
      await readSensor(cdp, pose(180 - decl + k * 2, 20));
      await sleep(50);
    }
  });
  const movingPerSec = changes(moving) / 2;
  const rafPerSec = moving.length / 2;
  check(
    'E: still phone -> no view changes; moving -> <= 30 view changes per second',
    stillChanges === 0 && movingPerSec <= 31,
    { stillChanges, stillFrames: still.length, movingPerSec, rafPerSec },
  );

  // F: drag takes over
  const before = await handleEval(page, (h) => h.view);
  await page.touchscreen.touchStart(150, 600);
  await page.touchscreen.touchMove(200, 620);
  await page.touchscreen.touchMove(260, 640);
  await page.touchscreen.touchEnd();
  await sleep(500);
  const after = await handleEval(page, (h) => ({
    view: h.view,
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  await readSensor(cdp, pose(10, 10));
  await sleep(800);
  const later = await handleEval(page, (h) => h.view);
  check(
    'F: a drag takes over: pointing off, roll 0, camera moved, sensor ignored',
    after.state === 'off' &&
      after.view.rollDeg === 0 &&
      Math.abs(wrap180(after.view.azDeg - before.azDeg)) > 1 &&
      later.azDeg === after.view.azDeg &&
      /Drag took over/.test(after.status),
    { before, after, later },
  );
  await page.screenshot({ path: path.join(OUT, '03-drag-took-over.png') });

  // K: toggles leave the view alone; H beats the app's HUD key; the eye fades
  await sleep(2000); // drag inertia from F has died out
  const k0 = await handleEval(page, (h) => ({
    view: h.view,
    clear: h.clearView.on,
  }));
  const hud0 = (await audit(page)).hud;
  const steps = [];
  const step = async (label) => {
    const a = await audit(page);
    const v = await handleEval(page, (h) => h.view);
    steps.push({ label, clear: a.clear, hud: a.hud === hud0, view: v });
    return a;
  };
  await page.keyboard.press('Escape');
  await sleep(300);
  await step('Escape');
  await page.keyboard.press('h');
  await sleep(300);
  await step('H');
  await page.keyboard.press('h');
  await sleep(300);
  await step('H');
  // hold H: puppeteer sends repeat keydowns (event.repeat) for a key that is
  // already down, like a held key; count them before the Sky view sees them
  await page.evaluate(() => {
    globalThis.__gevQaRepeats = 0;
    globalThis.addEventListener(
      'keydown',
      (e) => {
        if (e.key.toLowerCase() === 'h' && e.repeat)
          globalThis.__gevQaRepeats += 1;
      },
      true,
    );
  });
  for (let i = 0; i < 8; i++) {
    await page.keyboard.down('h');
    await sleep(40);
  }
  await page.keyboard.up('h');
  await sleep(300);
  const heldRepeats = await page.evaluate(() => globalThis.__gevQaRepeats);
  await step('hold H');
  await page.keyboard.press('h');
  await sleep(300);
  await step('H');
  await page.tap('[data-sky=clear]');
  await sleep(300);
  await step('eye');
  await sleep(3600);
  const faded = await audit(page);
  const wakePt = await skyPoint(page);
  await page.touchscreen.tap(wakePt.x, wakePt.y);
  await sleep(700);
  const woken = await audit(page);
  await page.tap('[data-sky=clear]');
  await sleep(300);
  await step('eye');
  const kPt = await skyPoint(page); // controls shown: tap the sky between them
  // Headless software GL can block the page for longer than the 350 ms
  // double-tap window after the first tap (seen: 739 ms between the two
  // pointerups with the NAIP basemap on screen). Such a pair is two single
  // taps by design, so only that case is retried (bounded, 3 tries). Missing
  // or extra pointerups, and a pair inside the window that does not toggle,
  // fail at once (qaDoubleTap.js; review R2).
  const kRun = await doubleTapWithRetry(
    async () => {
      const taps = await doubleTap(page, kPt.x, kPt.y);
      const ups = taps.filter((t) => t.type === 'pointerup').map((t) => t.t);
      return { ups, toggled: await clearOn(page), taps };
    },
    { maxTries: 3, pause: () => sleep(1000) },
  );
  const kTaps = { outcome: kRun.outcome, tries: kRun.tries };
  await step('double-tap');
  const active = await handleEval(page, (h) => h.active);
  const expected = [false, true, false, true, false, true, false, true];
  check(
    'K: Escape / H / held H / eye / double-tap toggle Clear view (Escape stays in the sky), H and held-H repeats do not toggle the HUD, the view never moves',
    k0.clear === true &&
      kRun.ok &&
      active &&
      heldRepeats >= 7 &&
      steps.every((s, i) => s.clear === expected[i] && s.hud) &&
      steps.every(
        (s) =>
          s.view.azDeg === k0.view.azDeg &&
          s.view.elDeg === k0.view.elDeg &&
          s.view.fovDeg === k0.view.fovDeg,
      ),
    { start: k0, heldRepeats, steps, kPt, kTaps },
  );
  check(
    'K: the restore handle fades after 3 s and a touch brings it back',
    faded.clear &&
      faded.eyeOpacity <= 0.25 &&
      woken.clear &&
      woken.eyeOpacity >= 0.7,
    { faded: faded.eyeOpacity, woken: woken.eyeOpacity },
  );
  await page.screenshot({ path: path.join(OUT, '06-clear-portrait.png') });
  await page.tap('[data-sky=clear]');
  await sleep(1500);
  await page.screenshot({
    path: path.join(OUT, '06b-controls-portrait.png'),
  });
  await page.close();
}

// ── G: sensors denied ──────────────────────────────────────────────────────
{
  const origin = new URL(BASE).origin;
  const bcdp = await browser.target().createCDPSession();
  for (const name of ['accelerometer', 'gyroscope', 'magnetometer'])
    await bcdp.send('Browser.setPermission', {
      permission: { name },
      setting: 'denied',
      origin,
    });
  const { page } = await openSky(BASE);
  await ensureEntered(page);
  await page.tap('[data-sky=point]');
  await sleep(4500);
  const denied = await handleEval(page, (h) => ({
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
    view: h.view,
  }));
  await page.touchscreen.touchStart(150, 600);
  await page.touchscreen.touchMove(190, 620);
  await page.touchscreen.touchMove(230, 640);
  await page.touchscreen.touchEnd();
  await sleep(500);
  const dragged = await handleEval(page, (h) => h.view);
  check(
    'G: sensors denied -> message, drag still works',
    (denied.state === 'denied' || denied.state === 'unsupported') &&
      denied.status.length > 20 &&
      Math.abs(wrap180(dragged.azDeg - denied.view.azDeg)) > 1,
    { denied, dragged },
  );
  await page.screenshot({ path: path.join(OUT, '04-denied.png') });
  await page.tap('[data-sky=clear]');
  await sleep(600);
  const deniedClear = await audit(page);
  check(
    'L: denied message stays visible over the clear sky',
    onlySky(deniedClear) && /Motion access is blocked/.test(deniedClear.note),
    { note: deniedClear.note, notAllowed: deniedClear.notAllowed },
  );
  await page.screenshot({ path: path.join(OUT, '04b-denied-clear.png') });
  await bcdp.send('Browser.resetPermissions', {});
  await page.close();
}

// ── H: insecure (plain http on a LAN-style host name) ──────────────────────
{
  const target = new URL(BASE);
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  });
  await new Promise((resolve) => proxy.listen(LAN_PORT, LAN_IP, resolve));
  const lan = `http://${LAN_IP}:${LAN_PORT}`;
  const { page } = await openSky(lan, { sensors: false });
  await ensureEntered(page);
  const secure = await page.evaluate(() => isSecureContext);
  await page.tap('[data-sky=point]');
  await sleep(800);
  const insecure = await handleEval(page, (h) => ({
    state: h.orientation.state,
    status: document.querySelector('[data-sky=orient-status]').textContent,
  }));
  check(
    'H: http LAN address -> "insecure" message naming the https address',
    secure === false &&
      insecure.state === 'insecure' &&
      /secure https:\/\/ address/.test(insecure.status),
    { secure, ...insecure },
  );
  await page.screenshot({ path: path.join(OUT, '05-insecure-lan.png') });
  await page.tap('[data-sky=clear]');
  await sleep(600);
  const lanClear = await audit(page);
  check(
    'L: insecure-address message stays visible over the clear sky',
    onlySky(lanClear) && /secure https:\/\/ address/.test(lanClear.note),
    { note: lanClear.note, notAllowed: lanClear.notAllowed },
  );
  await page.screenshot({ path: path.join(OUT, '05b-insecure-clear.png') });
  await page.close();
  proxy.close();
}

await browser.close();
const relevant = errors.filter(
  (e) => !/tiles-key|tiles-token|api\/google/.test(e),
);
check('no page errors', relevant.length === 0, relevant.slice(0, 10));
const pass = checks.every((c) => c.ok);
fs.writeFileSync(
  path.join(OUT, 'qa-sky-phone.json'),
  JSON.stringify(
    {
      pass,
      skyTime,
      moon: { az: moon.azDeg, el: moon.elDeg },
      decl,
      clearViewHides: hiddenList,
      checks,
      errors,
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(OUT, 'qa-sky-phone.log'), log.join('\n') + '\n');
say(
  pass ? 'QA sky phone PASS' : 'QA sky phone FAIL',
  `${checks.filter((c) => c.ok).length}/${checks.length}`,
);
process.exit(pass ? 0 : 1);
