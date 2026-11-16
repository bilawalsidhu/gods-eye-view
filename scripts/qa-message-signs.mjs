#!/usr/bin/env node
/**
 * qa-message-signs.mjs — headless proof for the Highway message signs layer
 * (id `message-signs`): every lit MnDOT sign as a marker, and MnDOT's own
 * rendering of its message as a face for the signs nearest the camera.
 *
 * Drives the REAL app in headless Chromium against the dev server, which
 * serves /src modules: the gate reads painted face boxes and face slots from
 * the overlay host itself, because the `desynchronized` overlay canvas can
 * read back a stale buffer headless. MnDOT is stubbed inside the page — fetch
 * answers /api/message-signs and its GIF route from fixtures built here — so
 * every phase is deterministic and nothing reaches MnDOT.
 *
 *   (i)    OFF — before the layer is enabled the page asks for no sign data.
 *   (ii)   LOW VIEW — over I-35W at 2.5 km the three Minneapolis faces paint,
 *          each at least 40 CSS px tall, the Rochester sign gets a marker but
 *          no face, and the row reads "4 signs lit".
 *   (iii)  STATEWIDE — from 900 km no face paints and all four markers show.
 *   (iv)   CARD — clicking a face opens its card, spoken by the status node
 *          with the location, the message and the data age; a second click,
 *          an empty click and Escape each close it.
 *   (v)    CHANGE — a refresh with one message replaced redraws that face in
 *          its existing slot; a sign that goes dark loses its face.
 *   (vi)   FLIP — the two-frame face flips on its GIF delay, with one render
 *          request per flip and none between.
 *   (vii)  EMPTY — an empty list reads "0 signs lit" with no markers.
 *   (viii) UNAVAILABLE — a failing list clears the layer and reports it; the
 *          next good list brings it back.
 *   Throughout: zero console errors.
 *
 * Screenshots go to qa-shots/message-signs-*.png (gitignored).
 *
 * Run:  npm run dev, then node scripts/qa-message-signs.mjs --url http://localhost:4173
 * Optional: --timeout-ms 180000 for a slow boot, --shots <dir>, --headful.
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const HEADFUL = argv.includes('--headful');
const TIMEOUT_MS = Number(getOpt('--timeout-ms', '90000'));
const SHOTS_DIR = path.resolve(
  getOpt('--shots', path.join(__dirname, '..', 'qa-shots')),
);
const LAYER_ID = 'message-signs';
const CARD_SOURCE_ID = 'message-signs-card';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A tiny GIF89a: black with amber bars, one bar layout per frame. Codes are a
 * fixed 8 bits (minimum code size 7, a clear code every 100 pixels), so it is
 * written without an LZW dictionary.
 */
