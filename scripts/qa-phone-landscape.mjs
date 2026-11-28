// Phone landscape QA: the shell gate, the tab bar, every sheet and the dock
// at phone, landscape-phone, tablet and desktop sizes, against a running
// preview (QA_URL, default http://127.0.0.1:4173). Screenshots and the
// measured geometry land in qa-shots/phone-landscape/.
//
//   node scripts/qa-phone-landscape.mjs [before|after]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const phase = process.argv[2] || 'after';
assert.ok(['before', 'after'].includes(phase));
const url = process.env.QA_URL || 'http://127.0.0.1:4173';
const directory = new URL('../qa-shots/phone-landscape/', import.meta.url);
await fs.mkdir(directory, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Voice Settings is store-backed: open and close it through its owner, not
// by unhiding DOM.
const showSettings = async (page, open) => {
  const result = await page.evaluate(
    (open) =>
      window.__gevVoiceCommands
        .captureVoicePanelOperation()
        .show('settings', open),
    open,
  );
  assert.equal(result.ok, true);
  if (open) await page.waitForSelector('#gev-voice-panel', { visible: true });
  await pause(300);
};
const measure = (page) =>
  page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (
        !el ||
        !el.getClientRects().length ||
        getComputedStyle(el).display === 'none'
      )
        return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        bottom: r.bottom,
        right: r.right,
      };
    };
    return {
      mobile: document.body.classList.contains('mobile-shell'),
      tab: box('#mobile-tab-bar'),
      dock: box('#command-dock'),
      omnibar: box('#gev-omnibar'),
      voicePanel: box('#gev-voice-panel'),
      hud: [...document.querySelectorAll('#intel-hud > div')].map((el) => ({
        class: el.className,
        display: getComputedStyle(el).display,
      })),
    };
  });
const ready = async (page) => {
  await page.waitForFunction(() => !!window.__godsEyeView?.styleManager, {
    timeout: 90000,
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.getElementById('loading-screen')).opacity ===
      '0',
  );
  await pause(3000);
};

