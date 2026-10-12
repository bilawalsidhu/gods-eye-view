/** Fixture-only desktop/mobile gate. No paid calls or real news queries.
 * PUPPETEER_EXECUTABLE_PATH="installed browser executable" node scripts/qa-sun-news.mjs
 * Optional: --url http://127.0.0.1:4173 --screenshots-dir qa-shots/sun-news --json qa-shots/sun-news/report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const args = process.argv.slice(2),
  arg = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = arg('--url', 'http://127.0.0.1:4173'),
  out = path.resolve(arg('--screenshots-dir', 'qa-shots/sun-news')),
  json = path.resolve(arg('--json', path.join(out, 'report.json')));
fs.mkdirSync(out, { recursive: true });
const report = {
  checks: [],
  errors: [],
  newsRequests: 0,
  paidRequests: 0,
  fixtureOnly: true,
};
const check = (name, ok) => {
  report.checks.push({ name, ok });
  assert.ok(ok, name);
  console.log('PASS ' + name);
};
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  headless: !args.includes('--headful'),
  args: ['--no-first-run', '--no-default-browser-check'],
});
let mode = 'success',
  held = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (
      u.pathname.startsWith('/api/openai/') ||
      u.pathname === '/api/realtime/token' ||
      (u.pathname === '/api/camera-reconstruction' && r.method() === 'POST')
    ) {
      void r.respond({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Paid requests disabled during QA"}',
      });
      return;
    }
    if (u.pathname === '/api/area-news') {
      report.newsRequests++;
      if (mode === 'hold') {
        held.push(r);
        return;
      }
      const request = JSON.parse(r.postData()),
        seenAt = new Date(Date.now() - 3600000).toISOString();
      const articles =
        mode === 'empty'
          ? []
          : [
              {
                url: 'https://publisher.example/synthetic-story',
                title:
                  'Synthetic place-name match <img src=x onerror=alert(1)>',
                publisher: 'publisher.example',
                seenAt,
                placement: 'unverified-place-name-match',
              },
            ];
      void r.respond({
        status: mode === 'failure' ? 503 : mode === 'limited' ? 429 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          mode === 'failure'
            ? { error: 'Fixture provider unavailable' }
            : mode === 'limited'
              ? { error: 'Fixture rate limit', retryAfterSeconds: 120 }
              : {
                  articles,
                  request,
                  queriedAt: new Date().toISOString(),
                  limited: false,
                },
        ),
      });
      return;
    }
    void r.continue();
  });
  await page.setViewport({ width: 1400, height: 950 });
  await page.goto(url + '/?welcome=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!window.__godsEyeView?.styleManager?._sunNewsTools?.dialog,
    { timeout: 60000 },
  );
  check(
    'tools stay opt-in on startup',
    await page.evaluate(() => !document.querySelector('#sun-news-tools').open),
  );
  for (const [width, height, mobile] of [
    [1400, 950, false],
    [412, 915, true],
    [844, 320, true],
  ]) {
    await page.setViewport({
      width,
      height,
      isMobile: mobile,
      hasTouch: mobile,
    });
    // Changing mobile/touch emulation can reload the document in Puppeteer.
    await page.waitForFunction(
      () => !!window.__godsEyeView?.styleManager?._sunNewsTools?.dialog,
      { timeout: 60000 },
    );
    if (mobile)
      await page.evaluate(() => {
        const m = window.__godsEyeView.styleManager._mobileMenu;
        m.open();
        m.sections.get('view').details.open = true;
      });
    await page.evaluate(() =>
      document.querySelector('#sun-news-tools-btn').click(),
    );
    check(
      'dialog opens and menu releases ' + width,
      await page.evaluate(
        () =>
          document.querySelector('#sun-news-tools').open &&
          !document.querySelector('#mobile-map-menu').open,
      ),
    );
    await page.evaluate(() => {
      const t = window.__godsEyeView.styleManager._sunNewsTools;
      t.field('lat').value = '51.5';
      t.field('lon').value = '0';
      t.field('zone').value = 'UTC';
      t.field('instant').value = '2026-06-21T12:00';
      t.computeSun();
    });
    check(
      'local sun output and owned shadow entities ' + width,
      await page.evaluate(() => {
        const t = window.__godsEyeView.styleManager._sunNewsTools;
        return (
          t.lastSun?.altitudeDeg > 60 &&
          Number(t.field('minute').value) === 720 &&
          t.source.entities.values.filter((e) => e.analysisGroup === 'sun')
            .length === 2
        );
      }),
    );
    await page.evaluate(() => {
      const t = window.__godsEyeView.styleManager._sunNewsTools;
      t.setArea({ west: -98, south: 30, east: -97, north: 31 });
      t.field('place').value = 'Austin';
    });
    mode = 'success';
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.searchNews(),
    );
    check(
      'source-linked cards, explicit spatial limitation, no substituted pins ' +
        width,
      await page.evaluate(() => {
        const t = window.__godsEyeView.styleManager._sunNewsTools;
        return (
          t.dialog
            .querySelector('[data-news-results] a')
            ?.rel.includes('noopener') &&
          !t.dialog.querySelector('[data-news-results] img') &&
          !t.source.entities.values.some((e) => e.analysisGroup === 'news') &&
          t.dialog.textContent.includes('not verified spatial filtering')
        );
      }),
    );
    check(
      'date labels identify GDELT seen time ' + width,
      await page.evaluate(() =>
        document
          .querySelector('[data-news-results]')
          .textContent.includes('GDELT seen'),
      ),
    );
    const geometry = await page.evaluate(() => {
      const d = document.querySelector('#sun-news-tools'),
        r = d.getBoundingClientRect();
      return {
        width: r.width,
        inside: r.left >= 0 && r.right <= innerWidth + 1,
        scroll: d.scrollHeight > d.clientHeight,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    check(
      'dialog fits and scrolls on short screens ' + width,
      geometry.inside &&
        geometry.overflow <= 0 &&
        (height > 400 || geometry.scroll),
    );
    await page.evaluate(() => {
      const headline = document.querySelector('[data-news-results] a');
      if (headline)
        headline.textContent = 'Synthetic example: local weather report';
    });
    await page.screenshot({ path: path.join(out, `sun-news-${width}.png`) });
    await page.evaluate(() => {
      const t = window.__godsEyeView.styleManager._sunNewsTools;
      t.field('topic').value = 'changed';
      t.field('topic').dispatchEvent(new Event('input', { bubbles: true }));
    });
    check(
      'changed inputs mark earlier cards stale ' + width,
      await page.evaluate(
        () => !document.querySelector('[data-news-stale]').hidden,
      ),
    );
    mode = 'failure';
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.searchNews(),
    );
    check(
      'failure retains labeled stale cards ' + width,
      await page.evaluate(
        () =>
          document
            .querySelector('[data-news-status]')
            .textContent.includes('No fresh results') &&
          !document.querySelector('[data-news-stale]').hidden &&
          document.querySelectorAll('[data-news-results] li').length === 1,
      ),
    );
    mode = 'empty';
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.searchNews(),
    );
    check(
      'verified empty fixture clears old cards ' + width,
      await page.evaluate(
        () =>
          document.querySelectorAll('[data-news-results] li').length === 0 &&
          document
            .querySelector('[data-news-status]')
            .textContent.startsWith('0 place-name matches'),
      ),
    );
    mode = 'hold';
    const pending = page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.searchNews(),
    );
    await page.waitForFunction(
      () => !!window.__godsEyeView.styleManager._sunNewsTools.request,
    );
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.action('cancel-news'),
    );
    for (const r of held.splice(0)) await r.abort().catch(() => {});
    await pending;
    check(
      'cancel releases request ownership ' + width,
      await page.evaluate(
        () => !window.__godsEyeView.styleManager._sunNewsTools.request,
      ),
    );
    await page.evaluate(() =>
      window.__godsEyeView.styleManager._sunNewsTools.pick('sun'),
    );
    check(
      'point pick releases modal and owns pointer ' + width,
      await page.evaluate(async () => {
        const m = await import('/src/data/inputOwnership.js');
        return (
          !document.querySelector('#sun-news-tools').open &&
          m.pointerOwner() === 'sun-news-tools'
        );
      }),
    );
    await page.keyboard.press('Escape');
    check(
      'Escape releases pointer and restores dialog ' + width,
      await page.evaluate(async () => {
        const m = await import('/src/data/inputOwnership.js');
        return (
          m.isPointerFree() && document.querySelector('#sun-news-tools').open
        );
      }),
    );
    await page.keyboard.press('Escape');
    check(
      'Escape closes dialog ' + width,
      await page.evaluate(
        () => !document.querySelector('#sun-news-tools').open,
      ),
    );
  }
  mode = 'limited';
  await page.evaluate(() => {
    const t = window.__godsEyeView.styleManager._sunNewsTools;
    t.open();
    return t.searchNews();
  });
  const count = report.newsRequests;
  await page.evaluate(() =>
    window.__godsEyeView.styleManager._sunNewsTools.searchNews(),
  );
  check(
    'Retry-After prevents repeated requests',
    report.newsRequests === count,
  );
  await page.evaluate(() => {
    const t = window.__godsEyeView.styleManager._sunNewsTools;
    t.action('clear-sketches');
    t.close();
  });
  check(
    'clearing sketches releases owned entities',
    await page.evaluate(
      () =>
        window.__godsEyeView.styleManager._sunNewsTools.source.entities.values
          .length === 0,
    ),
  );
  check('no page errors', report.errors.length === 0);
} catch (e) {
  report.fatal = e.name + ': ' + e.message;
  console.error(report.fatal);
  process.exitCode = 1;
} finally {
  await browser.close();
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      passed: report.checks.filter((c) => c.ok).length,
      fatal: report.fatal,
      errors: report.errors,
    }),
  );
}