function fixtureGif(width, height, frames) {
  const out = [];
  const u16 = (n) => out.push(n & 0xff, (n >> 8) & 0xff);
  out.push(...Buffer.from('GIF89a'));
  u16(width);
  u16(height);
  out.push(0xf6, 0, 0); // 128-entry global colour table
  for (let i = 0; i < 128; i++)
    out.push(...(i === 1 ? [255, 176, 0] : [0, 0, 0]));
  if (frames.length > 1)
    out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  for (const { delayCs, bars } of frames) {
    out.push(0x21, 0xf9, 4, 0x04); // keep each frame in place
    u16(delayCs);
    out.push(0, 0, 0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    out.push(0, 7);
    const codes = [128];
    let run = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (run === 100) {
          codes.push(128);
          run = 0;
        }
        const lit =
          x >= width * 0.1 &&
          x < width * 0.9 &&
          bars.some(
            ([top, bottom]) => y >= height * top && y < height * bottom,
          );
        codes.push(lit ? 1 : 0);
        run++;
      }
    codes.push(129);
    for (let i = 0; i < codes.length; i += 255) {
      const block = codes.slice(i, i + 255);
      out.push(block.length, ...block);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out).toString('base64');
}

// 144x96 GIFs draw as 72x48 CSS px faces (half size).
const TWO_LINES = [
  [0.2, 0.35],
  [0.6, 0.75],
];
const GIFS = {
  msg_0000000A: fixtureGif(144, 96, [{ delayCs: 0, bars: TWO_LINES }]),
  msg_0000000B: fixtureGif(144, 96, [
    { delayCs: 100, bars: [[0.4, 0.55]] },
    { delayCs: 100, bars: TWO_LINES },
  ]),
  msg_0000000C: fixtureGif(144, 96, [{ delayCs: 0, bars: TWO_LINES }]),
  msg_0000000D: fixtureGif(144, 96, [
    {
      delayCs: 0,
      bars: [
        [0.15, 0.3],
        [0.45, 0.6],
        [0.75, 0.9],
      ],
    },
  ]),
  msg_0000000E: fixtureGif(144, 96, [{ delayCs: 0, bars: TWO_LINES }]),
};

const sign = (id, lat, lon, location, message, multi) => ({
  id,
  provider: 'mndot',
  lat,
  lon,
  location,
  message,
  multi,
});
const SIGNS = [
  sign(
    'V35WN11',
    44.959,
    -93.2712,
    'I-35W NB @ 35th St',
    'msg_0000000A',
    'DOWNTOWN[nl]6 MIN',
  ),
  sign(
    'V35WN09',
    44.951,
    -93.2714,
    'I-35W NB @ 46th St',
    'msg_0000000B',
    'CRASH AHEAD[np]USE CAUTION',
  ),
  sign(
    'V35WS12',
    44.955,
    -93.2702,
    'I-35W SB @ 42nd St',
    'msg_0000000C',
    'I-494[nl]12 MIN',
  ),
  sign(
    'V52N03',
    44.02,
    -92.47,
    'US 52 NB @ 55th St NW',
    'msg_0000000E',
    'TWIN CITIES[nl]75 MIN',
  ),
];
const NEAR = ['V35WN11', 'V35WN09', 'V35WS12'];
const listOf = (signs) => ({
  provider: 'mndot',
  signs,
  joinMisses: 0,
  ageMs: 20000,
  stale: false,
});

/** In-page stand-in for the proxy: no request interception involved. */
function installStub({ gifs, list }) {
  const bytes = Object.fromEntries(
    Object.entries(gifs).map(([name, b64]) => [
      name,
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    ]),
  );
  const qa = (window.__qaSigns = { list, fail: false, requests: [] });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input?.url ?? String(input)),
      location.href,
    );
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith('/api/message-signs')
    )
      return realFetch(input, init);
    init?.signal?.throwIfAborted();
    qa.requests.push(url.pathname);
    if (qa.fail) return new Response('upstream down', { status: 502 });
    if (url.pathname === '/api/message-signs')
      return new Response(JSON.stringify(qa.list), {
        headers: { 'content-type': 'application/json' },
      });
    const name = /^\/api\/message-signs\/img\/(\w+)\.gif$/.exec(
      url.pathname,
    )?.[1];
    if (name && bytes[name])
      return new Response(bytes[name], {
        headers: { 'content-type': 'image/gif' },
      });
    return new Response('not found', { status: 404 });
  };
}

async function boot(page) {
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
  // The overlay host's own model: painted boxes and hit-testable entries.
  // Any setEntries invalidates the painted boxes until the next frame, so
  // they are read inside a postRender listener added after the host's own,
  // which runs once the host has painted that frame.
  await page.evaluate(async () => {
    window.__qaOverlay = await import('/src/overlays/worldOverlay.js');
    window.__qaAfterFrame = (read) =>
      new Promise((resolve) => {
        const { scene } = window.__godsEyeView.viewer;
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve(read());
        });
        scene.requestRender();
      });
  });
}

