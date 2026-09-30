#!/usr/bin/env node
/**
 * qa-live-tv.mjs — headless proof for the Live TV (iptv-org) layer.
 *
 * Drives the REAL app in headless Chromium against a dev server (keyless).
 * The live section reads the directory through `/api/live-tv`; the other
 * sections stub that route in the page so they are deterministic. Every
 * request the page makes for an `.m3u8` playlist is recorded, to prove that
 * nothing streams until a channel is chosen.
 *
 *   (i)   LIVE — the directory settles with no error, one pin per country,
 *         the busiest 25 listed, and no playlist requested.
 *   (ii)  LIVE PLAY — a country's channel list loads; choosing a news channel
 *         mounts the player, which reaches playing or reports unavailable.
 *         Whether a given broadcaster answers today is reported, not gated.
 *   (iii) FIXTURE — two countries in Europe and one on the far side of the
 *         globe: the far-side pin is hidden, a real click on a pin lists its
 *         channels without fetching a stream, News only filters, choosing a
 *         channel whose two streams are dead tries both and says "stream
 *         unavailable", Stop removes the player and All countries clears.
 *   (iv)  FAILURE — the route stubbed to 502: stats.error is set, the pins
 *         already on the globe are kept and the row says the refresh failed.
 *   (v)   DISABLE — the data source is hidden and no player remains.
 *
 * Visual proof saved to qa-shots/live-tv-*.png (gitignored).
 *
 * Run:  node scripts/qa-live-tv.mjs --url http://localhost:4173
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
const LAYER_ID = 'live-tv';
// Nothing listens on port 9 (discard) locally, so these fail fast.
const DEAD_STREAMS = [
  'http://127.0.0.1:9/qa-live-tv/first.m3u8',
  'http://127.0.0.1:9/qa-live-tv/second.m3u8',
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(name, detail) {
  console.log(
    `  [\x1b[36mNOTE\x1b[0m] ${name}${detail ? `  — ${detail}` : ''}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record every HLS playlist the page asks for. */
function watchPlaylists(page) {
  const urls = [];
  page.on('request', (request) => {
    if (/\.m3u8(\?|$)/i.test(request.url())) urls.push(request.url());
  });
  return urls;
}

/** Boot the app, dismiss the intro and place the camera straight down. */
async function boot(page, { lon, lat, height }) {
  await page.goto(`${APP_URL}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(5000);
  await page.keyboard.press('Escape');
  await page.evaluate(
    (lo, la, h) => {
      const gev = window.__godsEyeView;
      const d2r = Math.PI / 180;
      // The app's intro flyTo animation clobbers a setView issued mid-flight.
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      gev.viewer.camera.setView({
        destination: gev.viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: lo * d2r,
          latitude: la * d2r,
          height: h,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    },
    lon,
    lat,
    height,
  );
}

/** Enable (or refresh) the layer and poll until it settles. */
async function enableAndSettle(page, { timeoutS = 90, refresh = false } = {}) {
  return page.evaluate(
    async (id, tS, again) => {
      const dm = window.__godsEyeView.dataManager;
      const layer = dm.layers.get(id).module;
      const before = layer.getStats().lastUpdate;
      if (again) await dm.refreshLayer(id);
      else await dm.setEnabled(id, true);
      let stats = null;
      for (let i = 0; i < tS; i++) {
        stats = layer.getStats();
        if (stats.error || (stats.lastUpdate && stats.lastUpdate !== before))
          break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const controls = layer.getRowControls();
      const ds = window.__godsEyeView.viewer.dataSources.getByName(id)[0];
      return {
        stats,
        items: controls.list.items.length,
        info: controls.info,
        entities: ds?.entities.values.length ?? -1,
        shown: ds?.show ?? null,
      };
    },
    LAYER_ID,
    timeoutS,
    refresh,
  );
}

/** Open the Data Layers panel and bring the Live TV row into view. */
async function showLayerRow(page) {
  await page.evaluate((id) => {
    const panel = document.getElementById('data-panel');
    if (panel.classList.contains('collapsed'))
      panel.querySelector('[data-collapse-target="data-panel"]').click();
    document
      .querySelector(`[data-layer-id="${id}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, LAYER_ID);
  await sleep(800);
}

async function shoot(page, name) {
  await page
    .waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      { timeout: 60000 },
    )
    .catch(() => {});
  await showLayerRow(page);
  await page.screenshot({ path: path.join(SHOTS_DIR, `live-tv-${name}.png`) });
}

/** The DOM of the Live TV row. */
const rowDom = (page) =>
  page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const all = (selector) => [...(row?.querySelectorAll(selector) || [])];
    const video = row?.querySelector('.data-row-media video');
    return {
      items: all('.data-row-list-item').map((node) => node.dataset.listItemId),
      leads: all('.data-row-list-lead').map((node) => node.textContent),
      activeItems: all('.data-row-list-item.active').map(
        (node) => node.dataset.listItemId,
      ),
      chips: all('.data-toggle-chip').map((node) => node.dataset.chipId),
      info: row?.querySelector('.data-toggle-controls-info')?.textContent || '',
      video: video
        ? {
            preload: video.preload,
            controls: video.controls,
            autoplay: video.autoplay,
            label: video.getAttribute('aria-label'),
          }
        : null,
    };
  }, LAYER_ID);

