#!/usr/bin/env node
/**
 * Scope and HUD browser acceptance. Requires the development server.
 * Run: node scripts/qa-scope-hud.mjs
 * Optional: QA_BASE_URL, QA_SCREENSHOT_DIR (screenshots stay outside the repo).
 * Proves a fresh boot defaults to Scope ON at 100%, native checkbox click/Space,
 * feather 0/11/100/200, layout independence,
 * share/scene restore, and visible text backing including rotated metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, passed, detail) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) {
    failures += 1;
    if (detail) console.log(JSON.stringify(detail));
  }
};
const readScope = () =>
  page.evaluate(() => {
    const scope = window.__godsEyeView.styleManager.getVisualState().scope;
    const canvas = document.getElementById('scope-mask');
    const context = canvas.getContext('2d');
    const radialX = Math.round(
      canvas.width / 2 + Math.min(canvas.width, canvas.height) * 0.35,
    );
    return {
      enabled: scope.enabled,
      feather: scope.featherPct / 100,
      cornerAlpha: context.getImageData(1, 1, 1, 1).data[3],
      radialAlpha: context.getImageData(
        radialX,
        Math.round(canvas.height / 2),
        1,
        1,
      ).data[3],
      checked: document.getElementById('scope-toggle').checked,
      disabled: document.getElementById('scope-feather-slider').disabled,
      value: Number(document.getElementById('scope-feather-slider').value),
      readout: document.getElementById('scope-feather-value').textContent,
    };
  });

const readHudGlyphs = () =>
  page.evaluate(() => {
    const hud = document.getElementById('intel-hud');
    const probe = document.createElement('span');
    probe.style.display = 'none';
    hud.appendChild(probe);
    const baseline = {
      color: getComputedStyle(probe).color,
      shadow: getComputedStyle(probe).textShadow,
    };
    probe.remove();
    const glyphs = [
      '.hud-mode',
      '.hud-system',
      '.hud-summary-label',
      '.hud-summary',
      '.hud-orbital',
      '#hud-mgrs',
      '#hud-coll',
    ].map((selector) => {
      const el = hud.querySelector(selector);
      const style = getComputedStyle(el);
      let opacity = 1;
      for (
        let current = el;
        current && current !== hud;
        current = current.parentElement
      )
        opacity *= Number(getComputedStyle(current).opacity);
      return {
        selector,
        color: style.color,
        shadow: style.textShadow,
        opacity,
      };
    });
    return { baseline, glyphs };
  });

async function settleTextBackings(enabled) {
  // The pre-existing active-style value transitions all properties for 300ms.
  // Wait for its backing to finish changing before inspecting or capturing it.
  await page
    .waitForFunction(
      (scopeEnabled) => {
        const expected = scopeEnabled
          ? 'rgba(0, 0, 0, 0)'
          : 'rgba(0, 0, 0, 0.7)';
        return [
          ...document.querySelectorAll(
            '#intel-hud .hud-readout, .scene-text-holdout',
          ),
        ].every(
          (el) =>
            getComputedStyle(el).backgroundColor === expected &&
            getComputedStyle(el).boxShadow === 'none',
        );
      },
      { timeout: 2_000 },
      enabled,
    )
    .catch(() => null);
}

const readSceneChrome = () =>
  page.evaluate(() => {
    const title = document.querySelector('#title-bar h1');
    const eye = title.querySelector('.title-logo');
    const subtitle = document.querySelector('#title-bar .subtitle');
    const label = document.querySelector('#style-indicator .indicator-label');
    const rect = (el, text = false) => {
      if (!el.getClientRects().length) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = text
        ? range.getBoundingClientRect()
        : el.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const titleBox = rect(title);
    const eyeBox = rect(eye);
    const backing = getComputedStyle(title, '::before');
    const plate = {
      left: titleBox.left + parseFloat(backing.left),
      top: titleBox.top + parseFloat(backing.top),
      right: titleBox.right - parseFloat(backing.right),
      bottom: titleBox.bottom - parseFloat(backing.bottom),
    };
    const contains = (box) =>
      Object.entries(box).every(([side, value]) =>
        ['left', 'top'].includes(side)
          ? plate[side] <= value + 0.5
          : plate[side] >= value - 0.5,
      );
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    probe.style.color = 'var(--text-dim)';
    const dim = getComputedStyle(probe).color;
    probe.style.color = 'var(--text-secondary)';
    const secondary = getComputedStyle(probe).color;
    probe.remove();
    return {
      positions: {
        title: titleBox,
        eye: eyeBox,
        text: rect(title.querySelector('[translate="no"]'), true),
        subtitle: rect(subtitle, true),
      },
      titleUnbacked: backing.backgroundColor === 'rgba(0, 0, 0, 0)',
      titleCovered:
        backing.position === 'absolute' &&
        backing.backgroundColor === 'rgba(0, 0, 0, 0.7)' &&
        contains(titleBox) &&
        contains(eyeBox),
      leftAligned:
        !rect(subtitle) || Math.abs(plate.left - rect(subtitle).left) <= 0.5,
      colors: [getComputedStyle(subtitle).color, getComputedStyle(label).color],
      dim,
      secondary,
    };
  });

function checkSceneChrome(name, before, after) {
  const stable = Object.keys(before.positions).every((key) => {
    const a = before.positions[key];
    const b = after.positions[key];
    return a && b
      ? Object.keys(a).every((side) => Math.abs(a[side] - b[side]) <= 0.5)
      : a === b;
  });
  check(`${name}: title, eye and subtitle stay in place across Scope`, stable, {
    before,
    after,
  });
  check(
    `${name}: OFF title plate covers the eye and aligns with the subtitle`,
    before.titleUnbacked && after.titleCovered && after.leftAligned,
    after,
  );
  check(
    `${name}: secondary labels brighten only with Scope OFF`,
    before.colors.every((color) => color === before.dim) &&
      after.colors.every((color) => color === after.secondary),
    { before: before.colors, after: after.colors },
  );
}

async function openApplication(url) {
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.styleManager?._applicationShortcuts,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        cover?.classList.contains('hidden') &&
        Number(getComputedStyle(cover).opacity) === 0
      );
    },
    { timeout: 60_000 },
  );
}

try {
  await page.setViewport({ width: 1440, height: 900 });
  const url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
  url.searchParams.set('welcome', '0');
  // This browser has a fresh profile. Start without authored state so the
  // first assertion exercises the defaults rather than a share-link restore.
  url.hash = '';
  await openApplication(url);
  const fresh = await readScope();
  check(
    'bare-URL fresh boot opens Scope ON with 100% feather',
    fresh.enabled &&
      fresh.checked &&
      !fresh.disabled &&
      fresh.feather === 1 &&
      fresh.value === 100 &&
      fresh.readout === '100%' &&
      fresh.cornerAlpha > 0,
    fresh,
  );

  // Use a known city view for canvas and readability checks below.
  url.hash =
    'v=2&lat=30.2672&lon=-97.7431&alt=2500&heading=0&pitch=-45&roll=0&map=esri&sc=1&scf=100&l=';
  // Changing only the hash does not rerun startup restoration. Leave the app
  // document first so this fixture is applied by a new application boot.
  await page.goto('about:blank');
  await openApplication(url);
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    });
    manager.hud.setMode('on');
    manager.setStyle('normal');
  });
  const initial = await readScope();
  check(
    'Austin fixture restores Scope ON and 100% feather',
    initial.enabled &&
      initial.checked &&
      !initial.disabled &&
      initial.feather === 1 &&
      initial.value === 100 &&
      initial.readout === '100%' &&
      initial.cornerAlpha > 0,
    initial,
  );
  const name = await page.$eval('#scope-toggle', (el) => ({
    type: el.type,
    label: el.labels?.[0]?.textContent.trim(),
  }));
  check(
    'Scope uses a native checkbox with a visible label',
    name.type === 'checkbox' && name.label?.includes('Scope'),
    name,
  );
  await page.click('#scope-toggle');
  const off = await readScope();
  check(
    'click disables Scope and its feather slider',
    !off.enabled &&
      !off.checked &&
      off.disabled &&
      off.feather === 1 &&
      off.cornerAlpha === 0,
    off,
  );
  await page.focus('#scope-toggle');
  await page.keyboard.press('Space');
  const on = await readScope();
  check(
    'Space re-enables the native checkbox without losing feather',
    on.enabled &&
      on.checked &&
      !on.disabled &&
      on.feather === 1 &&
      on.cornerAlpha > 0,
    on,
  );

  const paintedAlpha = [];
  for (const pct of [0, 11, 100, 200]) {
    await page.$eval(
      '#scope-feather-slider',
      (el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      pct,
    );
    const state = await readScope();
    paintedAlpha.push(state.radialAlpha);
    check(
      `feather ${pct}% reaches the mask and readout`,
      state.value === pct &&
        state.feather === pct / 100 &&
        state.readout === `${pct}%`,
      state,
    );
  }
  check(
    'painted gradient widens beyond the old 100% ceiling',
    paintedAlpha[0] === 0 &&
      paintedAlpha[1] === 0 &&
      paintedAlpha[2] > 0 &&
      paintedAlpha[3] > paintedAlpha[2],
    paintedAlpha,
  );
  await page.focus('#scope-feather-slider');
  await page.keyboard.press('Home');
  check('native Home reaches the hard edge', (await readScope()).feather === 0);
  await page.keyboard.press('End');
  check(
    'native End reaches the expanded 200% maximum',
    (await readScope()).feather === 2,
  );
  await page.click('#scope-toggle');
  for (const layout of ['minimal', 'operator', 'cyber', 'tactical']) {
    await page.select('#hud-layout-select', layout);
    const state = await readScope();
    check(
      `Scope OFF and 200% survive ${layout}`,
      !state.enabled &&
        !state.checked &&
        state.disabled &&
        state.feather === 2 &&
        state.value === 200 &&
        state.cornerAlpha === 0,
      state,
    );
  }

  const restored = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const links = manager.shareLinkManager;
    manager._syncShareState();
    const params = links._buildHashParams();
    const encoded = { enabled: params.get('sc'), feather: params.get('scf') };
    await manager.applyVisualState({ scope: { enabled: true, featherPct: 0 } });
    await manager._visualSettings.restoreShareState({
      scopeEnabled: encoded.enabled === '1',
      scopeFeatherPct: Number(encoded.feather),
    });
    const shared = manager.getVisualState().scope;
    await manager.applyVisualState({
      scope: { enabled: true, featherPct: 200 },
    });
    const scene = manager.getVisualState().scope;
    await manager.applyVisualState({
      scope: { enabled: false, featherPct: 200 },
    });
    return { encoded, shared, scene };
  });
  check(
    'share state serializes and restores Scope OFF with 200%',
    restored.encoded.enabled === '0' &&
      restored.encoded.feather === '200' &&
      restored.shared.enabled === false &&
      restored.shared.featherPct === 200,
    restored,
  );
  check(
    'scene state restores Scope ON with 200%',
    restored.scene.enabled === true && restored.scene.featherPct === 200,
    restored,
  );

  for (const layout of ['minimal', 'operator', 'tactical']) {
    await page.select('#hud-layout-select', layout);
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.applyVisualState({
        scope: { enabled: true, featherPct: 100 },
      }),
    );
    await settleTextBackings(true);
    const originalGlyphs = await readHudGlyphs();
    const originalChrome = await readSceneChrome();
    const original = await page.evaluate(() => {
      const hud = document.getElementById('intel-hud');
      const wrappers = [...hud.querySelectorAll('.hud-readout')];
      const scene = [...document.querySelectorAll('.scene-text-holdout')];
      const unexpectedBackings = [...wrappers, ...scene]
        .map((el) => {
          const style = getComputedStyle(el);
          return {
            selector: el.id || el.className,
            background: style.backgroundColor,
            shadow: style.boxShadow,
          };
        })
        .filter(
          (style) =>
            style.background !== 'rgba(0, 0, 0, 0)' || style.shadow !== 'none',
        );
      return {
        markerAbsent: !document.documentElement.hasAttribute('data-scope-mask'),
        unbacked: unexpectedBackings.length === 0,
        unexpectedBackings,
        wrappersTransparent: wrappers.every(
          (el) => getComputedStyle(el).display === 'contents',
        ),
        operatorFrame:
          hud.dataset.variant !== 'operator' ||
          (getComputedStyle(hud.querySelector('.hud-corner'))
            .backgroundColor === 'rgba(0, 0, 0, 0.36)' &&
            getComputedStyle(hud.querySelector('.hud-top-bar'))
              .backgroundImage !== 'none'),
      };
    });
    check(
      `${layout}: Scope ON retains the original presentation without new backplates`,
      original.markerAbsent &&
        original.unbacked &&
        original.wrappersTransparent &&
        original.operatorFrame,
      original,
    );
    check(
      `${layout}: original HUD color, glow and metadata alpha remain intact`,
      originalGlyphs.glyphs.every(
        (glyph) =>
          glyph.color === originalGlyphs.baseline.color &&
          glyph.shadow === originalGlyphs.baseline.shadow,
      ) &&
        originalGlyphs.glyphs.find(
          (glyph) => glyph.selector === '.hud-summary-label',
        ).opacity === 0.55 &&
        originalGlyphs.glyphs.find((glyph) => glyph.selector === '.hud-orbital')
          .opacity === 0.7 &&
        originalGlyphs.glyphs.find((glyph) => glyph.selector === '#hud-coll')
          .opacity === 0.5,
      originalGlyphs,
    );
    if (process.env.QA_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.QA_SCREENSHOT_DIR,
          `scope-on-${layout}.png`,
        ),
      });
    }
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.applyVisualState({
        scope: { enabled: false },
      }),
    );
    await settleTextBackings(false);
    const backedGlyphs = await readHudGlyphs();
    checkSceneChrome(layout, originalChrome, await readSceneChrome());
    check(
      `${layout}: Scope OFF adds backing without changing glyph styles`,
      JSON.stringify(backedGlyphs) === JSON.stringify(originalGlyphs),
      backedGlyphs,
    );
    const coverage = await page.evaluate(() => {
      const hud = document.getElementById('intel-hud');
      const walker = document.createTreeWalker(hud, NodeFilter.SHOW_TEXT);
      const missing = [];
      let visible = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (
          !node.textContent.trim() ||
          node.parentElement.closest('.hud-bracket')
        )
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (
          ![...range.getClientRects()].some(
            (rect) => rect.width > 0 && rect.height > 0,
          )
        )
          continue;
        visible += 1;
        const backing = node.parentElement.closest('.hud-readout');
        const color = backing && getComputedStyle(backing).backgroundColor;
        if (
          !backing ||
          color !== 'rgba(0, 0, 0, 0.7)' ||
          getComputedStyle(backing).boxShadow !== 'none' ||
          backing.parentElement.closest('.hud-readout')
        )
          missing.push(node.textContent.trim());
      }
      const wrapped = [...hud.querySelectorAll('.hud-readout')].filter(
        (el) => el.offsetWidth > 0 && el.offsetHeight > 0,
      );
      const empty = wrapped.filter((el) => !el.innerText.trim()).length;
      const overlaps = [];
      for (const parent of new Set(wrapped.map((el) => el.parentElement))) {
        const siblings = wrapped.filter((el) => el.parentElement === parent);
        for (let i = 1; i < siblings.length; i += 1) {
          const previous = siblings[i - 1].getBoundingClientRect();
          const current = siblings[i].getBoundingClientRect();
          const horizontal =
            Math.min(previous.right, current.right) -
            Math.max(previous.left, current.left);
          const vertical =
            Math.min(previous.bottom, current.bottom) -
            Math.max(previous.top, current.top);
          // Horizontal bars share a vertical band. Only intersecting text boxes
          // can stack their backing alpha; allow subpixel layout rounding.
          if (horizontal > 0.5 && vertical > 0.5) {
            overlaps.push({
              parent: parent.className,
              previous: siblings[i - 1].innerText,
              current: siblings[i].innerText,
              vertical,
            });
          }
        }
      }
      const lineIds = [
        'hud-mgrs',
        'hud-latlon',
        'hud-gsd',
        'hud-alt',
        'hud-timestamp',
        'hud-bottom-line',
      ];
      const multiline = lineIds.filter((id) => {
        const el = document.getElementById(id);
        if (!el.getClientRects().length) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
        return (
          range.getBoundingClientRect().height >
          parseFloat(getComputedStyle(el).lineHeight) * 1.5
        );
      });
      const edges = [...hud.querySelectorAll('.hud-edge')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => {
          const box = el.querySelector('.hud-readout').getBoundingClientRect();
          return (
            getComputedStyle(el).transform !== 'none' &&
            box.height > box.width &&
            Number(getComputedStyle(el).opacity) === 1
          );
        });
      const broadBackings = [
        ...hud.querySelectorAll('.hud-corner, .hud-top-bar, .hud-bottom-bar'),
      ].filter(
        (el) =>
          el.offsetWidth > 0 &&
          getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)',
      );
      return {
        scopeOff: document.documentElement.dataset.scopeMask === 'off',
        visible,
        missing,
        empty,
        overlaps,
        multiline,
        edges,
        broadBackings: broadBackings.length,
      };
    });
    check(
      `${layout}: all visible HUD text has one backing`,
      coverage.scopeOff &&
        coverage.visible > 0 &&
        coverage.missing.length === 0 &&
        coverage.empty === 0 &&
        coverage.broadBackings === 0,
      coverage,
    );
    check(
      `${layout}: adjacent readout backings do not overlap`,
      coverage.overlaps.length === 0,
      coverage,
    );
    check(
      `${layout}: desktop telemetry remains single line; rotated backing follows the labels`,
      coverage.multiline.length === 0 && coverage.edges.every(Boolean),
      coverage,
    );
    if (process.env.QA_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.QA_SCREENSHOT_DIR,
          `scope-off-${layout}.png`,
        ),
      });
    }
  }
  const details = await page.evaluate(() => {
    const summary = document.getElementById('hud-summary');
    summary.textContent = 'LONG TELEMETRY SUMMARY '.repeat(30);
    const ais = document.getElementById('hud-ais-vessel');
    ais.textContent = 'AIS: 4 VESSELS\nLATEST OBSERVATION';
    return {
      summaryClipped:
        summary.scrollWidth > summary.clientWidth &&
        getComputedStyle(summary).textOverflow === 'ellipsis',
      aisMultiline:
        getComputedStyle(ais).whiteSpace === 'pre-line' &&
        ais.textContent.split('\n').length === 2 &&
        ais.getBoundingClientRect().height + 0.5 >=
          parseFloat(getComputedStyle(ais).lineHeight) * 2,
      recColor: getComputedStyle(document.getElementById('hud-rec-dot')).color,
    };
  });
  check(
    'summary clipping, multiline AIS and red REC dot retain their behavior',
    details.summaryClipped &&
      details.aisMultiline &&
      details.recColor === 'rgb(255, 51, 51)',
    details,
  );
  await page.setViewport({ width: 390, height: 844 });
  await page.select('#hud-layout-select', 'minimal');
  const narrow = await page.evaluate(() =>
    [...document.querySelectorAll('#intel-hud .hud-readout')]
      .filter(
        (el) =>
          el.getClientRects().length &&
          getComputedStyle(el).display !== 'contents',
      )
      .every((el) => {
        const box = el.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
  );
  check('narrow HUD text backings stay within the viewport', narrow);
  for (const layout of ['minimal', 'operator', 'tactical']) {
    await page.select('#hud-layout-select', layout);
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.applyVisualState({
        scope: { enabled: true },
      }),
    );
    await settleTextBackings(true);
    const before = await readSceneChrome();
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.applyVisualState({
        scope: { enabled: false },
      }),
    );
    await settleTextBackings(false);
    checkSceneChrome(`narrow ${layout}`, before, await readSceneChrome());
  }
  check('runtime has no uncaught browser errors', errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
