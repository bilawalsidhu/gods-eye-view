#!/usr/bin/env node
/**
 * Deterministic browser proof for the KiwiSDR layer and player.
 *
 * Intercepts `/api/kiwisdr` with a fixture directory and runs two local mock
 * receivers that speak the real KiwiSDR binary framing (MSG / SND / W/F over
 * `/kiwi/<ts>/SND` and `/kiwi/<ts>/W/F`): one healthy, one that reports every
 * slot in use. It proves the layer toggles on and off, receivers appear on the
 * globe, clicking one opens the player, audio and waterfall frames arrive,
 * tuning commands reach the receiver, a full receiver is reported plainly, and
 * the console stays clean. Screenshots go under the gitignored
 * `qa-shots/kiwisdr/`.
 *
 * Run: node scripts/qa-kiwisdr.mjs --url http://localhost:4173
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'kiwisdr');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const PAGE_URL = new URL(APP_URL);
PAGE_URL.searchParams.set('welcome', '0');
const HEADFUL = args.includes('--headful');
const SHOTS = args.includes('--shots');
const GOOD_PORT = 18073;
const FULL_PORT = 18074;

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

const results = [];
const startedAt = Date.now();
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(3);
  console.log(`  [${label}] ${elapsed}s ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fixture directory -------------------------------------------------------
const MOCK = { id: 'qamock000001', lat: 51, lon: 10 };
const FULL = { id: 'qafull000001', lat: 35, lon: -100 };
function station(id, name, lat, lon, users, usersMax, host, port) {
  return {
    id,
    name,
    loc: name,
    lat,
    lon,
    users,
    usersMax,
    origin: `http://${host}:${port}`,
    host,
    port,
    secure: false,
    antenna: 'QA antenna',
    hardware: 'KiwiSDR 2',
    lowHz: 0,
    highHz: 30_000_000,
    snr: 40,
    gridSquare: 'JO51',
    updated: 'now',
  };
}
const stations = [
  station(MOCK.id, 'QA Mock Kiwi', MOCK.lat, MOCK.lon, 1, 8, '127.0.0.1', GOOD_PORT),
  station(FULL.id, 'QA Full Kiwi', FULL.lat, FULL.lon, 4, 4, '127.0.0.1', FULL_PORT),
];
for (let i = 0; i < 60; i++) {
  const usersMax = 4 + (i % 5) * 2;
  stations.push(
    station(
      `qafake${String(i).padStart(6, '0')}`,
      `QA Fake ${i}`,
      -60 + (i % 10) * 13,
      -170 + Math.floor(i / 10) * 55 + (i % 3) * 7,
      i % (usersMax + 1),
      usersMax,
      'kiwi.example.test',
      8073,
    ),
  );
}

// --- mock receivers ----------------------------------------------------------
const received = { snd: [], wf: [] };
const frames = { snd: 0, wf: 0 };
const tag = (name, ...rest) => Buffer.concat([Buffer.from(name, 'latin1'), ...rest]);
const msg = (text) => tag('MSG', Buffer.from([0]), Buffer.from(text, 'latin1'));

function startReceiver(port, { full = false } = {}) {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  server.on('connection', (socket, request) => {
    const stream = /\/SND$/.test(request.url) ? 'snd' : /\/W\/F$/.test(request.url) ? 'wf' : null;
    if (!stream) return socket.close();
    let timer = null;
    let seq = 0;
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (!full) received[stream].push(text);
      if (text.startsWith('SET auth')) {
        if (full) return socket.send(msg('too_busy=1'));
        socket.send(
          stream === 'snd'
            ? msg('audio_rate=12000 sample_rate=12000.000')
            : msg('bandwidth=30000000 center_freq=15000000 wf_setup=1'),
        );
        if (timer) return;
        if (stream === 'snd') {
          timer = setInterval(() => {
            const samples = Buffer.alloc(480 * 2);
            for (let i = 0; i < 480; i++) {
              const t = (seq * 480 + i) / 12000;
              samples.writeInt16BE(Math.round(Math.sin(2 * Math.PI * 700 * t) * 9000), i * 2);
            }
            const header = Buffer.alloc(7);
            header[0] = 0;
            header.writeUInt32LE(seq++, 1);
            header.writeUInt16BE(540, 5); // -73 dBm
            if (socket.readyState === 1) socket.send(tag('SND', header, samples));
            frames.snd++;
          }, 40);
        } else {
          timer = setInterval(() => {
            const header = Buffer.alloc(12);
            header.writeUInt32LE(0, 0);
            header.writeUInt32LE(0, 4);
            header.writeUInt32LE(seq++, 8);
            const bins = Buffer.alloc(1024);
            for (let i = 0; i < 1024; i++) {
              const peak = Math.exp(-(((i - 340) / 6) ** 2)) * 90;
              bins[i] = Math.min(255, Math.round(150 + Math.random() * 18 + peak));
            }
            if (socket.readyState === 1) socket.send(tag('W/F', Buffer.from([0]), header, bins));
            frames.wf++;
          }, 100);
        }
      }
    });
    socket.on('close', () => timer && clearInterval(timer));
  });
  return server;
}

// -----------------------------------------------------------------------------
async function main() {
  const response = await fetch(APP_URL).catch(() => null);
  if (!response?.ok) {
    console.error(`Dev server not reachable at ${APP_URL}`);
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const servers = [startReceiver(GOOD_PORT), startReceiver(FULL_PORT, { full: true })];
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    dumpio: Boolean(process.env.KIWI_QA_DUMPIO),
    ...(chrome ? { executablePath: chrome } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu']
        : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1000,640',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 640 });
    const stamp = () => ((Date.now() - startedAt) / 1000).toFixed(1);
    page.on('close', () => console.log(`  [${stamp()}s] page closed`));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`  [${stamp()}s] navigated ${f.url()}`); });
    browser.on('disconnected', () => console.log(`  [${stamp()}s] browser disconnected`));
    browser.process()?.on('exit', (code, signal) => console.log(`  [${stamp()}s] chromium exited code=${code} signal=${signal}`));
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('error', (error) => {
      console.log(`  [page crashed] ${error.message}`);
      consoleErrors.push(`page crashed: ${error.message}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.setRequestInterception(true);
    let directoryRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/kiwisdr') {
        directoryRequests++;
        return request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ fetchedAt: new Date().toISOString(), stations }),
        });
      }
      request.continue();
    });

    if (process.env.KIWI_QA_NO_BACKDROP) await page.evaluateOnNewDocument(() => { document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.kiwisdr-panel{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'; document.head.append(st); }); });
    await page.goto(PAGE_URL.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 60_000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.styleManager?._dataManager?.layers?.has('kiwisdr'),
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60_000 },
    );
    check('KiwiSDR layer is registered and off by default', await page.evaluate(
      () => !window.__godsEyeView.dataManager.isEnabled('kiwisdr'),
    ));

    // Enable and wait for the directory to load.
    await page.evaluate(() => {
      window.__godsEyeView.viewer.camera.cancelFlight();
      window.__godsEyeView.dataManager.toggle('kiwisdr');
    });
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager._dataManager.layers.get('kiwisdr')?.module?.getStats?.().count > 0,
      { timeout: 30_000 },
    ).catch(() => {});
    const stats = await page.evaluate(
      () => window.__godsEyeView.styleManager._dataManager.layers.get('kiwisdr').module.getStats(),
    );
    check('Enabling fetches the directory and places every receiver', stats.count === stations.length && directoryRequests >= 1, JSON.stringify(stats));

    // Fly to the mock receiver and click it.
    const aim = async ({ lat, lon }) => {
      await page.evaluate(({ lat, lon }) => {
        const { viewer } = window.__godsEyeView;
        const C = viewer.camera.positionCartographic.constructor;
        const ellipsoid = viewer.scene.globe.ellipsoid;
        const dest = ellipsoid.cartographicToCartesian(new C((lon * Math.PI) / 180, (lat * Math.PI) / 180, 2_500_000));
        viewer.camera.cancelFlight();
        viewer.camera.setView({ destination: dest, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      }, { lat, lon });
      await page.evaluate(() => new Promise((resolve) => {
        const scene = window.__godsEyeView.viewer.scene;
        let n = 4;
        const off = scene.postRender.addEventListener(() => {
          if (--n === 0) { off(); resolve(); } else scene.requestRender();
        });
        scene.requestRender();
      }));
      await sleep(400);
      return page.evaluate(({ lat, lon }) => {
        const { viewer } = window.__godsEyeView;
        const C = viewer.camera.positionCartographic.constructor;
        const pos = viewer.scene.globe.ellipsoid.cartographicToCartesian(new C((lon * Math.PI) / 180, (lat * Math.PI) / 180, 30));
        const p = viewer.scene.cartesianToCanvasCoordinates(pos);
        const r = viewer.scene.canvas.getBoundingClientRect();
        return p ? { x: r.left + p.x, y: r.top + p.y } : null;
      }, { lat, lon });
    };

    const at = await aim(MOCK);
    check('Mock receiver projects to a screen position', Boolean(at));
    await page.screenshot({ path: path.join(SHOTS_DIR, '01-globe-with-receivers.png') });
    await page.mouse.move(at.x, at.y);
    await sleep(300);
    const tooltip = await page.evaluate(() => {
      const el = document.querySelector('.kiwisdr-tooltip');
      return el && !el.hidden ? el.textContent : null;
    });
    check('Hovering a receiver shows name and load', /QA Mock Kiwi/.test(tooltip || '') && /1\/8/.test(tooltip || ''), String(tooltip));

    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#kiwisdr-panel', { visible: true, timeout: 10_000 }).catch(() => {});
    const opened = await page.evaluate(() => {
      const el = document.getElementById('kiwisdr-panel');
      return el && !el.hidden ? el.textContent : null;
    });
    check('Clicking a receiver opens the player panel', /QA Mock Kiwi/.test(opened || ''));

    // Wait for live audio + waterfall frames.
    await page.waitForFunction(
      () => /live|listening/i.test(document.querySelector('#kiwisdr-panel .kiwisdr-status')?.textContent || ''),
      { timeout: 20_000 },
    ).catch(() => {});
    await sleep(1500);
    const sndCmds = received.snd.join(' | ');
    check('Audio socket authenticates, negotiates the rate and tunes', /SET auth t=kiwi/.test(sndCmds) && /SET AR OK in=12000 out=\d+/.test(sndCmds) && /SET mod=\w+ low_cut=-?\d+ high_cut=-?\d+ freq=[\d.]+/.test(sndCmds), sndCmds.slice(0, 160));
    check('Waterfall socket authenticates and sets its view', /SET auth t=kiwi/.test(received.wf.join()) && /SET zoom=\d+ cf=[\d.]+/.test(received.wf.join(' | ')));
    check('Receiver streams audio and waterfall frames', frames.snd > 10 && frames.wf > 5, JSON.stringify(frames));
    const live = await page.evaluate(() => ({
      status: document.querySelector('#kiwisdr-panel .kiwisdr-status')?.textContent,
      meter: document.querySelector('#kiwisdr-panel .kiwisdr-meter-text')?.textContent,
      lit: (() => {
        const c = document.querySelector('#kiwisdr-panel canvas');
        if (!c) return 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4 * 17) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
        return n;
      })(),
    }));
    check('Player shows a live status and an S-meter reading', /live|listening/i.test(live.status || '') && /S\d|dBm/i.test(live.meter || ''), JSON.stringify({ status: live.status, meter: live.meter }));
    check('Waterfall canvas is actually painted', live.lit > 50, `lit samples: ${live.lit}`);
    // Regression: the box is focused on open and used to stay empty because
    // tuning updates were skipped for any focused input.
    const openFreq = await page.$eval('#kiwisdr-freq', (input) => input.value);
    check('Frequency box is filled in when the player opens', /^\d+(\.\d+)?$/.test(openFreq), `value: "${openFreq}"`);
    // Regression: the bottom command dock used to cover the panel's lower rows.
    const clearance = await page.evaluate(() => {
      const panel = document.querySelector('.kiwisdr-panel')?.getBoundingClientRect();
      const dock = document.querySelector('#command-dock')?.getBoundingClientRect();
      return panel && dock ? { panelBottom: panel.bottom, dockTop: dock.top } : null;
    });
    check('Player panel sits above the bottom dock', !!clearance && clearance.panelBottom <= clearance.dockTop + 1, JSON.stringify(clearance));
    // Regression: the required map attribution row paints over the player (z-index 90).
    const credits = await page.evaluate(() => {
      const panel = document.querySelector('.kiwisdr-panel')?.getBoundingClientRect();
      const credit = document.querySelector('#cesium-credits')?.getBoundingClientRect();
      return panel && credit ? { panelBottom: panel.bottom, creditTop: credit.top } : null;
    });
    check('Player panel sits above the map attribution row', !!credits && credits.panelBottom <= credits.creditTop + 1, JSON.stringify(credits));
    if (process.env.KIWI_QA_STACK) {
      const client = await page.createCDPSession();
      await client.send('Debugger.enable');
      await sleep(6000);
      for (let n = 0; n < 4; n++) {
        const paused = new Promise((resolve) => client.once('Debugger.paused', resolve));
        client.send('Debugger.pause').catch(() => {});
        const ev = await Promise.race([paused, sleep(20000).then(() => null)]);
        if (!ev) { console.log(`  [stack ${n}] no pause within 20s`); continue; }
        console.log(`  [stack ${n}] ` + ev.callFrames.slice(0, 8).map((f) => `${f.functionName || '(anon)'}@${f.url.split('/').slice(-2).join('/')}:${f.location.lineNumber + 1}`).join(' <- '));
        await client.send('Debugger.resume').catch(() => {});
        await sleep(1500);
      }
    }
    // Software-rendered CI browsers can hang when a screenshot is taken while
    // the globe and a live player are both animating, so this one is opt-in.
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS_DIR, '02-player-live.png') });

    // Tune by typing a frequency.
    const before = received.snd.length;
    await page.focus('#kiwisdr-freq');
    await page.$eval('#kiwisdr-freq', (input) => input.select());
    await page.keyboard.type('5000');
    const typed = await page.$eval('#kiwisdr-freq', (input) => input.value);
    await page.keyboard.press('Enter');
    await sleep(600);
    const afterCmds = received.snd.slice(before).join(' | ');
    check(
      'Typing a frequency retunes the receiver',
      /freq=5000\.000/.test(afterCmds),
      `input held "${typed}"; sent: ${afterCmds.slice(0, 120)}`,
    );

    // --- waterfall zoom: wheel at the pointer, click to tune finely, drag to pan
    const overlayBox = async () =>
      page.$eval('.kiwisdr-wf-overlay', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
    const wfCommands = (from) => received.wf.slice(from).join(' | ');
    let box = await overlayBox();
    let mark = received.wf.length;
    await page.mouse.move(box.x + box.w * 0.25, box.y + box.h / 2);
    await sleep(200);
    const hoverTag = await page.$eval('.kiwisdr-hover', (el) => (el.hidden ? null : el.textContent));
    check('Hovering the waterfall shows the frequency under the pointer', /7[.,]?5/.test(hoverTag || '') || /7500/.test(hoverTag || ''), String(hoverTag));
    await page.mouse.wheel({ deltaY: -120 });
    await sleep(700);
    const zoomCmd = wfCommands(mark);
    const zoomMatch = /SET zoom=1 cf=([\d.]+)/.exec(zoomCmd);
    check('Wheel zoom keeps the frequency under the pointer fixed', !!zoomMatch && Math.abs(Number(zoomMatch[1]) - 11250) < 2, zoomCmd.slice(0, 120));
    const zoomLabel = await page.$eval('.kiwisdr-zoom', (el) => el.textContent);
    check('Zoom label shows the factor and the visible span', /×2/.test(zoomLabel) && /MHz|kHz/.test(zoomLabel), zoomLabel);

    mark = received.snd.length;
    box = await overlayBox();
    await page.mouse.click(box.x + box.w * 0.5, box.y + box.h / 2);
    await sleep(500);
    const clickCmds = received.snd.slice(mark).join(' | ');
    check('Clicking the zoomed waterfall tunes to the clicked frequency', /freq=11250\.000/.test(clickCmds), clickCmds.slice(0, 120));

    mark = received.wf.length;
    const sndMark = received.snd.length;
    await page.mouse.move(box.x + box.w * 0.5, box.y + box.h / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + box.w * 0.5 + i * 20, box.y + box.h / 2);
      await sleep(60);
    }
    await page.mouse.up();
    await sleep(500);
    const panCmd = wfCommands(mark);
    const panMatch = [...panCmd.matchAll(/SET zoom=1 cf=([\d.]+)/g)].pop();
    check('Dragging the waterfall pans the view without retuning', !!panMatch && Number(panMatch[1]) < 11250 - 500 && !/freq=/.test(received.snd.slice(sndMark).join(' ')), panCmd.slice(0, 120));

    // --- saved presets (per receiver) and favorites
    await page.evaluate(() => {
      const chip = [...document.querySelectorAll('#kiwisdr-panel .kiwisdr-chip')].find((b) => /Save this/.test(b.textContent));
      chip?.click();
    });
    await sleep(200);
    const savedCount = await page.$$eval('.kiwisdr-saved', (els) => els.length);
    const savedStore = await page.evaluate(() => localStorage.getItem('gev.kiwisdr.v1'));
    check('Saving the current frequency adds a preset chip and persists it', savedCount === 1 && /11250/.test(savedStore || ''), String(savedStore).slice(0, 140));

    await page.click('.kiwisdr-star');
    await sleep(300);
    const starred = await page.$eval('.kiwisdr-star', (el) => el.getAttribute('aria-pressed'));
    const trayText = await page.evaluate(() => document.querySelector('.kiwisdr-favs-toggle')?.textContent || '');
    const ringPoints = await page.evaluate((id) => {
      const prims = window.__godsEyeView.viewer.scene.primitives;
      let n = 0;
      for (let i = 0; i < prims.length; i++) {
        const c = prims.get(i);
        if (c && typeof c.length === 'number' && typeof c.get === 'function') {
          for (let j = 0; j < c.length; j++) if (c.get(j).id === `kiwisdr:${id}`) n++;
        }
      }
      return n;
    }, MOCK.id);
    check('Starring a receiver persists it, adds a map ring and shows the tray', starred === 'true' && /1/.test(trayText) && ringPoints === 2, `starred=${starred} tray="${trayText}" points=${ringPoints}`);

    // --- minimize keeps the audio running
    await page.click('.kiwisdr-minimize');
    await sleep(400);
    const dockedState = await page.evaluate(() => {
      const panel = document.getElementById('kiwisdr-panel');
      const body = panel.querySelector('.kiwisdr-body');
      return { docked: panel.dataset.docked, bodyShown: getComputedStyle(body).display !== 'none', mini: getComputedStyle(panel.querySelector('.kiwisdr-mini')).display !== 'none', height: panel.getBoundingClientRect().height };
    });
    const dockedFrames = frames.snd;
    await sleep(1200);
    check('Minimizing docks the player into a slim bar', dockedState.docked === 'true' && !dockedState.bodyShown && dockedState.mini && dockedState.height < 120, JSON.stringify(dockedState));
    check('Audio keeps streaming while the player is docked', frames.snd - dockedFrames > 15, `${frames.snd - dockedFrames} frames in 1.2s`);
    await page.click('.kiwisdr-minimize');
    await sleep(300);
    check('Expanding the docked player brings the controls back', await page.evaluate(() => {
      const panel = document.getElementById('kiwisdr-panel');
      return panel.dataset.docked === 'false' && getComputedStyle(panel.querySelector('.kiwisdr-body')).display !== 'none';
    }));

    // Closing the panel must drop both sockets.
    await page.evaluate(() => document.querySelector('#kiwisdr-panel .kiwisdr-close')?.click());
    const sndAtClose = frames.snd;
    await sleep(1200);
    const panelGone = await page.evaluate(() => {
      const el = document.getElementById('kiwisdr-panel');
      return !el || el.hidden || getComputedStyle(el).display === 'none';
    });
    check('Closing the panel hides it', panelGone);
    check('Closing the panel stops the stream', frames.snd - sndAtClose <= 3, `${frames.snd - sndAtClose} extra frames`);

    // Presets and favorites survive closing and reopening the receiver.
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#kiwisdr-panel', { visible: true, timeout: 10_000 }).catch(() => {});
    await sleep(500);
    const again = await page.evaluate(() => ({
      saved: document.querySelectorAll('.kiwisdr-saved').length,
      star: document.querySelector('.kiwisdr-star')?.getAttribute('aria-pressed'),
    }));
    check('Reopening a receiver restores its saved frequencies and star', again.saved === 1 && again.star === 'true', JSON.stringify(again));
    await page.evaluate(() => document.querySelector('#kiwisdr-panel .kiwisdr-close')?.click());
    await sleep(300);

    // A full receiver is explained, not silently dead.
    const fullAt = await aim(FULL);
    await page.mouse.click(fullAt.x, fullAt.y);
    await page.waitForFunction(
      () => /in use|busy|full/i.test(document.getElementById('kiwisdr-panel')?.textContent || ''),
      { timeout: 15_000 },
    ).catch(() => {});
    const fullText = await page.evaluate(() => document.getElementById('kiwisdr-panel')?.textContent || '');
    check('A full receiver is reported plainly', /in use|busy|full/i.test(fullText), fullText.replace(/\s+/g, ' ').slice(0, 140));
    await page.screenshot({ path: path.join(SHOTS_DIR, '03-full-receiver.png') });

    // Disable removes the markers and the panel.
    await page.evaluate(() => window.__godsEyeView.dataManager.toggle('kiwisdr'));
    await sleep(500);
    check('Disabling the layer turns it off and closes the player', await page.evaluate(() => {
      const el = document.getElementById('kiwisdr-panel');
      return !window.__godsEyeView.dataManager.isEnabled('kiwisdr') && (!el || el.hidden || getComputedStyle(el).display === 'none');
    }));

    const relevant = consoleErrors.filter((e) => !/api\.cesium\.com|ERR_(INTERNET|NAME|CONNECTION|BLOCKED)|Failed to load resource|net::|kiwi\.example\.test|ResizeObserver/i.test(e));
    check('Console stays free of errors', relevant.length === 0, relevant.slice(0, 3).join(' || '));
  } finally {
    await browser.close();
    for (const s of servers) s.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
