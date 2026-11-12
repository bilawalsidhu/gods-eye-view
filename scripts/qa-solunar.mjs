#!/usr/bin/env node
/**
 * Rendered proof for the SOLUNAR rail card.
 * QA_BASE_URL (default http://127.0.0.1:4392) must serve the app. Drives a real
 * browser at desktop (1600x900) and phone (390x844) size: opens the SOLUNAR
 * dock card, points the camera at Lake Bob Sandlin (33.05, -95.1), clicks the
 * map, and checks the 7-day list, moon-event rows, the 12/24 h switch, the
 * rating rule text and filtered console errors. Screenshots go to
 * QA_OUT_DIR (default ./qa-artifacts-solunar).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { makeRedactor, urlSecrets } from './qa-solunar-redact.mjs';

const appUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4392';
const outDir = path.resolve(process.env.QA_OUT_DIR || 'qa-artifacts-solunar');
// Browser and filesystem exceptions may contain arbitrary secrets; never print them.
const fatal = () => {
  console.error('[qa-solunar] unable to complete browser checks');
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
fs.mkdirSync(outDir, { recursive: true });
const redact = makeRedactor(urlSecrets(appUrl));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok) => {
  console.log(redact(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`));
  if (!ok) failures.push(name);
};

const browser = await puppeteer.launch({
  headless: 'new',
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});

async function run(label, viewport, { touch = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ ...viewport, hasTouch: touch, isMobile: touch });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.getElementById('solunar-panel') &&
      document.getElementById('solunar-panel').dataset.solunarMounted === '1' &&
      window.__godsEyeView?.viewer,
    { timeout: 240000 },
  );
  await sleep(Number(process.env.QA_SETTLE_MS || 8000));
  await page.keyboard.press('Escape');
  const mobile = await page.evaluate(() =>
    document.body.classList.contains('mobile-shell'),
  );
  if (mobile) {
    await page.click('.mobile-tab[data-mobile-sheet="context"]');
    await sleep(600);
  }
  const closed = await page.evaluate(() => {
    const card = document.getElementById('solunar-panel');
    return {
      collapsed: card.classList.contains('collapsed'),
      title: card.querySelector('.panel-title')?.textContent.trim(),
      dock: [
        ...document.querySelectorAll('.gev-panel-rail--right [data-rail-item]'),
      ].map((b) => b.getAttribute('data-rail-item')),
    };
  });
  check(
    `${label}: the SOLUNAR menu item exists, collapsed`,
    closed.collapsed && closed.title === 'SOLUNAR',
    closed.title,
  );
  if (!mobile) {
    const ids = closed.dock;
    const required = ['cctv-panel', 'solunar-panel', 'street-level-panel'];
    const missing = required.filter((id) => ids.indexOf(id) < 0);
    check(
      `${label}: rail button sits between CCTV and STREET LEVEL`,
      missing.length === 0 &&
        ids.indexOf('cctv-panel') + 1 === ids.indexOf('solunar-panel') &&
        ids.indexOf('solunar-panel') + 1 === ids.indexOf('street-level-panel'),
      missing.length
        ? `missing: ${missing.join(', ')}`
        : required.map((id) => `${id}: ${ids.indexOf(id)}`).join(', '),
    );
  }
  // Lake Bob Sandlin from 15 km up, looking straight down
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const C = viewer.camera;
    C.setView({
      destination: {
        x: 0,
        y: 0,
        z: 0,
        ...(() => {
          const lat = (33.05 * Math.PI) / 180;
          const lon = (-95.1 * Math.PI) / 180;
          const a = 6378137.0;
          const e2 = 0.00669437999014;
          const h = 15000;
          const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
          return {
            x: (n + h) * Math.cos(lat) * Math.cos(lon),
            y: (n + h) * Math.cos(lat) * Math.sin(lon),
            z: (n * (1 - e2) + h) * Math.sin(lat),
          };
        })(),
      },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  });
  await sleep(1500);
  if (mobile) {
    await page.waitForSelector('#solunar-panel', {
      visible: true,
      timeout: 30000,
    });
    await page.click('#solunar-panel .panel-collapse-btn');
  } else {
    await page.click('[data-rail-item="solunar-panel"]');
  }
  await sleep(1500);
  await page.waitForSelector('#solunar-panel:not(.collapsed)', {
    visible: true,
    timeout: 30000,
  });
  const opened = await page.evaluate(() => {
    const body = document.getElementById('gev-solunar-body');
    const card = document.getElementById('solunar-panel');
    const spot = body.querySelector('.gev-sl-spot')?.textContent ?? '';
    const days = [...body.querySelectorAll('.gev-sl-day')].map((d) => ({
      date: d.dataset.date,
      moonrise: d.querySelector('.gev-sl-moonrise .gev-sl-value')?.textContent,
      moonset: d.querySelector('.gev-sl-moonset .gev-sl-value')?.textContent,
      major: d.querySelector('.gev-sl-major .gev-sl-value')?.textContent,
      minor: d.querySelector('.gev-sl-minor .gev-sl-value')?.textContent,
      sunrise: d.querySelector('.gev-sl-sunrise .gev-sl-value')?.textContent,
      phase: d.querySelector('.gev-sl-phase')?.textContent,
      hunting: d.querySelector('.gev-sl-hunting')?.dataset.stars,
      fishing: d.querySelector('.gev-sl-fishing')?.dataset.stars,
    }));
    return {
      collapsed: card.classList.contains('collapsed'),
      spot,
      days,
      rule: body.querySelector('.gev-sl-rule')?.textContent ?? '',
      dot: Boolean(
        window.__godsEyeView.viewer.entities.getById('gev-solunar-spot'),
      ),
      overflow: document.documentElement.scrollWidth > innerWidth,
      inView: (() => {
        const r = body.querySelector('.gev-sl-day')?.getBoundingClientRect();
        return Boolean(r && r.width > 0 && r.height > 0);
      })(),
    };
  });

  check(`${label}: the card opens`, !opened.collapsed && opened.inView);
  check(
    `${label}: default spot is the map centre (Lake Bob Sandlin 33.05,-95.1)`,
    /^33\.0[0-9]{2}°N 95\.[01][0-9]{2}°W · America\/Chicago$/.test(opened.spot),
    opened.spot,
  );
  check(`${label}: seven days listed`, opened.days.length === 7);
  check(
    `${label}: every day has windows, sun times and 1-4 star ratings`,
    opened.days.every(
      (d) =>
        d.major &&
        d.minor &&
        d.sunrise &&
        d.sunrise !== 'none' &&
        d.hunting >= 1 &&
        d.hunting <= 4 &&
        d.fishing >= 1 &&
        d.fishing <= 4,
    ),
  );
  check(
    `${label}: every day shows moonrise and moonset rows`,
    opened.days.every((d) => Boolean(d.moonrise && d.moonset)),
    opened.days.map((d) => `${d.date}:${d.moonrise}/${d.moonset}`).join(' '),
  );
  check(
    `${label}: the rating rule is on the card`,
    /new or full moon within 1 day = 2 points/.test(opened.rule) &&
      /at least 1 and at most 4/.test(opened.rule),
  );
  check(`${label}: a dot marks the spot on the map`, opened.dot);
  check(`${label}: no horizontal overflow`, !opened.overflow);
  await page.screenshot({ path: path.join(outDir, `${label}-open.png`) });
  if (mobile) {
    const layout = await page.evaluate(() => {
      const panel = document.getElementById('solunar-panel');
      const inner = panel.querySelector('.solunar-panel-inner');
      const rect = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.bottom + 8,
      );
      inner.scrollTop = inner.scrollHeight;
      const last = [...inner.querySelectorAll('.gev-sl-day')].at(-1);
      const lastRect = last?.getBoundingClientRect();
      const innerRect = inner.getBoundingClientRect();
      return {
        contained: panel.scrollHeight <= panel.clientHeight + 1,
        hitOutside: Boolean(hit && !panel.contains(hit)),
        scrollable: inner.scrollTop > 0,
        lastVisible: Boolean(
          lastRect &&
          lastRect.bottom <= innerRect.bottom + 1 &&
          lastRect.bottom > innerRect.top,
        ),
      };
    });
    check(
      `${label}: content stays inside SOLUNAR`,
      layout.contained && layout.hitOutside,
      JSON.stringify(layout),
    );
    check(
      `${label}: final day reachable by scrolling`,
      layout.scrollable && layout.lastVisible,
      JSON.stringify(layout),
    );
  }

  // click the map (desktop: away from the right rail) and the spot follows
  if (!mobile) {
    const target = { x: 500, y: 300 };
    await page.mouse.click(target.x, target.y);
    await sleep(800);
    const moved = await page.evaluate(() => ({
      spot: document.querySelector('#gev-solunar-body .gev-sl-spot')
        .textContent,
      days: document.querySelectorAll('#gev-solunar-body .gev-sl-day').length,
    }));
    check(
      `${label}: a click on the map moves the spot`,
      moved.spot !== opened.spot && moved.days === 7,
      `${opened.spot} -> ${moved.spot}`,
    );
    // 12/24 h
    await page.evaluate(() =>
      document.querySelector('.gev-sl-clock[data-hour12="false"]').click(),
    );
    const t24 = await page.evaluate(
      () => document.querySelector('.gev-sl-sunrise .gev-sl-value').textContent,
    );
    check(`${label}: 24 h switch`, /^\d\d:\d\d$/.test(t24), t24);
    await page.evaluate(() =>
      document.querySelector('.gev-sl-clock[data-hour12="true"]').click(),
    );
    await page.screenshot({ path: path.join(outDir, `${label}-clicked.png`) });
  }
  const real = errors.filter(
    (e) => !/favicon|Failed to load resource|net::ERR|403|401|404|429/.test(e),
  );
  check(
    `${label}: no console errors`,
    real.length === 0,
    redact(real.slice(0, 3).join(' | ')),
  );
  await context.close();
}

try {
  await run('desktop', { width: 1600, height: 900 });
  await run('phone', { width: 390, height: 844 }, { touch: true });
} catch (e) {
  fatal(e);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(
    redact(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`),
  );
  process.exit(1);
}
console.log('\nqa-solunar: all checks passed');