const diagnostics = (page) =>
  page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics(),
    LAYER_ID,
  );

/** Wait until the chosen channel's player reports playing or unavailable. */
const waitForPlayback = (page, timeoutMs) =>
  page
    .waitForFunction(
      (id) => {
        const playback = window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getDiagnostics().playback;
        return (
          playback?.state === 'playing' || playback?.state === 'unavailable'
        );
      },
      { timeout: timeoutMs },
      LAYER_ID,
    )
    .then(() => diagnostics(page))
    .catch(() => diagnostics(page));

/** Page position of a country's pin, or null when it is off screen. */
const pinOnScreen = (page, code) =>
  page.evaluate(
    (id, entityId) => {
      const { viewer } = window.__godsEyeView;
      const ds = viewer.dataSources.getByName(id)[0];
      const entity = ds?.entities.getById(entityId);
      const world = entity?.position?.getValue(viewer.clock.currentTime);
      const win = world && viewer.scene.cartesianToCanvasCoordinates(world);
      if (!win || !Number.isFinite(win.x)) return null;
      const rect = viewer.scene.canvas.getBoundingClientRect();
      const x = rect.left + win.x;
      const y = rect.top + win.y;
      return document.elementFromPoint(x, y) === viewer.scene.canvas
        ? { x, y }
        : null;
    },
    LAYER_ID,
    `${LAYER_ID}:${code}`,
  );

const clickRow = (page, selector) =>
  page.click(`[data-layer-id="${LAYER_ID}"] ${selector}`);

const channel = (id, categories, streams) => ({
  id,
  name: id.split('.')[0].replace(/_/g, ' '),
  categories,
  streams: streams.map((url, index) => ({
    url,
    quality: index ? '' : '720p',
    labels: index ? ['Geo-blocked'] : [],
  })),
});

function fixture() {
  return {
    countries: [
      {
        code: 'PL',
        name: 'Poland',
        lon: 19.4,
        lat: 52.1,
        channels: 3,
        adult: 1,
      },
      { code: 'DE', name: 'Germany', lon: 10.3, lat: 51.1, channels: 1 },
      // The far side of the globe from a camera above Europe.
      { code: 'FJ', name: 'Fiji', lon: 178, lat: -17.8, channels: 1 },
      // Adult channels only: no pin until Adult 18+ is on.
      {
        code: 'NL',
        name: 'Netherlands',
        lon: 5.6,
        lat: 52.2,
        channels: 0,
        adult: 1,
      },
      // Malformed: dropped by the client sanitizer.
      { code: 'pl', name: 'Bad', lon: 0, lat: 0, channels: 1 },
    ],
    channels: {
      PL: [
        channel('Dead_News.pl', ['news'], DEAD_STREAMS),
        channel('Kino.pl', ['movies'], ['http://127.0.0.1:9/kino.m3u8']),
        channel('Sport.pl', ['sports'], ['http://127.0.0.1:9/sport.m3u8']),
        {
          ...channel('Late.pl', ['general'], ['http://127.0.0.1:9/late.m3u8']),
          adult: true,
        },
      ],
      NL: [
        {
          ...channel('Night.nl', ['general'], ['http://127.0.0.1:9/nl.m3u8']),
          adult: true,
        },
      ],
      DE: [channel('Info.de', ['news'], ['http://127.0.0.1:9/de.m3u8'])],
      FJ: [channel('Fiji_One.fj', ['general'], ['http://127.0.0.1:9/fj.m3u8'])],
    },
  };
}