function flyTo(page, { lat, lon, height }) {
  return page.evaluate(
    async (la, lo, h) => {
      const { viewer } = window.__godsEyeView;
      const d2r = Math.PI / 180;
      try {
        viewer.camera.cancelFlight();
      } catch {
        /* no flight */
      }
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lo * d2r,
          latitude: la * d2r,
          height: h,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      viewer.scene.requestRender?.();
      await new Promise((r) => setTimeout(r, 1500));
    },
    lat,
    lon,
    height,
  );
}

const stats = (page) =>
  page.evaluate(
    (id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
    LAYER_ID,
  );

/** Overlay host state for the layer after a frame: entries, paints, boxes. */
const overlayState = (page) =>
  page.evaluate(
    (faces, card, ids) =>
      window.__qaAfterFrame(() => {
        const d = window.__gevWorldOverlay.getDiagnostics();
        const boxes = {};
        for (const id of ids) {
          const rect = window.__qaOverlay.getOverlayPaintRect(faces, id);
          boxes[id] = rect
            ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
            : null;
        }
        return {
          faces: d.entriesBySource?.[faces] ?? 0,
          facesPainted: d.paintedBySource?.[faces] ?? 0,
          cards: d.entriesBySource?.[card] ?? 0,
          cardsPainted: d.paintedBySource?.[card] ?? 0,
          boxes,
        };
      }),
    LAYER_ID,
    CARD_SOURCE_ID,
    SIGNS.map((s) => s.id),
  );

/** Poll overlayState until `test` holds; returns the last state and whether it held. */
async function untilOverlay(page, test, timeout) {
  const end = Date.now() + timeout;
  let state = await overlayState(page);
  while (!test(state) && Date.now() < end) {
    await sleep(250);
    state = await overlayState(page);
  }
  return { ok: test(state), state };
}

/** The layer's markers: total and shown. */
const markers = (page) =>
  page.evaluate(() => {
    const { primitives } = window.__godsEyeView.viewer.scene;
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives.get(i);
      if (typeof p?.get !== 'function' || !(p.length >= 0)) continue;
      const ids = [];
      let shown = 0;
      for (let j = 0; j < p.length; j++) {
        const id = String(p.get(j)?.id ?? '');
        if (!id.startsWith('message-sign:')) continue;
        ids.push(id);
        if (p.get(j).show) shown++;
      }
      if (ids.length) return { total: ids.length, shown };
    }
    return { total: 0, shown: 0 };
  });

const rowCount = (page) =>
  page.evaluate(
    (id) =>
      document
        .querySelector(`[data-layer-id="${id}"] .data-count`)
        ?.textContent?.trim() ?? null,
    LAYER_ID,
  );

const spoken = (page) =>
  page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          '.world-overlay-accessibility[role="status"]',
        ),
      ]
        .map((node) => node.textContent)
        .find((text) => text.startsWith('Message sign,')) ?? '',
  );

/** Page coordinates of a face's centre, from the host's painted box. */
const faceCentre = (page, id) =>
  page.evaluate(
    (faces, signId) =>
      window.__qaAfterFrame(() => {
        const rect = window.__qaOverlay.getOverlayPaintRect(faces, signId);
        if (!rect) return null;
        const box = document
          .getElementById('world-overlay-canvas')
          .getBoundingClientRect();
        return {
          x: box.left + rect.x + rect.w / 2,
          y: box.top + rect.y + rect.h / 2,
        };
      }),
    LAYER_ID,
    id,
  );

/**
 * The face slot painted for a sign — the entry's image, kept on window[key]
 * when given — with its stamp; null when the sign has no painted face.
 */
