#!/usr/bin/env node
/**
 * The "kept in the link" notice on an engine that lacks a linked layer
 * (T8-T9 review item 2). A Cesium page's share link, with its layer field
 * set to --tokens (default `e`: earthquakes, which Navara lacks), is opened
 * with ?engine=navara, and the top status notice is read over time:
 * the NOT ON THIS ENGINE notice must name the layer and stay readable for
 * at least 14 s, then the engine's own persistent notice must come back.
 *
 *   node scripts/qa-engine-notice.mjs --base-url=http://localhost:PORT/
 *     [--tokens=e]
 *
 * The server is the caller's (never ports 4185-4189). Headless only. Exits 1
 * on a failed check.
 */
import puppeteer from 'puppeteer';

const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const baseUrl = argument('base-url');
const tokens = argument('tokens') ?? 'e';
if (!baseUrl) {
  console.error('--base-url=URL is required');
  process.exit(2);
}
if ([4185, 4186, 4187, 4188, 4189].includes(Number(new URL(baseUrl).port))) {
  console.error('ports 4185-4189 are reserved');
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

async function boot(browser, url, { waitForApp = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  if (!waitForApp) return page;
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90_000,
  });
  return page;
}

const notice = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('global-loading-status');
    return {
      hidden: !host || host.hidden,
      detail:
        document.getElementById('global-loading-detail')?.textContent ?? '',
    };
  });

const browser = await puppeteer.launch({ headless: true });
try {
  const cesium = await boot(browser, baseUrl);
  await sleep(2500); // the share hash is written on a debounce
  const shared = new URLSearchParams(
    (await cesium.evaluate(() => location.hash)).slice(1),
  );
  check('the Cesium page writes a v2 share link', shared.get('v') === '2');
  shared.set('l', tokens);
  const hash = `#${shared.toString()}`;
  await cesium.close();

  const url = new URL(baseUrl);
  url.searchParams.set('engine', 'navara');
  url.hash = hash;
  // Read the notice from the start: it may come up before the app's debug
  // handle does.
  const navara = await boot(browser, url.toString(), { waitForApp: false });
  let shownAt = null;
  const deadline = Date.now() + 60_000;
  let first = null;
  while (Date.now() < deadline) {
    const now = await notice(navara).catch(() => ({ hidden: true }));
    if (!now.hidden && /Kept in the link/.test(now.detail)) {
      shownAt = Date.now();
      first = now;
      break;
    }
    await sleep(200);
  }
  check(
    'the NOT ON THIS ENGINE notice appears and names the layer',
    Boolean(first),
    first ? first.detail : 'never shown',
  );
  if (first) {
    await sleep(Math.max(0, shownAt + 14_000 - Date.now()));
    const later = await notice(navara);
    check(
      'it is still up 14 s later',
      !later.hidden && /Kept in the link/.test(later.detail),
      later.detail,
    );
    await sleep(Math.max(0, shownAt + 17_000 - Date.now()));
    const after = await notice(navara);
    check(
      'then the engine notice comes back',
      !after.hidden &&
        /engine|Data layers/i.test(after.detail) &&
        !/Kept in the link/.test(after.detail),
      after.detail,
    );
  }
} finally {
  await browser.close();
}
const failed = results.filter((pass) => !pass).length;
console.log(
  `[engine-notice] ${results.length - failed}/${results.length} pass`,
);
process.exit(failed ? 1 : 0);
