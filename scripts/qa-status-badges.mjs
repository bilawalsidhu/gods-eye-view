#!/usr/bin/env node
/** Badge acceptance on dev/preview. Camera state is a disposable controller fixture. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let checks = 0;
let failures = 0;
const check = (name, passed, detail) => {
  checks++;
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) {
    failures++;
    console.log(JSON.stringify(detail));
  }
};
const out = 'qa-shots/status-badges';
fs.mkdirSync(out, { recursive: true });
try {
  for (const lang of ['en', 'ru']) {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(
      `${process.env.QA_BASE_URL || 'http://127.0.0.1:4189'}/?welcome=0&lang=${lang}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.styleManager?._cctvControls &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60000 },
    );
    await page.evaluate(async () => {
      const { dataManager, styleManager: manager } = window.__godsEyeView;
      await dataManager.setEnabled('wind', true);
      manager.setPanelCollapsed('weather-panel', false, {
        persist: false,
        syncShare: false,
      });
      manager.setPanelCollapsed('cctv-panel', false, {
        persist: false,
        syncShare: false,
      });
      const owner = manager._cctvControls;
      owner._cctvUnsubscribe?.();
      owner._cctvUnsubscribe = null;
      owner.actions = { ...owner.actions, isEnabled: () => true };
      owner._renderCctvState({
        enabled: true,
        activeCameraId: 'badge-fixture',
        cameras: [{ id: 'badge-fixture', city: 'QA', name: 'Badge fixture' }],
        activeCamera: {
          id: 'badge-fixture',
          city: 'QA',
          headingDeg: 30,
          pitchDeg: -10,
          fovDeg: 45,
          rangeM: 120,
          mountHeightM: 8,
          sourceKind: 'snapshot',
          sourceStatus: 'degraded',
          calBadge: 'curated',
          calDirty: false,
        },
      });
      window.__qaBadgeText =
        document.getElementById('cctv-source-badge').textContent;
    });
    await page.waitForSelector('.weather-coverage.gev-status-badge');
    const inventory = await page.evaluate(() => {
      const source = document.getElementById('cctv-source-badge');
      const quality = document.getElementById('cctv-quality-chip');
      const coverage = [...document.querySelectorAll('.weather-coverage')];
      return {
        shared: [source, quality, ...coverage].every((node) =>
          node.classList.contains('gev-status-badge'),
        ),
        live:
          source.getAttribute('role') === 'status' &&
          source.getAttribute('aria-live') === 'polite',
        silent: [quality, ...coverage].every(
          (node) =>
            !node.hasAttribute('aria-live') &&
            !node.hasAttribute('role') &&
            !node.hasAttribute('tabindex'),
        ),
        coverage:
          coverage.length > 0 &&
          coverage.every(
            (node) =>
              node.textContent &&
              !node.hidden &&
              node.classList.contains('gev-status-badge--plain'),
          ),
        source: source.textContent,
      };
    });
    check(
      `${lang}: CCTV and populated Weather badges share the view`,
      inventory.shared && inventory.coverage,
      inventory,
    );
    check(
      `${lang}: existing announcement and read-only semantics remain intact`,
      inventory.live && inventory.silent,
      inventory,
    );
    check(
      `${lang}: source wording uses the active locale`,
      lang === 'en'
        ? inventory.source === 'SNAPSHOT · DEGRADED'
        : inventory.source !== 'SNAPSHOT · DEGRADED',
      inventory,
    );

    for (const state of ['loading', 'error', 'retained', 'ready', 'idle']) {
      const result = await page.evaluate((state) => {
        const owner = window.__godsEyeView.styleManager._cctvControls;
        owner._cctvFrame.dataset.loading = state === 'loading' ? 'true' : '';
        owner._cctvFrame.dataset.error = ['error', 'retained'].includes(state)
          ? 'true'
          : '';
        owner._cctvFrameWrap.classList.toggle(
          'has-frame',
          state === 'retained',
        );
        owner._syncCctvSourceBadge(
          owner._cctvState.activeCamera,
          state !== 'idle',
        );
        const badge = document.getElementById('cctv-source-badge');
        return {
          state: badge.dataset.frameState,
          text: badge.textContent,
          color: getComputedStyle(badge).color,
        };
      }, state);
      const expected = {
        loading: ['loading', 'rgb(255, 229, 155)'],
        error: ['error', 'rgb(255, 176, 176)'],
        retained: ['ready', 'rgb(157, 239, 255)'],
        ready: ['ready', 'rgb(157, 239, 255)'],
        idle: ['idle', 'rgb(157, 239, 255)'],
      }[state];
      check(
        `${lang}: ${state} keeps its frame state and palette`,
        result.state === expected[0] &&
          result.color === expected[1] &&
          (!['ready', 'retained'].includes(state) ||
            result.text === inventory.source),
        result,
      );
    }
    for (const [calBadge, dirty, color] of [
      ['raw-prior', false, 'rgb(143, 231, 255)'],
      ['curated', false, 'rgb(255, 230, 162)'],
      ['calibrated', false, 'rgb(173, 255, 191)'],
      ['curated', true, 'rgb(255, 208, 138)'],
    ]) {
      const result = await page.evaluate(
        ({ calBadge, dirty }) => {
          const owner = window.__godsEyeView.styleManager._cctvControls;
          document.getElementById('cctv-next-btn').focus();
          owner._renderCctvState({
            ...owner._cctvState,
            activeCamera: {
              ...owner._cctvState.activeCamera,
              calBadge,
              calDirty: dirty,
            },
          });
          const badge = document.getElementById('cctv-quality-chip');
          return {
            state: badge.dataset.calBadge,
            color: getComputedStyle(badge).color,
            focus: document.activeElement.id,
          };
        },
        { calBadge, dirty },
      );
      check(
        `${lang}: ${dirty ? 'edited' : calBadge} keeps provenance color and control focus`,
        result.state === (dirty ? 'edited' : calBadge) &&
          result.color === color &&
          result.focus === 'cctv-next-btn',
        result,
      );
    }
    for (const theme of ['tactical', 'cyber']) {
      await page.evaluate(
        (theme) => window.__godsEyeView.styleManager._setHudVariant(theme),
        theme,
      );
      for (const width of [1440, 620, 390]) {
        await page.setViewport({ width, height: 900 });
        for (const panelId of ['cctv-panel', 'weather-panel']) {
          await page.evaluate(async (panelId) => {
            const manager = window.__godsEyeView.styleManager;
            for (const other of ['cctv-panel', 'weather-panel']) {
              if (other !== panelId)
                manager.setPanelCollapsed(other, true, {
                  persist: false,
                  syncShare: false,
                });
            }
            manager.setPanelCollapsed(panelId, false, {
              persist: false,
              syncShare: false,
            });
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          }, panelId);
          const layout = await page.evaluate((panelId) => {
            const selector =
              panelId === 'cctv-panel'
                ? '#cctv-source-badge, #cctv-quality-chip'
                : '.weather-coverage';
            return [...document.querySelectorAll(selector)].map((node) => {
              const rect = node.getBoundingClientRect();
              const panel = node.closest(`#${panelId}`).getBoundingClientRect();
              return {
                id: node.id || 'weather-coverage',
                text: node.textContent,
                width: rect.width,
                height: rect.height,
                scroll: node.scrollWidth,
                client: node.clientWidth,
                left: rect.left,
                right: rect.right,
                panelLeft: panel.left,
                panelRight: panel.right,
                fits:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.left >= panel.left - 1 &&
                  rect.right <= panel.right + 1 &&
                  node.scrollWidth <= node.clientWidth + 1,
              };
            });
          }, panelId);
          check(
            `${lang}/${theme}: ${panelId} badges fit at ${width}px`,
            layout.length >= (panelId === 'cctv-panel' ? 2 : 1) &&
              layout.every((node) => node.fits),
            layout,
          );
          if (width === 390)
            await page.screenshot({
              path: `${out}/${lang}-${theme}-${panelId}-${width}.png`,
            });
        }
      }
    }
    const disposed = await page.evaluate(() => {
      const owner = window.__godsEyeView.styleManager._cctvControls;
      const badge = document.getElementById('cctv-quality-chip');
      const text = badge.textContent;
      owner.destroy();
      owner._renderCctvState(null);
      return badge.textContent === text;
    });
    check(`${lang}: disposal prevents late state painting`, disposed);
  }
  check('no uncaught browser errors', errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`${checks} checks; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
