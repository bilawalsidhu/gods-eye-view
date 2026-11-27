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
    // Weather's list shows in Context's list tab; the camera tools' CAL chip
    // waits in their hidden home until a camera card's Camera settings tab
    // shows it.
    await page.evaluate(async () => {
      const { dataManager, styleManager: manager } = window.__godsEyeView;
      await dataManager.setEnabled('wind', true);
      manager.setPanelCollapsed('global-context-panel', false, {
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
    });
    await page.waitForSelector('#context-tab-lists', { visible: true });
    await page.click('#context-tab-lists');
    await page.waitForSelector(
      '#context-lists .weather-coverage.gev-status-badge',
      {
        visible: true,
      },
    );
    const inventory = await page.evaluate(() => {
      const quality = document.getElementById('cctv-quality-chip');
      const coverage = [
        ...document.querySelectorAll('#context-lists .weather-coverage'),
      ];
      return {
        shared: coverage.every((node) =>
          node.classList.contains('gev-status-badge'),
        ),
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
      };
    });
    check(
      `${lang}: populated Weather badges share the view`,
      inventory.shared && inventory.coverage,
      inventory,
    );
    check(
      `${lang}: read-only badge semantics remain intact`,
      inventory.silent,
      inventory,
    );
    for (const [calBadge, dirty, color] of [
      ['raw-prior', false, 'rgba(225, 236, 242, 0.85)'],
      ['curated', false, 'rgb(255, 230, 162)'],
      ['calibrated', false, 'rgb(173, 255, 191)'],
      ['curated', true, 'rgb(255, 208, 138)'],
    ]) {
      const result = await page.evaluate(
        async ({ calBadge, dirty }) => {
          const owner = window.__godsEyeView.styleManager._cctvControls;
          owner._renderCctvState({
            ...owner._cctvState,
            activeCamera: {
              ...owner._cctvState.activeCamera,
              calBadge,
              calDirty: dirty,
            },
          });
          // The tools render the chip on Vue's next flush.
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const badge = document.getElementById('cctv-quality-chip');
          return {
            state: badge.dataset.calBadge,
            color: getComputedStyle(badge).color,
          };
        },
        { calBadge, dirty },
      );
      check(
        `${lang}: ${dirty ? 'edited' : calBadge} keeps its provenance color`,
        result.state === (dirty ? 'edited' : calBadge) &&
          result.color === color,
        result,
      );
    }
    for (const theme of ['tactical', 'minimal']) {
      await page.evaluate(
        (theme) => window.__godsEyeView.styleManager._setHudVariant(theme),
        theme,
      );
      for (const width of [1440, 620, 390]) {
        await page.setViewport({ width, height: 900 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Phones show Context in the Context tab's sheet.
        await page.evaluate(() => {
          if (
            document.body.classList.contains('mobile-shell') &&
            document.body.dataset.mobileSheet !== 'context'
          )
            document
              .querySelector('#mobile-tab-bar [data-mobile-sheet="context"]')
              ?.click();
        });
        await page
          .waitForFunction(
            () =>
              document
                .querySelector('#context-lists .weather-coverage')
                ?.getBoundingClientRect().width > 0,
            { timeout: 3000 },
          )
          .catch(() => {});
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const layout = await page.evaluate(() =>
          [
            ...document.querySelectorAll('#context-lists .weather-coverage'),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            const panel = node
              .closest('#global-context-panel')
              .getBoundingClientRect();
            return {
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
          }),
        );
        check(
          `${lang}/${theme}: Weather badges fit Context at ${width}px`,
          layout.length >= 1 && layout.every((node) => node.fits),
          layout,
        );
        if (width === 390)
          await page.screenshot({
            path: `${out}/${lang}-${theme}-weather-${width}.png`,
          });
      }
    }
    const disposed = await page.evaluate(async () => {
      const owner = window.__godsEyeView.styleManager._cctvControls;
      const badge = document.getElementById('cctv-quality-chip');
      const late = {
        ...owner._cctvState,
        activeCamera: {
          ...owner._cctvState.activeCamera,
          calBadge: 'calibrated',
          calDirty: false,
        },
      };
      owner.destroy();
      owner._renderCctvState(late);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return (
        document.getElementById('cctv-quality-chip')?.dataset.calBadge ===
        'edited'
      );
    });
    check(`${lang}: disposal prevents late state painting`, disposed);
  }
  check('no uncaught browser errors', errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`${checks} checks; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