try {
  for (const [width, height] of [
    [844, 390],
    [932, 430],
    [667, 375],
    [390, 844],
    [390, 500],
    [320, 568],
    [1280, 800],
    [1024, 768],
    [1366, 1024],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
      // The Stories promo would cover the layer under test.
      localStorage.setItem('gevStoriesPopSeen', '1');
    });
    await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.screenshot({
      path: new URL(`${phase}-${width}x${height}.png`, directory).pathname,
    });
    const state = await measure(page);
    results.push({ width, height, ...state });
    if (phase === 'after') {
      const phone = width <= 720 || (width <= 1023 && height <= 520);
      const landscape = phone && height <= 520 && width > height;
      assert.equal(state.mobile, phone, `${width}x${height}: shell gate`);
      if (phone) {
        assert.ok(
          state.hud
            .filter((item) => item.class !== 'hud-sonar')
            .every((item) => item.display === 'none'),
          'the compact phone HUD is reused',
        );
        assert.ok(state.tab && state.tab.bottom <= height + 1);
        assert.equal(state.tab.height, landscape ? 48 : 58, 'tab bar height');
        assert.ok(state.dock, `${width}x${height}: dock shown`);
        assert.ok(
          state.dock.bottom <= state.tab.y,
          'the dock sits above the tab bar',
        );
        assert.ok(
          state.dock.x >= 0 && state.dock.right <= width + 1,
          'the dock fits the screen',
        );
        if (landscape) {
          assert.ok(
            state.dock.width <= 561,
            `landscape dock keeps a desktop-like width (${state.dock.width})`,
          );
          assert.ok(
            Math.abs(state.dock.x + state.dock.width / 2 - width / 2) <= 2,
            'landscape dock is centred',
          );
        }
        await showSettings(page, true);
        const open = await measure(page);
        await page.screenshot({
          path: new URL(`${phase}-${width}x${height}-voice.png`, directory)
            .pathname,
        });
        assert.ok(
          open.voicePanel &&
            open.voicePanel.y >= 0 &&
            open.voicePanel.x >= 0 &&
            open.voicePanel.right <= width + 1 &&
            open.voicePanel.bottom <= open.dock.y + 1,
          `Voice Settings sits above the dock: ${JSON.stringify(open)}`,
        );
        if (landscape)
          assert.ok(
            open.voicePanel.width <= open.dock.width + 1,
            'landscape Voice Settings is no wider than the dock',
          );
        results.push({ width, height, voiceSettings: open.voicePanel });
        await showSettings(page, false);
        const sheets = await page.$$eval(
          '.mobile-tab[data-mobile-sheet]',
          (tabs) =>
            tabs
              .filter((tab) => getComputedStyle(tab).display !== 'none')
              .map((tab) => tab.dataset.mobileSheet),
        );
        assert.ok(sheets.length >= 4, `tabs: ${sheets}`);
        for (const sheet of sheets) {
          await page.click(`.mobile-tab[data-mobile-sheet="${sheet}"]`);
          await pause(400);
          const geometry = await page.evaluate(() => {
            const visible = (el) =>
              el &&
              getComputedStyle(el).display !== 'none' &&
              el.getBoundingClientRect().height > 0;
            const tabTop = document
              .getElementById('mobile-tab-bar')
              .getBoundingClientRect().top;
            const containers = ['left-panel-stack', 'right-context-rail']
              .map((id) => document.getElementById(id))
              .filter(visible)
              .map((el) => {
                const r = el.getBoundingClientRect();
                const before = el.scrollTop;
                el.scrollTop = el.scrollHeight;
                const scrolls =
                  el.scrollHeight <= el.clientHeight + 1 ||
                  el.scrollTop > before;
                el.scrollTop = 0;
                return {
                  id: el.id,
                  top: r.top,
                  bottom: r.bottom,
                  left: r.left,
                  right: r.right,
                  scrolls,
                  horizontalOverflow: el.scrollWidth - el.clientWidth,
                };
              });
            return {
              sheet: document.body.dataset.mobileSheet,
              tabTop,
              containers,
              selected: document.querySelectorAll(
                '.mobile-tab[aria-expanded="true"]',
              ).length,
              dockHidden: !visible(document.getElementById('command-dock')),
              corner: (() => {
                const shown = [
                  document.getElementById('corner-actions'),
                  document.getElementById('hStories'),
                ].filter(
                  (el) => el && getComputedStyle(el).visibility !== 'hidden',
                );
                return shown.length
                  ? Math.max(
                      ...shown.map((el) => el.getBoundingClientRect().bottom),
                    )
                  : null;
              })(),
            };
          });
          assert.equal(geometry.sheet, sheet);
          assert.equal(geometry.selected, 1);
          assert.ok(geometry.dockHidden, 'an open sheet puts the dock away');
          assert.ok(geometry.containers.length > 0, `${sheet}: a sheet shows`);
          for (const c of geometry.containers) {
            assert.ok(
              c.top >= 0 &&
                c.bottom <= geometry.tabTop + 1 &&
                c.left >= 0 &&
                c.right <= width + 1,
              JSON.stringify(geometry),
            );
            // Portrait keeps main's corner placement.
            if (landscape && geometry.corner !== null)
              assert.ok(
                geometry.corner <= c.top + 1,
                `${sheet}: the corner buttons clear the sheet`,
              );
            if (landscape)
              assert.ok(
                c.top >= 40,
                `${sheet}: some globe stays visible above the sheet`,
              );
            assert.ok(c.scrolls, `${c.id} scrolls to its content`);
            assert.ok(
              c.horizontalOverflow <= 1,
              `${c.id} has no horizontal overflow`,
            );
          }
          results.push({ width, height, ...geometry });
          await page.screenshot({
            path: new URL(`${phase}-${width}x${height}-${sheet}.png`, directory)
              .pathname,
          });
          await page.click(`.mobile-tab[data-mobile-sheet="${sheet}"]`);
          await pause(200);
        }
        // Leaving the phone shell and coming back opens no sheet.
        await page.click(`.mobile-tab[data-mobile-sheet="${sheets[0]}"]`);
        await page.setViewport({ width: 1280, height: 800 });
        await page.waitForFunction(
          () => !document.body.classList.contains('mobile-shell'),
        );
        assert.equal(
          await page.$eval('body', (el) =>
            el.hasAttribute('data-mobile-sheet'),
          ),
          false,
        );
        await page.setViewport({ width, height });
        await page.waitForFunction(() =>
          document.body.classList.contains('mobile-shell'),
        );
        assert.equal(
          await page.$eval('body', (el) =>
            el.hasAttribute('data-mobile-sheet'),
          ),
          false,
        );
      }
    }
    await page.close();
  }
  if (phase === 'after') {
    const page = await browser.newPage();
    await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__godsEyeView?.styleManager, {
      timeout: 90000,
    });
    // The gate's boundaries: narrow, or short and not wider than a tablet.
    for (const [width, height, expected] of [
      [720, 844, true],
      [721, 844, false],
      [932, 520, true],
      [932, 521, false],
      [1023, 520, true],
      [1024, 520, false],
      [1280, 390, false],
    ]) {
      await page.setViewport({ width, height });
      await page.waitForFunction(
        (expected) =>
          document.body.classList.contains('mobile-shell') === expected,
        {},
        expected,
      );
      results.push({ width, height, phoneShell: expected });
    }
    // Simulated notches on both sides and a home indicator.
    await page.setViewport({ width: 844, height: 390, hasTouch: true });
    await page.waitForFunction(() =>
      document.body.classList.contains('mobile-shell'),
    );
    await ready(page);
    await page.evaluate(() => {
      document.body.style.setProperty('--mobile-left-inset', '44px');
      document.body.style.setProperty('--mobile-right-inset', '44px');
      document.body.style.setProperty('--mobile-bottom-inset', '21px');
    });
    await pause(300);
    await showSettings(page, true);
    const notched = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return {
        panelLeft: r('gev-voice-panel').left,
        panelRight: r('gev-voice-panel').right,
        tabHeight: r('mobile-tab-bar').height,
        logoLeft: document
          .querySelector('#title-bar .title-logo')
          .getBoundingClientRect().left,
      };
    });
    assert.ok(
      notched.panelLeft >= 44 && notched.panelRight <= 800,
      `Voice Settings clears both notches: ${JSON.stringify(notched)}`,
    );
    assert.equal(notched.tabHeight, 69);
    assert.ok(notched.logoLeft >= 44, 'the logo clears the left notch');
    results.push({ simulatedNotches: notched });
    await page.screenshot({
      path: new URL('after-844x390-notches.png', directory).pathname,
    });
    await showSettings(page, false);
    await page.click('.mobile-tab[data-mobile-sheet="more"]');
    await pause(300);
    const padding = await page.$eval('#left-panel-stack', (el) => ({
      left: parseFloat(getComputedStyle(el).paddingLeft),
      right: parseFloat(getComputedStyle(el).paddingRight),
    }));
    assert.equal(padding.left, 54);
    assert.equal(padding.right, 54);
    await page.screenshot({
      path: new URL('after-844x390-more-notches.png', directory).pathname,
    });
    await page.close();
  }
} finally {
  await fs.writeFile(
    new URL(`${phase}-geometry.json`, directory),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
console.log(
  `${phase}: ${results.length} viewport/sheet checks captured in ${directory.pathname}`,
);
