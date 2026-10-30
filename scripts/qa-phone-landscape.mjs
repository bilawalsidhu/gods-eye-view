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
try {
  for (const [width, height] of [
    [844, 390],
    [932, 430],
    [667, 375],
    [390, 844],
    [320, 568],
    [1280, 800],
    [1024, 768],
    [1366, 1024],
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    });
    await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__godsEyeView?.styleManager, {
      timeout: 90000,
    });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.getElementById('loading-screen')).opacity ===
        '0',
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await page.focus('#gev-voice-provider');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({
      path: new URL(`${phase}-${width}x${height}.png`, directory).pathname,
    });
    const state = await page.evaluate(() => {
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
        voice: box('#gev-voice-control'),
        provider: box('.gev-voice-provider-field'),
        hud: [...document.querySelectorAll('#intel-hud > div')].map((el) => ({
          class: el.className,
          display: getComputedStyle(el).display,
        })),
      };
    });
    results.push({ width, height, ...state });
    if (phase === 'after') {
      const phone = width <= 720 || (width <= 1023 && height <= 520);
      assert.equal(state.mobile, phone, `${width}x${height}: shell gate`);
      if (phone) {
        assert.ok(
          state.hud
            .filter((item) => item.class !== 'hud-sonar')
            .every((item) => item.display === 'none'),
          'portrait HUD treatment is reused without overlapping text blocks',
        );
        assert.ok(state.tab && state.tab.bottom <= height + 1);
        assert.equal(state.tab.height, height <= 520 ? 48 : 58);
        assert.ok(
          state.provider &&
            state.provider.y >= 0 &&
            state.provider.right <= width + 1,
        );
        if (height <= 520) {
          assert.ok(
            state.voice.width <= 56 && state.voice.right >= width - 60,
            'landscape voice collapses to the corner mic',
          );
          assert.ok(
            state.provider.right <= state.voice.x &&
              Math.abs(
                state.provider.y +
                  state.provider.height / 2 -
                  (state.voice.y + state.voice.height / 2),
              ) <= 2,
            'picker sits beside the mic',
          );
        } else {
          assert.ok(
            Math.abs(state.voice.y - state.provider.bottom) <= 14,
            'picker is adjacent to voice',
          );
        }
        for (const sheet of [
          'layers',
          'cameras',
          'context',
          'search',
          'more',
        ]) {
          await page.click(`.mobile-tab[data-mobile-sheet="${sheet}"]`);
          await new Promise((resolve) => setTimeout(resolve, 400));
          const geometry = await page.evaluate(() => {
            const visible = (el) =>
              el &&
              getComputedStyle(el).display !== 'none' &&
              el.getBoundingClientRect().height > 0;
            const tabTop = document
              .getElementById('mobile-tab-bar')
              .getBoundingClientRect().top;
            const containers = [
              'left-panel-stack',
              'right-context-rail',
              'command-dock',
            ]
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
              voiceHidden: !visible(
                document.getElementById('gev-voice-control'),
              ),
            };
          });
          assert.equal(geometry.sheet, sheet);
          assert.equal(geometry.selected, 1);
          assert.ok(geometry.voiceHidden);
          for (const c of geometry.containers) {
            assert.ok(
              c.top >= 0 &&
                c.bottom <= geometry.tabTop + 1 &&
                c.left >= 0 &&
                c.right <= width + 1,
              JSON.stringify(geometry),
            );
            assert.ok(c.scrolls, `${c.id} scrolls to content`);
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
        }
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
    await page.waitForFunction(() => !!window.__godsEyeView?.styleManager);
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
      const matches = await page.evaluate(async () => {
        const { MOBILE_SHELL_MEDIA_QUERY } =
          await import('/src/ui/panelRailGeometry.js');
        return matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches;
      });
      assert.equal(matches, expected);
      results.push({ width, height, breakpointMatch: matches });
    }
    await page.setViewport({ width: 844, height: 390, hasTouch: true });
    await page.waitForFunction(() =>
      document.body.classList.contains('mobile-shell'),
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.getElementById('loading-screen')).opacity ===
        '0',
    );
    await page.evaluate(() => {
      document.body.style.setProperty('--mobile-left-inset', '44px');
      document.body.style.setProperty('--mobile-right-inset', '44px');
      document.body.style.setProperty('--mobile-bottom-inset', '21px');
    });
    await page.focus('#gev-voice-provider');
    const touch = await page.evaluate(() => {
      const voice = document
        .getElementById('gev-voice-control')
        .getBoundingClientRect();
      const picker = document
        .querySelector('.gev-voice-provider-field')
        .getBoundingClientRect();
      const gear = document
        .querySelector('.gev-voice-settings-button')
        .getBoundingClientRect();
      return {
        gap: voice.left - picker.right,
        pickerLeft: picker.left,
        pickerRight: picker.right,
        gearHeight: gear.height,
        tabHeight: document
          .getElementById('mobile-tab-bar')
          .getBoundingClientRect().height,
      };
    });
    assert.ok(touch.gap >= 7 && touch.gap <= 9);
    assert.ok(touch.pickerLeft >= 44 && touch.pickerRight <= 800);
    assert.equal(touch.gearHeight, 44);
    assert.equal(touch.tabHeight, 69);
    results.push({ touchAndSimulatedNotches: touch });
    await page.screenshot({
      path: new URL('after-844x390-touch-notches.png', directory).pathname,
    });
    await page.click('.mobile-tab[data-mobile-sheet="more"]');
    const padding = await page.$eval('#right-context-rail', (el) => ({
      left: parseFloat(getComputedStyle(el).paddingLeft),
      right: parseFloat(getComputedStyle(el).paddingRight),
    }));
    assert.equal(padding.left, 54);
    assert.equal(padding.right, 54);
    await page.screenshot({
      path: new URL('after-844x390-more-touch-notches.png', directory).pathname,
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
