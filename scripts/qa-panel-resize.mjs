#!/usr/bin/env node
/**
 * Browser QA for the floating CCTV panel: lift, resize from every handle,
 * minimum size, reload, and dock again. `--fail-on-retry` (or
 * QA_FAIL_ON_RETRY=1) fails on any header-press retry.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { RESIZE_DIRECTIONS, resizeBox } from '../src/ui/panelResize.js';
import {
  describePress,
  dockPanelByDoubleClick,
  dragPointer,
  liftPanelByHeader,
  nextFrames,
} from './qa-panelDrag.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';

export const PANEL_ID = 'cctv-panel';
export const STORAGE_KEY = `godsEyeView.v8.panelPos.${PANEL_ID}`;
export const MIN_SIZE = { width: 300, height: 160 };
export const ARTIFACT_DIR = 'qa-artifacts/panel-resize';
const VIEWPORT = { width: 1400, height: 900 };
const EDGE_BY_SIDE = { n: 'top', s: 'bottom', e: 'right', w: 'left' };

/** Box edges a resize in `dir` must leave exactly where they were. */
export function pinnedEdges(dir) {
  return Object.entries(EDGE_BY_SIDE)
    .filter(([side]) => !dir.includes(side))
    .map(([, edge]) => edge);
}

/** Pointer travel that grows a panel by `amount` on every edge named in `dir`. */
export function growthDelta(dir, amount) {
  return {
    dx: dir.includes('e') ? amount : dir.includes('w') ? -amount : 0,
    dy: dir.includes('s') ? amount : dir.includes('n') ? -amount : 0,
  };
}

/**
 * Viewport point inside the handle for `dir`, given the panel's client rect.
 * Edge strips straddle the border by 3px; corners and the grip sit inside.
 */
export function handlePoint(rect, dir) {
  const inset = dir.length === 2 ? 4 : 1;
  const x = dir.includes('w')
    ? rect.left + inset
    : dir.includes('e')
      ? rect.right - inset
      : rect.left + rect.width / 2;
  const y = dir.includes('n')
    ? rect.top + inset
    : dir.includes('s')
      ? rect.bottom - inset
      : rect.top + rect.height / 2;
  return { x, y };
}

