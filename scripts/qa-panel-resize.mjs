#!/usr/bin/env node
/**
 * Prove the portable CCTV panel in a real browser: a header drag lifts it out
 * of the right rail, every resize handle moves only its own edges, minimum
 * sizes hold, the window survives a reload and a header double-click snaps
 * it back and forgets the stored position.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { RESIZE_DIRECTIONS, resizeBox } from '../src/ui/panelResize.js';

export const PANEL_ID = 'cctv-panel';
export const STORAGE_KEY = `godsEyeView.v8.panelPos.${PANEL_ID}`;
export const MIN_SIZE = { width: 300, height: 160 };
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

/** Edges of `after` that moved although a resize in `dir` should have pinned them. */
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
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));

    const boot = async () => {
      await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__godsEyeView?.viewer, {
        timeout: 90_000,
      });
      await page.waitForSelector(`#${PANEL_ID} .panel-header`);
      // The first-run dialog sits over the globe until a choice is made.
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
      await new Promise((resolve) => setTimeout(resolve, 400));
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
    const drag = async (from, dx, dy) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
      await page.mouse.up();
      await new Promise((resolve) => setTimeout(resolve, 120));
    };

    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => {
      localStorage.removeItem(key);
      localStorage.removeItem('godsEyeView.v8.panelFloatHintShown');
    }, STORAGE_KEY);
    await boot();

    // Expand CCTV so the panel has a body worth resizing.
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    const docked = await readPanel();
    assert.equal(docked.floating, false);
    assert.equal(docked.inRail, true);

    // Lift out: drag the header 200px left and 100px up.
    await drag(await headerPoint(), -200, -100);
    const lifted = await readPanel();
    assert.equal(lifted.floating, true, 'a header drag lifts the panel out');
    assert.equal(
      lifted.collapsed,
      false,
      'the drag-ending click must not collapse',
    );
    near(lifted.left, Math.max(6, docked.left - 200), 2, 'lifted left');
    near(lifted.top, Math.max(6, docked.top - 100), 2, 'lifted top');
    near(lifted.width, docked.width, 2, 'lifted width');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const afterLayout = await readPanel();
    assert.equal(afterLayout.allocated, '', 'the rail no longer allocates it');
    const railExcludes = await page.evaluate((id) => {
      const rail = document.getElementById('right-context-rail');
      // Same rule as the rail: hidden panels (a layer that is off) take no room.
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

    // Park the window near the top: the voice dock sits above every panel at
    // the bottom of the screen and would otherwise cover the south corners
    // once the loop below has grown the window.
    {
      const header = await headerPoint();
      await drag(header, 0, 120 - header.y);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Every handle moves only its own edges.
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
      // Name what the pointer lands on, so a covered handle is obvious.
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

    // Minimum size stops the moving edge.
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

    // Reload restores the window.
    const saved = await readPanel();
    const record = JSON.parse(saved.stored);
    assert.equal(record.floating, true);
    await boot();
    const restored = await readPanel();
    assert.equal(restored.floating, true, 'floating survives a reload');
    for (const key of ['left', 'top', 'width', 'height'])
      near(restored[key], record[key], 2, `restored ${key}`);
    console.log('PASS: reload restores position and size');

    // Double-click the header to snap back.
    const point = await headerPoint();
    const headerHit = await page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      return node
        ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${[...node.classList].join('.')}`
        : 'nothing';
    }, point);
    await page.mouse.click(point.x, point.y, { clickCount: 1 });
    await page.mouse.click(point.x, point.y, { clickCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snapped = await readPanel();
    assert.equal(
      snapped.floating,
      false,
      `double-click snaps back (pointer on ${headerHit})`,
    );
    assert.equal(snapped.inRail, true);
    assert.equal(snapped.inlineWidth, '');
    assert.equal(snapped.inlineHeight, '');
    assert.equal(snapped.stored, null, 'the storage key is gone');
    console.log('PASS: header double-click returns the panel to the rail');

    assert.deepEqual(errors, []);
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