const faceSlot = (page, id, key = null) =>
  page.evaluate(
    (faces, signId, name) =>
      window.__qaAfterFrame(() => {
        const rect = window.__qaOverlay.getOverlayPaintRect(faces, signId);
        if (!rect) return null;
        const hit = window.__qaOverlay.hitTestWorldOverlay(
          rect.x + rect.w / 2,
          rect.y + rect.h / 2,
          { sourceId: faces },
        );
        const slot = hit?.entryId === signId ? hit.entry.image : null;
        if (!slot) return null;
        const held = name ? window[name] : null;
        if (name && !held) window[name] = slot;
        return { stamp: slot.stamp, same: !held || held === slot };
      }),
    LAYER_ID,
    id,
    key,
  );

const waitFor = (page, fn, timeout, ...args) =>
  page.waitForFunction(fn, { timeout, polling: 250 }, ...args).then(
    () => true,
    () => false,
  );

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) =>
      consoleErrors.push(String(error?.message ?? error).slice(0, 160)),
    );
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
    });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.clear();
      } catch {
        /* sandboxed frames have no storage */
      }
    });
    await page.evaluateOnNewDocument(installStub, {
      gifs: GIFS,
      list: listOf(SIGNS),
    });
    await boot(page);

    // ---- (i) OFF ----------------------------------------------------------
    const offRequests = await page.evaluate(
      () => window.__qaSigns.requests.length,
    );
    record(
      'OFF: no sign data is requested while the layer is off',
      offRequests === 0,
      `${offRequests} requests`,
    );

    // ---- (ii) LOW VIEW ----------------------------------------------------
    await flyTo(page, { lat: 44.955, lon: -93.2708, height: 2500 });
    await page.evaluate((id) => {
      const panel = document.getElementById('data-panel');
      if (panel?.classList.contains('collapsed'))
        panel.querySelector('[data-collapse-target="data-panel"]')?.click();
      return window.__godsEyeView.dataManager.setEnabled(id, true);
    }, LAYER_ID);
    const settled = await waitFor(
      page,
      (id) => {
        const s = window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getStats();
        return s.status === 'ok' && s.count === 4;
      },
      TIMEOUT_MS,
      LAYER_ID,
    );
    record(
      'LOW VIEW: the layer loads the four stubbed signs',
      settled,
      JSON.stringify(await stats(page)),
    );
    const { ok: painted, state: low } = await untilOverlay(
      page,
      (s) => NEAR.every((id) => s.boxes[id]),
      30000,
    );
    const heights = NEAR.map((id) => low.boxes[id]?.h ?? 0);
    record(
      'LOW VIEW: the three I-35W faces paint, each at least 40 CSS px tall',
      painted && low.facesPainted === 3 && heights.every((h) => h >= 40),
      `painted=${low.facesPainted} heights=${heights.join('/')}`,
    );
    record(
      'LOW VIEW: the Rochester sign, 100 km away, gets no face',
      low.faces === 3 && !low.boxes.V52N03,
      `face entries=${low.faces}`,
    );
    const lowMarkers = await markers(page);
    record(
      'LOW VIEW: every lit sign has a marker',
      lowMarkers.total === 4,
      JSON.stringify(lowMarkers),
    );
    const rowReady = await waitFor(
      page,
      (id) =>
        document
          .querySelector(`[data-layer-id="${id}"] .data-count`)
          ?.textContent?.trim() === '4 signs lit',
      15000,
      LAYER_ID,
    );
    record(
      'LOW VIEW: the row reads "4 signs lit"',
      rowReady,
      `"${await rowCount(page)}"`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'message-signs-low.png'),
    });

    // ---- (iv) CARD --------------------------------------------------------
    const cardOpen = async () =>
      (
        await untilOverlay(
          page,
          (s) => s.cards === 1 && s.cardsPainted === 1,
          10000,
        )
      ).ok;
    // Closed, and faded out, so the next click starts from a still frame.
    const cardClosed = async () =>
      (
        await untilOverlay(
          page,
          (s) => s.cards === 0 && s.cardsPainted === 0,
          10000,
        )
      ).ok;
    const target = await faceCentre(page, 'V35WN11');
    await page.mouse.click(target.x, target.y);
    const opened = await cardOpen();
    const announced = await spoken(page);
    record(
      'CARD: clicking a face opens its card',
      opened,
      JSON.stringify(
        (({ cards, cardsPainted }) => ({ cards, cardsPainted }))(
          await overlayState(page),
        ),
      ),
    );
    record(
      'CARD: the status node speaks the location, message and data age',
      announced.startsWith('Message sign, I-35W NB @ 35th St.') &&
        announced.includes('DOWNTOWN, 6 MIN') &&
        /MnDOT data \d+ seconds ago/.test(announced),
      `"${announced}"`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'message-signs-card.png'),
    });
    await page.mouse.click(target.x, target.y);
    record('CARD: a second click on the face closes it', await cardClosed());

    await page.mouse.click(target.x, target.y);
    await cardOpen();
    // Empty ground: a point clear of every face and of any scene object.
    const empty = await page.evaluate(() =>
      window.__qaAfterFrame(() => {
        const { viewer } = window.__godsEyeView;
        const box = viewer.scene.canvas.getBoundingClientRect();
        for (let x = 160; x < box.width - 160; x += 80) {
          const p = { x, y: box.height - 160 };
          if (viewer.scene.pick(p)) continue;
          if (window.__qaOverlay.hitTestWorldOverlay(p.x, p.y)) continue;
          return { x: box.left + p.x, y: box.top + p.y };
        }
        return null;
      }),
    );
    if (empty) await page.mouse.click(empty.x, empty.y);
    record(
      'CARD: an empty click closes it',
      Boolean(empty) && (await cardClosed()),
      empty
        ? `at ${Math.round(empty.x)},${Math.round(empty.y)}`
        : 'no empty point',
    );

    await page.mouse.click(target.x, target.y);
    await cardOpen();
    await page.keyboard.press('Escape');
    record('CARD: Escape closes it', await cardClosed());

    // ---- (vi) FLIP ---------------------------------------------------------
    // Measured before (v) so no refresh or camera move lands in the window.
    const flipStart = await faceSlot(page, 'V35WN09', '__qaFlipSlot');
    const flip = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const slot = window.__qaFlipSlot;
      const startStamp = slot.stamp;
      const startedAt = Date.now();
      const seen = new Set();
      while (Date.now() - startedAt < 3600) {
        for (const r of gev.getRenderGovernorDiagnostics().recentRequests)
          if (r.reason === 'message-signs' && r.at >= startedAt) seen.add(r);
        await new Promise((r) => setTimeout(r, 40));
      }
      const governor = gev.getRenderGovernorDiagnostics();
      return {
        flips: slot.stamp - startStamp,
        requests: seen.size,
        mode: governor.mode,
        holds: governor.holds,
      };
    });
    record(
      'FLIP: the two-frame face flips on its one-second GIF delay',
      flipStart !== null && flip.flips >= 3 && flip.flips <= 4,
      JSON.stringify(flip),
    );
    record(
      'FLIP: one render request per flip, none between',
      flip.mode === 'continuous'
        ? flip.requests === 0
        : flip.requests >= flip.flips - 1 && flip.requests <= flip.flips + 1,
      `${flip.requests} requests for ${flip.flips} flips (${flip.mode})`,
    );

    // ---- (v) CHANGE --------------------------------------------------------
    const before = await faceSlot(page, 'V35WN11', '__qaChangeSlot');
    await page.evaluate((signs) => {
      window.__qaSigns.list = {
        ...window.__qaSigns.list,
        signs: signs
          .filter((s) => s.id !== 'V35WS12')
          .map((s) =>
            s.id === 'V35WN11'
              ? { ...s, message: 'msg_0000000D', multi: 'DOWNTOWN[nl]9 MIN' }
              : s,
          ),
      };
      return window.__godsEyeView.dataManager.refreshLayer('message-signs');
    }, SIGNS);
    let after = null;
    for (let end = Date.now() + 15000; Date.now() < end; await sleep(250)) {
      after = await faceSlot(page, 'V35WN11', '__qaChangeSlot');
      if (after && after.stamp > (before?.stamp ?? Infinity)) break;
    }
    const fetched = await page.evaluate(() =>
      window.__qaSigns.requests.includes(
        '/api/message-signs/img/msg_0000000D.gif',
      ),
    );
    record(
      'CHANGE: a replaced message redraws the same face slot',
      before !== null && fetched && after?.same && after.stamp > before.stamp,
      `stamp ${before?.stamp} → ${after?.stamp}, same slot ${after?.same}, new GIF fetched ${fetched}`,
    );
    const { ok: dark, state: changed } = await untilOverlay(
      page,
      (s) =>
        s.faces === 2 && !s.boxes.V35WS12 && s.boxes.V35WN11 && s.boxes.V35WN09,
      10000,
    );
    record(
      'CHANGE: a sign that goes dark loses its face and marker',
      dark && (await markers(page)).total === 3,
      `face entries=${changed.faces}`,
    );

    // ---- (iii) STATEWIDE ---------------------------------------------------
    await page.evaluate((signs) => {
      window.__qaSigns.list = { ...window.__qaSigns.list, signs };
      return window.__godsEyeView.dataManager.refreshLayer('message-signs');
    }, SIGNS);
    await flyTo(page, { lat: 45.3, lon: -93.8, height: 900_000 });
    const { ok: statewide, state: far } = await untilOverlay(
      page,
      (s) => s.faces === 0 && s.facesPainted === 0,
      10000,
    );
    const farMarkers = await markers(page);
    record(
      'STATEWIDE: no face paints and all four markers show',
      statewide && far.facesPainted === 0 && farMarkers.shown === 4,
      `faces=${far.faces} painted=${far.facesPainted} markers=${JSON.stringify(farMarkers)}`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'message-signs-statewide.png'),
    });

    // ---- (vii) EMPTY -------------------------------------------------------
    await page.evaluate(() => {
      window.__qaSigns.list = { ...window.__qaSigns.list, signs: [] };
      return window.__godsEyeView.dataManager.refreshLayer('message-signs');
    });
    const emptyRow = await waitFor(
      page,
      (id) =>
        document
          .querySelector(`[data-layer-id="${id}"] .data-count`)
          ?.textContent?.trim() === '0 signs lit',
      15000,
      LAYER_ID,
    );
    const emptyStats = await stats(page);
    record(
      'EMPTY: an empty list reads "0 signs lit" with no markers',
      emptyRow &&
        emptyStats.status === 'ok' &&
        (await markers(page)).total === 0,
      `"${await rowCount(page)}" status=${emptyStats.status}`,
    );

    // ---- (viii) UNAVAILABLE -----------------------------------------------
    await page.evaluate((signs) => {
      window.__qaSigns.list = { ...window.__qaSigns.list, signs };
      window.__qaSigns.fail = true;
      return window.__godsEyeView.dataManager.refreshLayer('message-signs');
    }, SIGNS);
    const down = await stats(page);
    record(
      'UNAVAILABLE: a failing list clears the layer and reports it',
      down.status === 'unavailable' &&
        down.count === 0 &&
        down.error === 'MnDOT HTTP 502' &&
        (await markers(page)).total === 0,
      JSON.stringify({
        status: down.status,
        count: down.count,
        error: down.error,
      }),
    );
    await page.evaluate(() => {
      window.__qaSigns.fail = false;
      return window.__godsEyeView.dataManager.refreshLayer('message-signs');
    });
    const back = await stats(page);
    record(
      'UNAVAILABLE: the next good list brings the signs back',
      back.status === 'ok' && back.count === 4 && !back.error,
      JSON.stringify({ status: back.status, count: back.count }),
    );

    record(
      'no console errors',
      consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean',
    );
    await page.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS_DIR}`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