/** Pinned edges that moved during a resize in `dir`. */
export function driftedEdges(before, after, dir, tolerance = 1.5) {
  const edges = (box) => ({
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  });
  const a = edges(before);
  const b = edges(after);
  return pinnedEdges(dir).filter(
    (edge) => Math.abs(a[edge] - b[edge]) > tolerance,
  );
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
  if (args.includes('--fail-on-retry')) process.env.QA_FAIL_ON_RETRY = '1';
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const monitors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const errors = [];
    monitors.push(watchPage(page, { name: 'panel', errors }));
    await hookRenderErrors(page);

    const boot = async () => {
      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__godsEyeView?.viewer, {
        timeout: 90_000,
      });
      await page.waitForSelector(`#${PANEL_ID} .panel-header`);
      await page.evaluate(() => {
        document.querySelector('.first-run-explore')?.click();
      });
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        document.getElementById('first-run-launcher')?.remove();
        for (const node of document.querySelectorAll('[class*=first-run]'))
          node.remove();
      });
      await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
      await nextFrames(page);
    };
    const readPanel = () =>
      page.evaluate((id) => {
        const panel = document.getElementById(id);
        const rect = panel.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          // handlePoint() reads the far edges for s/e handles.
          right: rect.right,
          bottom: rect.bottom,
          floating: panel.classList.contains('panel-floating'),
          collapsed: panel.classList.contains('collapsed'),
          inRail: panel.parentElement?.id === 'right-context-rail',
          allocated: panel.style.getPropertyValue(
            '--right-panel-allocated-height',
          ),
          inlineWidth: panel.style.width,
          inlineHeight: panel.style.height,
          stored: localStorage.getItem(`godsEyeView.v8.panelPos.${id}`),
        };
      }, PANEL_ID);
    /**
     * Best effort: wait for the box to hold still for half a second. The lift
     * is checked against the box at pointerdown, so a timeout only costs time.
     */
    const settle = async () => {
      try {
        await page.waitForFunction(
          (id) => {
            const r = document.getElementById(id).getBoundingClientRect();
            const box = [r.left, r.top, r.width, r.height]
              .map(Math.round)
              .join(',');
            const now = performance.now();
            if (window.__qaLastBox !== box) {
              window.__qaLastBox = box;
              window.__qaSince = now;
            }
            return now - window.__qaSince >= 500;
          },
          { polling: 100, timeout: 20_000 },
          PANEL_ID,
        );
      } catch (error) {
        if (error?.name !== 'TimeoutError') throw error;
        console.log('note: the CCTV panel was still moving; lifting anyway');
      }
    };
    const headerPoint = async () => {
      const rect = await page.evaluate((id) => {
        const title = document.querySelector(
          `#${id} .panel-header .panel-title`,
        );
        const r = title.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, PANEL_ID);
      return rect;
    };
    const drag = (from, dx, dy) => dragPointer(page, from, dx, dy);

    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => {
      localStorage.removeItem(key);
      localStorage.removeItem('godsEyeView.v8.panelFloatHintShown');
    }, STORAGE_KEY);
    await boot();

    await page.evaluate((id) => {
      const panel = document.getElementById(id);
      if (panel.classList.contains('collapsed'))
        document
          .querySelector(`.panel-collapse-btn[data-collapse-target="${id}"]`)
          .click();
    }, PANEL_ID);
    await page.waitForFunction(
      (id) => !document.getElementById(id).classList.contains('collapsed'),
      {},
      PANEL_ID,
    );
    // The rail animates panel heights, and on a slow software renderer the
    // panels above CCTV can still be moving after a fixed sleep.
    await settle();
    const docked = await readPanel();
    assert.equal(docked.floating, false);
    assert.equal(docked.inRail, true);

    // Names whatever above CCTV in the rail shifted it, for a retry note.
    const railAbove = () =>
      page.evaluate((id) => {
        const out = [];
        for (const node of document.getElementById('right-context-rail')
          ?.children || []) {
          if (node.id === id) break;
          out.push(
            `${node.id || node.className}:${Math.round(node.offsetHeight)}`,
          );
        }
        return out.join(' ');
      }, PANEL_ID);
    const aboveAtDock = await railAbove();
    // On CI a panel above CCTV grows after load and can shift the header out
    // from under the press; the helper retries only such a provable miss.
    const attempt = await liftPanelByHeader(page, PANEL_ID, {
      dx: -200,
      dy: -100,
      note: async () =>
        `rail above CCTV ${aboveAtDock} -> ${await railAbove()}`,
    });
    const { pressed } = attempt;
    const lifted = await readPanel();
    assert.equal(
      lifted.floating,
      true,
      `a header drag lifts the panel out (${describePress(attempt)}; panel docked at ${docked.top}, at press ${pressed?.top})`,
    );
    assert.equal(
      lifted.collapsed,
      false,
      'the drag-ending click must not collapse',
    );
    const moved = `docked at ${docked.left},${docked.top}; pressed at ${pressed.left},${pressed.top}`;
    near(
      lifted.left,
      Math.max(6, pressed.left - 200),
      2,
      `lifted left (${moved})`,
    );
    near(
      lifted.top,
      Math.max(6, pressed.top - 100),
      2,
      `lifted top (${moved})`,
    );
    near(lifted.width, pressed.width, 2, 'lifted width');
    // The rail lets go of the lifted panel on its next layout pass.
    await page
      .waitForFunction(
        (id) =>
          document
            .getElementById(id)
            .style.getPropertyValue('--right-panel-allocated-height') === '',
        { timeout: 5_000 },
        PANEL_ID,
      )
      .catch(() => {});
    const afterLayout = await readPanel();
    assert.equal(afterLayout.allocated, '', 'the rail no longer allocates it');
    const railExcludes = await page.evaluate((id) => {
      const rail = document.getElementById('right-context-rail');
      // Same rule as the rail: hidden panels take no room.
      const counted = [...rail.children].filter((panel) =>
        panel.matches(
          '[data-panel-id]:not(.panel-floating):not(.collapsed):not([hidden])',
        ),
      );
      return {
        expandedCount: rail.dataset.expandedCount,
        counted: counted.length,
        includesPanel: counted.some((panel) => panel.id === id),
      };
    }, PANEL_ID);
    assert.equal(railExcludes.includesPanel, false);
    if (railExcludes.expandedCount !== undefined)
      assert.equal(Number(railExcludes.expandedCount), railExcludes.counted);
    const storedAfterLift = JSON.parse(afterLayout.stored);
    assert.equal(storedAfterLift.floating, true);
    assert.equal(
      'height' in storedAfterLift,
      false,
      'a drag alone must not freeze the measured height',
    );
    console.log('PASS: header drag lifts CCTV out of the rail');

    // Park near the top: the voice dock would cover the south corners once
    // the loop below has grown the window.
    {
      const header = await headerPoint();
      await drag(header, 0, 120 - header.y);
    }

    const limits = {
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      viewportWidth: VIEWPORT.width,
      viewportHeight: VIEWPORT.height,
    };
    for (const dir of RESIZE_DIRECTIONS) {
      const before = await readPanel();
      const { dx, dy } = growthDelta(dir, 40);
      const point = handlePoint(before, dir);
      const hit = await page.evaluate(({ x, y }) => {
        const node = document.elementFromPoint(x, y);
        if (!node) return 'nothing';
        const dirAttr = node.dataset?.dir
          ? `[data-dir=${node.dataset.dir}]`
          : '';
        return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${[...node.classList].join('.')}${dirAttr}`;
      }, point);
      await drag(point, dx, dy);
      const after = await readPanel();
      const expected = resizeBox(before, dir, dx, dy, limits);
      for (const key of ['left', 'top', 'width', 'height'])
        near(after[key], expected[key], 2, `${dir} ${key} (pointer on ${hit})`);
      assert.deepEqual(driftedEdges(before, after, dir, 2), [], `${dir} pins`);
    }
    console.log('PASS: eight resize handles keep the opposite edge pinned');

    let before = await readPanel();
    await drag(handlePoint(before, 'se'), -2000, -2000);
    let after = await readPanel();
    near(after.width, MIN_SIZE.width, 2, 'min width (se)');
    near(after.height, MIN_SIZE.height, 2, 'min height (se)');
    assert.deepEqual(driftedEdges(before, after, 'se', 2), []);
    before = after;
    await drag(handlePoint(before, 'nw'), 2000, 2000);
    after = await readPanel();
    near(after.width, MIN_SIZE.width, 2, 'min width (nw)');
    near(after.height, MIN_SIZE.height, 2, 'min height (nw)');
    assert.deepEqual(driftedEdges(before, after, 'nw', 2), []);
    console.log('PASS: minimum size holds from both corners');

    const saved = await readPanel();
    const record = JSON.parse(saved.stored);
    assert.equal(record.floating, true);
    await boot();
    const restored = await readPanel();
    assert.equal(restored.floating, true, 'floating survives a reload');
    for (const key of ['left', 'top', 'width', 'height'])
      near(restored[key], record[key], 2, `restored ${key}`);
    console.log('PASS: reload restores position and size');

    // A collapsed window keeps the height chosen for it, through a drag of
    // its header strip and a reload.
    const setCollapsed = async (collapsed) => {
      await page.evaluate(
        (id, want) => {
          const panel = document.getElementById(id);
          if (panel.classList.contains('collapsed') !== want)
            document
              .querySelector(
                `.panel-collapse-btn[data-collapse-target="${id}"]`,
              )
              .click();
        },
        PANEL_ID,
        collapsed,
      );
      await page.waitForFunction(
        (id, want) =>
          document.getElementById(id).classList.contains('collapsed') === want,
        {},
        PANEL_ID,
        collapsed,
      );
      await nextFrames(page);
    };
    // Grow it from the corner once the restored window holds still, with the
    // pointer really on the handle (a press beside it selects page text).
    let chosen = await readPanel();
    for (
      let attempt = 0;
      attempt < 3 && chosen.height <= MIN_SIZE.height + 150;
      attempt++
    ) {
      await settle();
      const corner = handlePoint(await readPanel(), 'se');
      const onHandle = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.dataset?.dir === 'se',
        corner,
      );
      if (onHandle) await drag(corner, 0, 200);
      chosen = await readPanel();
    }
    assert.ok(
      chosen.height > MIN_SIZE.height + 150,
      `the window grew to ${chosen.height}px`,
    );
    await setCollapsed(true);
    const strip = await readPanel();
    assert.ok(strip.height < chosen.height - 100, 'collapsed to its header');
    await drag(await headerPoint(), 40, 30);
    const movedStrip = await readPanel();
    assert.equal(movedStrip.floating, true, 'the strip stays a window');
    near(
      JSON.parse(movedStrip.stored).height,
      chosen.height,
      2,
      'stored height while collapsed',
    );
    await boot();
    await setCollapsed(false);
    near(
      (await readPanel()).height,
      chosen.height,
      2,
      'height after expanding',
    );
    console.log(
      'PASS: a collapsed window keeps its height through a drag and a reload',
    );

    const dock = await dockPanelByDoubleClick(page, PANEL_ID);
    const snapped = await readPanel();
    assert.equal(
      snapped.floating,
      false,
      `double-click snaps back (${describePress(dock)})`,
    );
    assert.equal(snapped.inRail, true);
    assert.equal(snapped.inlineWidth, '');
    assert.equal(snapped.inlineHeight, '');
    assert.equal(snapped.stored, null, 'the storage key is gone');
    console.log('PASS: header double-click returns the panel to the rail');

    const renderErrors = await readRenderErrors(page);
    assert.deepEqual(
      [...errors, ...renderErrors.map((text) => `scene.renderError: ${text}`)],
      [],
      'no page errors and no Cesium render-loop errors',
    );
    console.log('PASS: no page errors and no render-loop errors');
  } catch (error) {
    const dir = await saveFailureArtifacts({
      dir: ARTIFACT_DIR,
      browser,
      monitors,
      error,
    }).catch(() => null);
    if (dir) console.error(`failure evidence saved in ${dir}/`);
    throw error;
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