async function main() {
  console.log('\nLive TV proof (qa-live-tv)');
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
    ...(executablePath && fs.existsSync(executablePath)
      ? { executablePath }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
    ],
  });

  let exitCode = 0;
  const errors = [];
  try {
    // ── (i) LIVE ──────────────────────────────────────────────────────────
    console.log('(i) LIVE — the iptv-org directory...');
    const live = await browser.newPage();
    await live.setViewport({ width: 1440, height: 900 });
    live.on('pageerror', (e) => errors.push(e.message));
    const livePlaylists = watchPlaylists(live);
    await boot(live, { lon: 15, lat: 30, height: 18_000_000 });
    const l = await enableAndSettle(live);
    record(
      'LIVE: no error, one pin per country, the busiest 25 listed',
      !l.stats.error &&
        l.entities > 100 &&
        l.items === 25 &&
        l.stats.count > 5_000,
      `pins=${l.entities} channels=${l.stats.count} items=${l.items} error=${JSON.stringify(l.stats.error)}`,
    );
    record(
      'LIVE: the row carries the linked-not-hosted caveat',
      /linked not hosted/.test(l.info),
      l.info,
    );
    const adultDefault = await live.evaluate(() =>
      document
        .querySelector('[data-chip-id="adult"]')
        ?.getAttribute('aria-pressed'),
    );
    record(
      'LIVE: Adult 18+ is offered and off by default',
      adultDefault === 'false',
      String(adultDefault),
    );
    await shoot(live, 'live-world');

    // ── (ii) LIVE PLAY ────────────────────────────────────────────────────
    console.log('\n(ii) LIVE PLAY — one country, one news channel...');
    await clickRow(live, '.data-row-list-item[data-list-item-id="US"]').catch(
      () => clickRow(live, '.data-row-list-item'),
    );
    await live
      .waitForFunction(
        (id) =>
          window.__godsEyeView.dataManager.layers
            .get(id)
            .module.getRowControls().list.items.length > 0,
        { timeout: 30000 },
        LAYER_ID,
      )
      .catch(() => {});
    await sleep(500);
    const listed = await rowDom(live);
    record(
      'LIVE PLAY: a country lists its channels and nothing has streamed yet',
      listed.items.length > 0 &&
        listed.video === null &&
        livePlaylists.length === 0,
      `channels=${listed.items.length} playlists=${livePlaylists.length} info=${JSON.stringify(listed.info)}`,
    );
    await live.evaluate((id) => {
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.setParams({ newsOnly: true });
    }, LAYER_ID);
    await sleep(300);
    let played = null;
    const tried = [];
    for (const channelId of (await rowDom(live)).items.slice(0, 6)) {
      await clickRow(
        live,
        `.data-row-list-item[data-list-item-id="${channelId}"]`,
      );
      const d = await waitForPlayback(live, 50_000);
      tried.push(
        `${channelId}:${d.playback?.state}/${d.playback?.reason || ''}`,
      );
      if (d.playback?.state === 'playing') {
        played = channelId;
        break;
      }
    }
    const playing = await rowDom(live);
    record(
      'LIVE PLAY: the chosen channel mounts a click-to-play player that settles',
      tried.length > 0 &&
        livePlaylists.length > 0 &&
        playing.video?.preload === 'none' &&
        playing.video?.autoplay === false,
      `tried=${JSON.stringify(tried)} playlists=${livePlaylists.length}`,
    );
    if (played) {
      await sleep(4000);
      note('LIVE PLAY: a broadcaster answered', played);
    } else
      note('LIVE PLAY: no tried broadcaster answered today', tried.join(' '));
    await shoot(live, 'live-play');
    await live.close();

    // ── (iii) FIXTURE ─────────────────────────────────────────────────────
    console.log(
      '\n(iii) FIXTURE — stubbed directory through the real layer...',
    );
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(e.message));
    const playlists = watchPlaylists(page);
    // Stub the route in-page rather than with request interception: an
    // intercepted page stalls Cesium's workers, so the globe never settles.
    await page.evaluateOnNewDocument((payload) => {
      const realFetch = window.fetch.bind(window);
      window.__liveTvQaMode = 'fixture';
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (!url.includes('/api/live-tv')) return realFetch(input, init);
        const ok = window.__liveTvQaMode === 'fixture';
        const code = url.match(/\/country\/([A-Z]{2})$/)?.[1];
        const body = !ok
          ? { error: 'live_tv_unavailable' }
          : code
            ? { fetchedAt: Date.now(), code, channels: payload.channels[code] }
            : { fetchedAt: Date.now(), countries: payload.countries };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: ok ? 200 : 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    }, fixture());
    await boot(page, { lon: 15, lat: 50, height: 7_000_000 });
    const f = await enableAndSettle(page);
    await sleep(1000);
    const drawn = await page.evaluate((id) => {
      const { viewer, dataManager } = window.__godsEyeView;
      return {
        labels: dataManager.layers.get(id).module.getDiagnostics().labels,
        show: Object.fromEntries(
          viewer.dataSources
            .getByName(id)[0]
            .entities.values.map((entity) => [
              entity.id.split(':')[1],
              entity.show,
            ]),
        ),
      };
    }, LAYER_ID);
    record(
      'FIXTURE: 3 pins drawn, the malformed and adult-only countries left off, 5 channels counted',
      f.entities === 3 && f.stats.count === 5,
      `pins=${f.entities} channels=${f.stats.count}`,
    );
    record(
      'FIXTURE: the far-side pin is hidden, the near ones shown and labelled',
      drawn.show.FJ === false &&
        drawn.show.PL === true &&
        drawn.show.DE === true &&
        drawn.labels.includes('PL'),
      JSON.stringify(drawn),
    );
    await shoot(page, 'fixture');

    const pin = await pinOnScreen(page, 'PL');
    if (pin) await page.mouse.click(pin.x, pin.y);
    await sleep(800);
    const chosen = await rowDom(page);
    record(
      'FIXTURE: a globe click on a pin lists that country without streaming',
      pin !== null &&
        (await diagnostics(page)).selectedCountry === 'PL' &&
        chosen.items.join() === 'Dead_News.pl,Kino.pl,Sport.pl' &&
        chosen.video === null &&
        playlists.length === 0,
      `pin=${JSON.stringify(pin)} items=${JSON.stringify(chosen.items)} playlists=${playlists.length}`,
    );
    await clickRow(page, '[data-chip-id="news"]');
    await sleep(300);
    const news = await rowDom(page);
    record(
      'FIXTURE: News only keeps the news channel',
      news.items.join() === 'Dead_News.pl',
      JSON.stringify(news.items),
    );
    await clickRow(
      page,
      '.data-row-list-item[data-list-item-id="Dead_News.pl"]',
    );
    const dead = await waitForPlayback(page, 45_000);
    await sleep(300);
    const failed = await rowDom(page);
    record(
      'FIXTURE: both dead streams are tried, then "stream unavailable" is shown',
      dead.playback?.state === 'unavailable' &&
        DEAD_STREAMS.every((url) => playlists.includes(url)) &&
        /stream unavailable/.test(failed.info) &&
        failed.video?.label === 'Live TV: Dead News' &&
        failed.chips.at(-1) === 'stop',
      `playback=${JSON.stringify(dead.playback)} playlists=${JSON.stringify(playlists)} info=${JSON.stringify(failed.info)}`,
    );
    await shoot(page, 'unavailable');
    await clickRow(page, '[data-chip-id="stop"]');
    await sleep(300);
    const stopped = await rowDom(page);
    record(
      'FIXTURE: Stop removes the player and keeps the country',
      stopped.video === null &&
        !stopped.chips.includes('stop') &&
        (await diagnostics(page)).selectedCountry === 'PL',
      JSON.stringify(stopped.chips),
    );
    await clickRow(page, '[data-chip-id="news"]');
    await clickRow(page, '[data-chip-id="adult"]');
    await sleep(500);
    const adultOn = await page.evaluate((id) => {
      const { viewer, dataManager } = window.__godsEyeView;
      const controls = dataManager.layers.get(id).module.getRowControls();
      return {
        pins: viewer.dataSources.getByName(id)[0].entities.values.length,
        pressed: document
          .querySelector('[data-chip-id="adult"]')
          ?.getAttribute('aria-pressed'),
        late: controls.list.items.find((item) => item.id === 'Late.pl')?.text,
      };
    }, LAYER_ID);
    record(
      'FIXTURE: Adult 18+ adds the adult-only pin and lists 18+ channels, labelled',
      adultOn.pins === 4 &&
        adultOn.pressed === 'true' &&
        /^18\+ · Late/.test(adultOn.late || ''),
      JSON.stringify(adultOn),
    );
    await shoot(page, 'adult-on');
    await clickRow(page, '[data-chip-id="adult"]');
    await sleep(500);
    const adultOff = await rowDom(page);
    record(
      'FIXTURE: turning Adult 18+ off hides them again',
      (await page.evaluate(
        (id) =>
          window.__godsEyeView.viewer.dataSources.getByName(id)[0].entities
            .values.length,
        LAYER_ID,
      )) === 3 && !adultOff.items.includes('Late.pl'),
      JSON.stringify(adultOff.items),
    );
    await clickRow(page, '[data-chip-id="countries"]');
    await sleep(300);
    record(
      'FIXTURE: All countries returns to the country list',
      (await diagnostics(page)).selectedCountry === null &&
        (await rowDom(page)).items.join() === 'PL,DE,FJ',
      JSON.stringify((await rowDom(page)).items),
    );

    // ── (iv) FAILURE ──────────────────────────────────────────────────────
    console.log('\n(iv) FAILURE — /api/live-tv stubbed to 502...');
    await page.evaluate(() => {
      window.__liveTvQaMode = 'error';
    });
    const e = await enableAndSettle(page, { refresh: true, timeoutS: 3 });
    const broken = await rowDom(page);
    record(
      'FAILURE: error surfaced, pins kept, row says so',
      Boolean(e.stats.error) &&
        e.entities === 3 &&
        /Last refresh failed/.test(broken.info),
      `error=${JSON.stringify(e.stats.error)} pins=${e.entities} info=${JSON.stringify(broken.info)}`,
    );

    // ── (v) DISABLE ───────────────────────────────────────────────────────
    console.log('\n(v) DISABLE...');
    await page.evaluate((id) => {
      window.__liveTvQaMode = 'fixture';
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.setParams({ country: 'DE' });
    }, LAYER_ID);
    await sleep(500);
    await clickRow(page, '.data-row-list-item[data-list-item-id="Info.de"]');
    await sleep(300);
    const beforeDisable = await rowDom(page);
    const shown = await page.evaluate(async (id) => {
      await window.__godsEyeView.dataManager.setEnabled(id, false);
      return window.__godsEyeView.viewer.dataSources.getByName(id)[0]?.show;
    }, LAYER_ID);
    await sleep(300);
    const videos = await page.evaluate(
      () => document.querySelectorAll('.data-row-media video').length,
    );
    record(
      'DISABLE: data source hidden and the player released',
      beforeDisable.video !== null && shown === false && videos === 0,
      `show=${shown} videos=${videos}`,
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
  console.log(`  Shots : ${SHOTS_DIR}/live-tv-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
