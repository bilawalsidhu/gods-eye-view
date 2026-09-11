#!/usr/bin/env node
/** Focused browser proof for the responsive, accessible Map Source tray. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.env.QA_SHOTS_DIR || path.join(repoRoot, 'qa-shots', 'map-source-tray');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
// The no-ion-token contract is a real shipped state that a normal keyed
// `dev-fresh.sh` run can never reach, so it went untested on every machine that
// has a token. `--keyless` (or QA_MAP_SOURCE_TRAY_KEYLESS=1) clears the
// controller's token in-page before the key-required assertions, so one server
// can prove both branches. It forces the keyless EXPECTATIONS as well: a seam
// that fails to take effect is a failure, not a quiet fall-through to the keyed
// branch.
const forceKeyless = process.argv.includes('--keyless')
  || process.env.QA_MAP_SOURCE_TRAY_KEYLESS === '1';
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || await puppeteer.executablePath().catch(() => null);

if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}
fs.mkdirSync(shotsDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  // Metal is a macOS-only ANGLE backend: passing it on Windows or Linux makes
  // WebGL initialization fail outright, so Cesium never constructs and this
  // harness dies at the boot wait before a single assertion runs.
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
const failures = [];
const consoleErrors = [];

page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource.*404/i.test(message.text())) {
    const source = message.location()?.url;
    consoleErrors.push(source ? `${message.text()} [${source}]` : message.text());
  }
});
page.on('pageerror', (error) => consoleErrors.push(error.message));

const check = (name, passed, detail = '') => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

const trayMetrics = () => page.evaluate(() => {
  const panel = document.getElementById('control-panel');
  const popover = document.getElementById('control-panel-popover');
  const row = document.getElementById('map-stack-chips');
  const popoverRect = popover.getBoundingClientRect();
  const chips = [...row.children].map((chip) => {
    const rect = chip.getBoundingClientRect();
    return {
      id: chip.dataset.stackId,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      pressed: chip.getAttribute('aria-pressed'),
      ariaDisabled: chip.getAttribute('aria-disabled'),
      ariaLabel: chip.getAttribute('aria-label'),
    };
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    pinned: panel.classList.contains('dock-pinned'),
    popover: {
      left: popoverRect.left,
      right: popoverRect.right,
      top: popoverRect.top,
      bottom: popoverRect.bottom,
      width: popoverRect.width,
    },
    columns: getComputedStyle(row).gridTemplateColumns,
    rows: new Set(chips.map((chip) => chip.top)).size,
    chips,
  };
});

// Observe rendered focus, including clipping by the scrolling style row. A
// focus-visible match alone does not prove that the keyboard user sees a ring.
const focusMetrics = (selector = '.style-btn') => page.evaluate((match) => {
  const button = document.activeElement;
  if (!button?.matches(match)) return { focusedStyle: null, focusedId: null };
  const rect = button.getBoundingClientRect();
  const css = getComputedStyle(button);
  const outlineWidth = parseFloat(css.outlineWidth) || 0;
  const outlineOffset = parseFloat(css.outlineOffset) || 0;
  const outset = Math.max(0, outlineWidth + outlineOffset);
  const ring = {
    left: rect.left - outset, right: rect.right + outset,
    top: rect.top - outset, bottom: rect.bottom + outset,
  };
  const clips = [];
  for (let parent = button.parentElement; parent; parent = parent.parentElement) {
    const parentCss = getComputedStyle(parent);
    const parentRect = parent.getBoundingClientRect();
    const left = parentRect.left + parent.clientLeft;
    const top = parentRect.top + parent.clientTop;
    if (/auto|scroll|hidden|clip/.test(parentCss.overflowX)
        && (ring.left < left - 1 || ring.right > left + parent.clientWidth + 1)) {
      clips.push(`${parent.id || parent.className}:horizontal`);
    }
    if (/auto|scroll|hidden|clip/.test(parentCss.overflowY)
        && (ring.top < top - 1 || ring.bottom > top + parent.clientHeight + 1)) {
      clips.push(`${parent.id || parent.className}:vertical`);
    }
  }
  const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    focusedStyle: button.dataset.style, focusedId: button.id || null, tag: button.tagName, type: button.type,
    layerId: button.closest('[data-layer-id]')?.dataset.layerId || null,
    text: button.textContent.trim(), ariaLabel: button.getAttribute('aria-label'),
    controls: button.getAttribute('aria-controls'), expanded: button.getAttribute('aria-expanded'),
    selectedStyle: window.__godsEyeView.styleManager.activeStyle,
    selectedMap: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
    focusVisible: button.matches(':focus-visible'),
    selected: button.classList.contains('active'),
    outlineStyle: css.outlineStyle, outlineWidth, outlineOffset, outlineColor: css.outlineColor,
    visible: rect.width > 0 && rect.height > 0 && css.visibility === 'visible'
      && (center === button || button.contains(center)),
    insideViewport: ring.left >= 0 && ring.right <= innerWidth
      && ring.top >= 0 && ring.bottom <= innerHeight,
    clips,
    ring,
    viewport: { width: innerWidth, height: innerHeight },
    rowScrollLeft: document.getElementById('style-buttons').scrollLeft,
  };
}, selector);
const styleFocusMetrics = () => focusMetrics('.style-btn');
const hasVisibleControlFocus = (state) => state.focusVisible && state.visible && state.insideViewport && state.clips.length === 0
  && state.outlineStyle !== 'none' && state.outlineStyle !== 'hidden' && state.outlineWidth >= 2
  && state.outlineColor !== 'transparent' && state.outlineColor !== 'rgba(0, 0, 0, 0)';
const hasVisibleStyleFocus = (state, style) => state.focusedStyle === style && hasVisibleControlFocus(state);
const pressTabs = async (count, backwards = false) => {
  if (backwards) await page.keyboard.down('Shift');
  try {
    for (let index = 0; index < count; index += 1) await page.keyboard.press('Tab');
  } finally {
    if (backwards) await page.keyboard.up('Shift');
  }
  // The row scrolls smoothly when native Tab brings an edge button into view.
  await new Promise((resolve) => setTimeout(resolve, 250));
};
const checkResponsiveStyleFocus = async (width) => {
  // The disclosure is only the starting boundary. Every style target below is
  // reached by actual Tab events, never by focusing the style under test.
  const selectedMapBefore = await page.evaluate(() => (
    window.__godsEyeView.styleManager.mapStackController.getActiveId()
  ));
  await page.focus('#control-panel-toggle');
  await pressTabs(2); // disclosure -> pin -> Normal
  for (const [index, style] of ['normal', 'thermal', 'snow'].entries()) {
    if (index) await pressTabs(3);
    const state = await styleFocusMetrics();
    check(`${width} px ${style} keyboard ring is visible and unclipped`,
      hasVisibleStyleFocus(state, style) && state.selectedStyle === 'normal'
        && state.selectedMap === selectedMapBefore, JSON.stringify(state));
    await page.screenshot({ path: path.join(shotsDir, `${width}-style-${style}-focus.png`) });
  }
};

// Start from an explicit boundary, then use real Tab events for every target.
// No layer or location action is activated merely to establish keyboard focus.
const tabTo = async (selector, { backwards = false, limit = 160 } = {}) => {
  if (backwards) await page.keyboard.down('Shift');
  try {
    for (let step = 1; step <= limit; step += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((match) => document.activeElement?.matches(match), selector)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { reached: true, steps: step };
      }
    }
    return { reached: false, steps: limit };
  } finally {
    if (backwards) await page.keyboard.up('Shift');
  }
};
const locationState = async () => ({
  ...await focusMetrics('#location-bar-toggle'),
  ...await page.evaluate(() => {
    const panel = document.getElementById('location-bar');
    const toggle = document.getElementById('location-bar-toggle');
    const voice = window.__godsEyeView.voiceCommands;
    return {
      locationExpanded: toggle?.getAttribute('aria-expanded'),
      locationLabel: toggle?.getAttribute('aria-label'),
      popoverId: panel.querySelector('.dock-popover-content')?.id,
      pinned: panel.classList.contains('dock-pinned'),
      searchExpanded: document.getElementById('location-search').classList.contains('expanded'),
      searchValue: document.getElementById('location-search').value,
      transitions: [...(window.__qaLocationFocus?.transitions || [])],
      voice: { status: voice.status, epoch: voice.startEpoch, held: voice.spaceKeyHeld, pushToTalk: voice.pushToTalkKeyHeld },
    };
  }),
});
const resetLocationTransitions = () => page.evaluate(() => { window.__qaLocationFocus.transitions = []; });
const layerFocusState = async (id) => ({
  ...await focusMetrics('.data-toggle-btn'),
  ...await page.evaluate((layerId) => {
    const manager = window.__godsEyeView.dataManager;
    const button = document.querySelector(`[data-layer-id="${layerId}"] .data-toggle-btn`);
    const list = document.getElementById('data-toggles');
    return {
      lifecycle: manager.getLayerLifecycleState(layerId),
      feedState: button?.dataset.feedState, label: button?.textContent.trim(),
      buttonActive: button?.classList.contains('active'),
      disabled: button?.disabled,
      ariaDisabled: button?.getAttribute('aria-disabled'),
      ariaBusy: button?.getAttribute('aria-busy'),
      listScrollTop: list.scrollTop, listClientHeight: list.clientHeight, listScrollHeight: list.scrollHeight,
    };
  }, id),
});

try {
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/openai/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'Map Source tray QA' }),
      });
      return;
    }
    // Share-link navigation asks for optional Google place context. This
    // harness is about the map-source tray, so keep that unrelated keyed proxy
    // hermetic and quiet just as the HUD summary is above.
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/google/nearby-places') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ places: [] }),
      });
      return;
    }
    request.continue();
  });
  // This harness owns the Map Source keyboard. Suppress the separate first-run
  // launcher on every navigation so its Escape/Space handlers cannot turn a
  // tray assertion into a mission or voice action in a pristine browser.
  await page.goto(`${appUrl}/?welcome=0`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 60_000 });
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );

  const presentation = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.map-stack-chip')].map((chip) => chip.dataset.stackId),
    retiredPanel: Boolean(document.getElementById('stack-panel')),
    toggleTag: document.getElementById('control-panel-toggle')?.tagName,
    controls: document.getElementById('control-panel-toggle')?.getAttribute('aria-controls'),
  }));
  check(
    'exact five-source presentation; the retired left Map Stack panel is gone',
    JSON.stringify(presentation.ids) === JSON.stringify([
      'photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm',
    ]) && !presentation.retiredPanel,
    JSON.stringify(presentation),
  );
  check(
    'compact wing is a semantic disclosure',
    presentation.toggleTag === 'BUTTON' && presentation.controls === 'control-panel-popover',
    JSON.stringify(presentation),
  );

  const esriTileFailureFallback = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const controller = styleManager.mapStackController;
    await styleManager._setMapStack('esri-imagery', { syncShare: false });
    // Cesium updates on-screen credits on a rendered frame, after setStack
    // resolves. Observe that boundary before checking the visible source.
    const creditDeadline = performance.now() + 5000;
    while (!document.body.innerText.includes('Powered by Esri') && performance.now() < creditDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const provider = controller._activeImageryProvider;
    const before = {
      activeId: controller.getActiveId(),
      creditVisible: document.body.innerText.includes('Powered by Esri'),
      globeShown: styleManager.viewer.scene.globe.show,
      hasLayer: Boolean(controller._imageryLayer),
    };
    provider?.errorEvent?.raiseEvent?.({ timesRetried: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterOne = controller.getActiveId();
    provider?.errorEvent?.raiseEvent?.({ timesRetried: 1 });
    const deadline = performance.now() + 5000;
    while (controller.getActiveId() !== 'osm' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The controller commits `activeId` before its fallback promise callback
    // emits the terminal error state that re-syncs the chips, and Cesium drops
    // the Esri credit on a later render frame again. A fixed delay races both:
    // 50ms was enough most runs and not enough on a slow one, which is the same
    // flake as the tray timers above (#54). Poll the observable truth instead.
    const domDeadline = performance.now() + 3000;
    const settled = () => !document.body.innerText.includes('Powered by Esri')
      && JSON.stringify([...document.querySelectorAll('.map-stack-chip[aria-pressed="true"]')]
        .map((chip) => chip.dataset.stackId)) === JSON.stringify(['osm']);
    while (!settled() && performance.now() < domDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const afterTwo = {
      activeId: controller.getActiveId(),
      lastError: controller.getState().lastError,
      creditVisible: document.body.innerText.includes('Powered by Esri'),
      globeShown: styleManager.viewer.scene.globe.show,
      hasLayer: Boolean(controller._imageryLayer),
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    await styleManager._setMapStack('esri-imagery', { syncShare: false });
    return { before, afterOne, afterTwo };
  });
  check(
    'two active Esri tile failures fall back to a rendered, truthful OSM stack',
    esriTileFailureFallback.before.activeId === 'esri-imagery'
      && esriTileFailureFallback.before.creditVisible
      && esriTileFailureFallback.before.globeShown
      && esriTileFailureFallback.before.hasLayer
      && esriTileFailureFallback.afterOne === 'esri-imagery'
      && esriTileFailureFallback.afterTwo.activeId === 'osm'
      && /tile requests failed; using OSM/i.test(esriTileFailureFallback.afterTwo.lastError)
      && esriTileFailureFallback.afterTwo.creditVisible === false
      && esriTileFailureFallback.afterTwo.globeShown
      && esriTileFailureFallback.afterTwo.hasLayer
      && JSON.stringify(esriTileFailureFallback.afterTwo.active) === JSON.stringify(['osm']),
    JSON.stringify(esriTileFailureFallback),
  );

  // The tray's state changes are timer-driven: opening schedules the focus
  // hand-off to a Map Source tile 240ms later (scheduleMapSourceFocus in
  // ui.js). A fixed sleep races that timer rather than observing it settle —
  // 300ms left only 60ms of margin, which is what made these checks flake on
  // a clean checkout (#54). Wait on controller truth instead, the way the
  // Bing-switch check further down already does.
  // The wait only settles state; the check() below it is still the assertion,
  // so a swallowed timeout surfaces as that check failing with real values
  // rather than as an opaque puppeteer error.
  const waitTray = (wantExpanded, wantFocus) => page.waitForFunction(
    (expanded, focus) => {
      const toggle = document.getElementById('control-panel-toggle');
      if (toggle?.getAttribute('aria-expanded') !== expanded) return false;
      if (!focus) return true;
      const active = document.activeElement;
      return focus === 'toggle'
        ? active?.id === 'control-panel-toggle'
        : active?.dataset?.stackId === focus;
    },
    { timeout: 2000 },
    wantExpanded, wantFocus,
  ).catch(() => {});

  await page.evaluate(() => window.__godsEyeView.styleManager._setMapStack('osm', { syncShare: false }));
  const keyboardSource = await page.evaluate(() => (
    window.__godsEyeView.styleManager.mapStackController.getActiveId()
  ));
  check('keyboard checks start on selected OSM as the last tile',
    keyboardSource === 'osm' && await page.evaluate(() => (
      document.querySelector('#map-stack-chips .map-stack-chip:last-child')?.dataset.stackId === 'osm'
    )));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await waitTray('true', keyboardSource);
  const keyboardOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'Enter opens the tray and hands focus to the selected Map Source tile',
    keyboardOpen.expanded === 'true' && keyboardOpen.activeStack === keyboardSource,
    JSON.stringify(keyboardOpen),
  );

  await page.keyboard.press('Escape');
  await waitTray('false', 'toggle');
  const keyboardClose = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeId: document.activeElement?.id || null,
  }));
  check(
    'Escape closes the tray and restores disclosure focus',
    keyboardClose.expanded === 'false' && keyboardClose.activeId === 'control-panel-toggle',
    JSON.stringify(keyboardClose),
  );

  await page.keyboard.press('Space');
  await waitTray('true', keyboardSource);
  const spaceOpen = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'Space opens the tray through the same keyboard path',
    spaceOpen.expanded === 'true' && spaceOpen.activeStack === keyboardSource,
    JSON.stringify(spaceOpen),
  );

  await page.keyboard.press('Escape');
  await page.keyboard.down('Enter');
  await new Promise((resolve) => setTimeout(resolve, 320));
  await page.keyboard.up('Enter');
  await waitTray('true', keyboardSource); // let the hold's scheduled focus hand-off land
  await page.keyboard.press('Escape');
  await waitTray('false', 'toggle');
  await page.keyboard.press('Enter');
  await waitTray('true', keyboardSource);
  const longHoldRecovery = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
    activeStack: document.activeElement?.dataset?.stackId || null,
  }));
  check(
    'long Enter hold cannot strand the disclosure keyboard path',
    longHoldRecovery.expanded === 'true' && longHoldRecovery.activeStack === keyboardSource,
    JSON.stringify(longHoldRecovery),
  );

  // Force a delayed visible state while using the real controller and keyboard routes.
  const hideTray = () => page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setPanelCollapsed('control-panel', true);
    window.__qaTrayStyles = [...document.querySelectorAll('.map-stack-chip')]
      .map((chip) => [chip, chip.style.cssText]);
    for (const [chip] of window.__qaTrayStyles) chip.style.setProperty('visibility', 'hidden', 'important');
    document.getElementById('control-panel-toggle').focus();
  });
  const showTray = () => page.evaluate(() => {
    for (const [chip, cssText] of window.__qaTrayStyles) chip.style.cssText = cssText;
    delete window.__qaTrayStyles;
  });
  await hideTray();
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const delayedBefore = await page.evaluate(() => document.activeElement?.id);
  await showTray();
  await waitTray('true', keyboardSource);
  const delayedAfter = await page.evaluate(() => document.activeElement?.dataset?.stackId);
  check('a delayed visible tray receives selected-source focus after the first attempt',
    delayedBefore === 'control-panel-toggle' && delayedAfter === keyboardSource,
    JSON.stringify({ delayedBefore, delayedAfter, keyboardSource }));

  await hideTray();
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 350));
  await page.keyboard.press('Tab');
  const departure = await page.evaluate(() => {
    window.__qaDepartedFocus = document.activeElement;
    return document.activeElement !== document.getElementById('control-panel-toggle');
  });
  await showTray();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const focusRetained = await page.evaluate(() => {
    const same = document.activeElement === window.__qaDepartedFocus;
    delete window.__qaDepartedFocus;
    return same;
  });
  check('Tab away during the opening transition revokes delayed focus', departure && focusRetained,
    JSON.stringify({ departure, focusRetained }));

  await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('control-panel', true, { explicit: true }));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  check('Escape cancels the pending opening handoff', await page.evaluate(() => (
    document.activeElement === document.body
      && document.getElementById('control-panel').classList.contains('collapsed')
  )));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await waitTray('true', keyboardSource);

  await page.keyboard.press('Escape');
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  const leftBeforeReturn = await page.evaluate(() => document.activeElement?.id !== 'control-panel-toggle');
  await page.focus('#control-panel-toggle');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  check('returning to the disclosure does not revive a cancelled keyboard opening',
    leftBeforeReturn && await page.evaluate(() => document.activeElement?.id === 'control-panel-toggle'));

  await page.keyboard.press('Escape');
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('control-panel', false));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  check('programmatic reopening cannot inherit a cancelled keyboard handoff', await page.evaluate(() => (
    document.activeElement === document.body
      && document.getElementById('control-panel-toggle').getAttribute('aria-expanded') === 'true'
  )));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Escape');
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await waitTray('true', keyboardSource);

  // Visual Styles precede the five Map Source tiles. Keep the existing opening
  // handoff to selected OSM, then use the user's real Shift+Tab path into styles.
  await pressTabs(5, true);
  const snowFocus = await styleFocusMetrics();
  check('Shift+Tab reaches Snow with a visible ring while Normal and OSM stay selected',
    hasVisibleStyleFocus(snowFocus, 'snow') && !snowFocus.selected
      && snowFocus.selectedStyle === 'normal' && snowFocus.selectedMap === 'osm',
    JSON.stringify(snowFocus));
  await page.screenshot({ path: path.join(shotsDir, 'keyboard-style-focus.png') });
  await pressTabs(3, true);
  const middleFocus = await styleFocusMetrics();
  check('Shift+Tab traverses the middle FLIR style without activating it',
    hasVisibleStyleFocus(middleFocus, 'thermal') && !middleFocus.selected
      && middleFocus.selectedStyle === 'normal' && middleFocus.selectedMap === 'osm',
    JSON.stringify(middleFocus));
  await pressTabs(2, true);
  await page.keyboard.press('Enter');
  const enterStyle = await styleFocusMetrics();
  check('Enter activates the focused CRT style and preserves selected OSM',
    enterStyle.focusedStyle === 'retro' && enterStyle.selectedStyle === 'retro'
      && enterStyle.selected && enterStyle.selectedMap === 'osm', JSON.stringify(enterStyle));
  await pressTabs(1, true);
  const normalFocus = await styleFocusMetrics();
  check('the first Normal style has a focus ring independent from selected CRT',
    hasVisibleStyleFocus(normalFocus, 'normal') && !normalFocus.selected
      && normalFocus.selectedStyle === 'retro' && normalFocus.selectedMap === 'osm',
    JSON.stringify(normalFocus));

  // Count real native clicks and calls into the unchanged style implementation.
  // Stub only the provider start seam so timing and focus arbitration can be
  // exercised without opening a live microphone session during browser QA.
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const voice = window.__godsEyeView.voiceCommands;
    const grid = document.getElementById('style-buttons');
    const root = document.getElementById('gev-voice-control');
    const originalSetStyle = manager.setStyle;
    const originalVoiceStart = voice.start;
    const probe = { events: [], activations: [], voiceMutations: [], voiceStarts: [] };
    const voiceState = () => ({
      present: Boolean(voice && root), status: voice?.status, startEpoch: voice?.startEpoch,
      spaceKeyHeld: voice?.spaceKeyHeld, pushToTalkKeyHeld: voice?.pushToTalkKeyHeld,
      pushToTalkMode: voice?.pushToTalkMode, radioVoiceDucked: voice?.radioVoiceDucked,
      visibleStatus: root?.dataset.status, visibleHold: root?.dataset.pushToTalk || null,
    });
    const record = (event) => probe.events.push({
      type: event.type, code: event.code || null, repeat: event.repeat || false,
      trusted: event.isTrusted, detail: event.detail ?? null,
      style: event.target.closest('.style-btn')?.dataset.style || null,
    });
    for (const type of ['keydown', 'keyup', 'click']) grid.addEventListener(type, record, true);
    manager.setStyle = function (...args) {
      probe.activations.push(args[0]);
      return originalSetStyle.apply(this, args);
    };
    voice.start = async function (options) {
      probe.voiceStarts.push({
        options: { ...options },
        focusedStyle: document.activeElement?.dataset.style || null,
        activeTag: document.activeElement?.tagName || null,
      });
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) probe.voiceMutations.push({
        attribute: record.attributeName, oldValue: record.oldValue,
        value: root.getAttribute(record.attributeName),
      });
    });
    if (root) observer.observe(root, {
      attributes: true, attributeOldValue: true, attributeFilter: ['data-status', 'data-push-to-talk'],
    });
    probe.voiceBefore = voiceState();
    probe.snapshot = () => ({
      events: [...probe.events], activations: [...probe.activations], voiceMutations: [...probe.voiceMutations],
      voiceStarts: [...probe.voiceStarts],
      voiceBefore: probe.voiceBefore, voiceNow: voiceState(),
      selectedStyle: manager.activeStyle, selectedMap: manager.mapStackController.getActiveId(),
      focusedStyle: document.activeElement?.dataset.style || null,
    });
    probe.reset = () => {
      probe.events.length = 0;
      probe.activations.length = 0;
      probe.voiceMutations.length = 0;
      probe.voiceStarts.length = 0;
      probe.voiceBefore = voiceState();
    };
    probe.restore = () => {
      manager.setStyle = originalSetStyle;
      voice.start = originalVoiceStart;
      observer.disconnect();
      for (const type of ['keydown', 'keyup', 'click']) grid.removeEventListener(type, record, true);
    };
    window.__qaStyleKeyProbe = probe;
  });
  let shortSpaceDown;
  let shortSpaceReleased;
  let longSpaceDown;
  let longSpaceHeld;
  let longSpaceReleased;
  let styleSpaceIsDown = false;
  try {
    await page.keyboard.down('Space');
    styleSpaceIsDown = true;
    shortSpaceDown = await page.evaluate(() => window.__qaStyleKeyProbe.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.keyboard.up('Space');
    styleSpaceIsDown = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    shortSpaceReleased = await page.evaluate(() => window.__qaStyleKeyProbe.snapshot());

    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setStyle('retro');
      window.__qaStyleKeyProbe.reset();
      document.querySelector('.style-btn[data-style="normal"]')?.focus();
    });
    await page.keyboard.down('Space');
    styleSpaceIsDown = true;
    longSpaceDown = await page.evaluate(() => window.__qaStyleKeyProbe.snapshot());
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.keyboard.down('Space'); // exercise repeat without resetting the hold deadline
    await new Promise((resolve) => setTimeout(resolve, 400));
    longSpaceHeld = await page.evaluate(() => window.__qaStyleKeyProbe.snapshot());
    await page.keyboard.up('Space');
    styleSpaceIsDown = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    longSpaceReleased = await page.evaluate(() => window.__qaStyleKeyProbe.snapshot());
  } finally {
    if (styleSpaceIsDown) await page.keyboard.up('Space');
    await page.evaluate(() => {
      window.__qaStyleKeyProbe?.restore();
      delete window.__qaStyleKeyProbe;
      window.__godsEyeView.styleManager.setStyle('normal');
    });
  }
  const voiceUntouched = (state) => state.voiceBefore.present
    && state.voiceStarts.length === 0 && JSON.stringify(state.voiceBefore) === JSON.stringify(state.voiceNow)
    && state.voiceMutations.length === 0;
  check('Space down on focused Normal does not activate the style or start voice',
    shortSpaceDown.focusedStyle === 'normal' && shortSpaceDown.selectedStyle === 'retro'
      && shortSpaceDown.selectedMap === 'osm' && shortSpaceDown.activations.length === 0
      && shortSpaceDown.events.every((event) => event.type !== 'click')
      && shortSpaceDown.voiceStarts.length === 0 && shortSpaceDown.voiceMutations.length === 0
      && shortSpaceDown.voiceNow.status === shortSpaceDown.voiceBefore.status
      && shortSpaceDown.voiceNow.startEpoch === shortSpaceDown.voiceBefore.startEpoch
      && shortSpaceDown.voiceNow.spaceKeyHeld === true
      && shortSpaceDown.voiceNow.pushToTalkKeyHeld === false,
    JSON.stringify(shortSpaceDown));
  const releasedClicks = shortSpaceReleased.events.filter((event) => event.type === 'click');
  check('short Space activates Normal once on trusted key release and preserves OSM',
    shortSpaceReleased.focusedStyle === 'normal' && shortSpaceReleased.selectedStyle === 'normal'
      && shortSpaceReleased.selectedMap === 'osm'
      && JSON.stringify(shortSpaceReleased.activations) === JSON.stringify(['normal'])
      && releasedClicks.length === 1 && releasedClicks[0].trusted && releasedClicks[0].detail === 0
      && shortSpaceReleased.events.some((event) => event.type === 'keyup' && event.trusted)
      && voiceUntouched(shortSpaceReleased), JSON.stringify(shortSpaceReleased));
  check('long Space blurs the focused style before requesting push-to-talk',
    longSpaceDown.focusedStyle === 'normal' && longSpaceDown.selectedStyle === 'retro'
      && longSpaceDown.activations.length === 0 && longSpaceDown.voiceStarts.length === 0
      && longSpaceHeld.focusedStyle === null && longSpaceHeld.selectedStyle === 'retro'
      && longSpaceHeld.activations.length === 0
      && longSpaceHeld.events.some((event) => event.type === 'keydown' && event.repeat && event.trusted)
      && longSpaceHeld.events.every((event) => event.type !== 'click')
      && longSpaceHeld.voiceStarts.length === 1
      && longSpaceHeld.voiceStarts[0].options.pushToTalk === true
      && longSpaceHeld.voiceStarts[0].focusedStyle === null,
    JSON.stringify({ down: longSpaceDown, held: longSpaceHeld }));
  check('releasing a claimed long Space hold does not activate the blurred style',
    longSpaceReleased.focusedStyle === null && longSpaceReleased.selectedStyle === 'retro'
      && longSpaceReleased.selectedMap === 'osm' && longSpaceReleased.activations.length === 0
      && longSpaceReleased.voiceStarts.length === 1
      && longSpaceReleased.events.every((event) => event.type !== 'click'),
    JSON.stringify(longSpaceReleased));

  if (forceKeyless) {
    await page.evaluate(async () => {
      const styleManager = window.__godsEyeView.styleManager;
      const controller = styleManager.mapStackController;
      if (controller.googleTileset) controller.googleTileset.show = false;
      controller.googleTileset = null;
      controller.cesiumToken = '';
      await styleManager._setMapStack('osm', { syncShare: false });
      styleManager._initMapStackControl();
    });
    const keylessState = await page.evaluate(() => {
      const controller = window.__godsEyeView.styleManager.mapStackController;
      return {
        activeId: controller.getActiveId(),
        hasGoogleTileset: Boolean(controller.googleTileset),
        hasCesiumIonToken: Boolean(controller.cesiumToken),
      };
    });
    check(
      'forced-keyless seam removes direct Google and ion sources before restore checks',
      keylessState.activeId === 'osm'
        && keylessState.hasGoogleTileset === false
        && keylessState.hasCesiumIonToken === false,
      JSON.stringify(keylessState),
    );
  }
  const activeBeforeIonAttempt = await page.evaluate(() => (
    window.__godsEyeView.styleManager.mapStackController.getActiveId()
  ));
  // The long-Space test above deliberately blurs its style button. On a slower
  // keyless rebuild that can give the tray's pending auto-close enough time to
  // hide its chips before page.focus() runs. Focus the disclosure first to
  // clear that close timer, then ensure the tray is visibly open so this check
  // exercises the unavailable tile rather than a hidden element.
  await page.focus('#control-panel-toggle');
  await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed(
    'control-panel', false, { persist: false, syncShare: false },
  ));
  await waitTray('true', null);
  await page.focus('[data-stack-id="bing-aerial"]');
  const ionAvailable = await page.$eval(
    '[data-stack-id="bing-aerial"]',
    (chip) => chip.getAttribute('aria-disabled') !== 'true',
  );
  const ionFocusedBeforeActivation = await page.$eval(
    '[data-stack-id="bing-aerial"]',
    (chip) => document.activeElement === chip,
  );
  // Exercise the keyboard path. Unavailable tiles intentionally reject pointer
  // hit testing while remaining focusable so their missing-key explanation is
  // available to keyboard and assistive-technology users.
  await page.keyboard.press('Space');
  if (ionAvailable) {
    // Cesium creates the imagery provider asynchronously. Wait for controller
    // truth instead of assuming a keyed switch can settle in one animation.
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.mapStackController.getActiveId() === 'bing-aerial'
        || Boolean(window.__godsEyeView.styleManager.mapStackController.getState()?.lastError),
      { timeout: 20_000 },
    ).catch(() => {});
  } else {
    // A disabled chip must remain inert after the event loop has settled, not
    // just at the synchronous DOM sample immediately following the click.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  }
  const ionSource = await page.evaluate(() => {
    const chip = document.querySelector('[data-stack-id="bing-aerial"]');
    return {
      focused: document.activeElement === chip,
      ariaDisabled: chip.getAttribute('aria-disabled'),
      ariaLabel: chip.getAttribute('aria-label'),
      activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((candidate) => candidate.getAttribute('aria-pressed') === 'true')
        .map((candidate) => candidate.dataset.stackId),
    };
  });
  ionSource.focusedBeforeActivation = ionFocusedBeforeActivation;
  if (forceKeyless || ionSource.ariaDisabled === 'true') {
    check(
      'key-required sources stay focusable, explained, and inert when no ion token is configured',
      ionSource.ariaDisabled === 'true'
        && ionSource.focusedBeforeActivation
        // #143 names the missing key: "Needs CESIUM_ION_TOKEN — add it in Provider Settings".
        && /needs [A-Z_]+.*provider settings/i.test(ionSource.ariaLabel)
        && ionSource.activeId === activeBeforeIonAttempt
        && JSON.stringify(ionSource.active) === JSON.stringify([activeBeforeIonAttempt]),
      JSON.stringify(ionSource),
    );
  } else {
    check(
      'key-required sources switch normally when the ion token is configured',
      ionSource.focused
        && ionSource.ariaDisabled === 'false'
        && ionSource.activeId === 'bing-aerial'
        && JSON.stringify(ionSource.active) === JSON.stringify(['bing-aerial']),
      JSON.stringify(ionSource),
    );
  }
  const switching = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const controller = styleManager.mapStackController;
    const originalSetStack = controller.setStack.bind(controller);
    const before = controller.getActiveId();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controller.setStack = async (stackId) => {
      await gate;
      return originalSetStack(stackId);
    };
    const switchPromise = styleManager._setMapStack('osm', { syncShare: false });
    const during = {
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    release();
    await switchPromise;
    const after = {
      status: document.getElementById('map-stack-status').textContent,
      active: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    };
    controller.setStack = originalSetStack;
    await styleManager._setMapStack(before, { syncShare: false });
    return { before, during, after };
  });
  check(
    'switching feedback is truthful and active state moves only after commit',
    switching.during.status === '...'
      && JSON.stringify(switching.during.active) === JSON.stringify([switching.before])
      && JSON.stringify(switching.after.active) === JSON.stringify(['osm']),
    JSON.stringify(switching),
  );

  const acquiringLifecycle = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const status = document.getElementById('global-loading-status');
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const pending = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'followed',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    const followed = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'pending',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'source-unavailable',
      layerId: 'flights',
      targetId: 'qa-flight',
      label: 'flight',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const staleTerminal = snapshot();
    styleManager._handleShareTrackingRestoreStatus({
      classification: 'cancelled',
      layerId: 'military',
      targetId: 'qa-military',
      label: 'military flight',
    });
    const cancelled = snapshot();
    return { pending, followed, staleTerminal, cancelled };
  });
  check(
    'ACQUIRING DOM notice persists, ignores stale terminals, and clears on ownership completion',
    acquiringLifecycle.pending.hidden === false
      && acquiringLifecycle.pending.state === 'acquiring'
      && acquiringLifecycle.pending.label === 'ACQUIRING'
      && acquiringLifecycle.pending.detail === 'SHARED FLIGHT'
      && acquiringLifecycle.followed.hidden === true
      && acquiringLifecycle.staleTerminal.hidden === false
      && acquiringLifecycle.staleTerminal.state === 'acquiring'
      && acquiringLifecycle.staleTerminal.detail === 'SHARED MILITARY FLIGHT'
      && acquiringLifecycle.cancelled.hidden === true,
    JSON.stringify(acquiringLifecycle),
  );

  const acquiringFailureArbitration = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = styleManager._dataManager;
    const status = document.getElementById('global-loading-status');
    const originalGetAll = dataManager.getAll;
    const snapshot = () => ({
      hidden: status.hidden,
      state: status.dataset.state || null,
      label: document.getElementById('global-loading-label').textContent.trim(),
      detail: document.getElementById('global-loading-detail').textContent.trim(),
    });
    const waitForQueuedNotice = async (label, timeoutMs = 1000) => {
      const deadline = performance.now() + timeoutMs;
      while (styleManager._globalStatusNotice?.label !== label
          && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return styleManager._globalStatusNotice?.label === label;
    };
    const baseNow = performance.now();
    try {
      styleManager._loadingFeedbackState = {
        phase: 'idle', visible: false, startedAt: 0, showAt: 0, hideAt: 0,
        activeIds: [], batchOutcome: null, terminal: null, operation: null,
      };
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'pending',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      dataManager.getAll = () => [{
        id: 'qa-unrelated-layer',
        name: 'QA unrelated layer',
        lifecycleState: 'enabling',
        enabled: false,
        stats: {},
      }];
      styleManager._updateGlobalLoadingFeedback(baseNow);
      styleManager._updateGlobalLoadingFeedback(baseNow + 200);
      dataManager.getAll = () => [];
      styleManager._loadingFeedbackEvent = {
        type: 'visibility-failed',
        layerId: 'qa-unrelated-layer',
        error: new Error('QA offline'),
      };
      styleManager._updateGlobalLoadingFeedback(baseNow + 300);
      const failureStart = snapshot();
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'source-unavailable',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
      const queuedNoticeReady = await waitForQueuedNotice(
        'Shared flight could not be restored — feed unavailable',
      );
      const shareFailureQueued = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5299);
      const failureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 5300);
      const shareFailureStart = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10299);
      const shareFailureEnd = snapshot();
      styleManager._updateGlobalLoadingFeedback(baseNow + 10300);
      const settled = snapshot();
      return {
        failureStart,
        queuedNoticeReady,
        shareFailureQueued,
        failureEnd,
        shareFailureStart,
        shareFailureEnd,
        settled,
      };
    } finally {
      dataManager.getAll = originalGetAll;
      styleManager._handleShareTrackingRestoreStatus({
        classification: 'cancelled',
        layerId: 'flights',
        targetId: 'qa-failure-flight',
        label: 'flight',
      });
    }
  });
  check(
    'manager failure then queued share failure each receives its full visible dwell',
    acquiringFailureArbitration.failureStart.hidden === false
      && acquiringFailureArbitration.failureStart.state === 'error'
      && acquiringFailureArbitration.failureStart.label === 'LOAD FAILED'
      && acquiringFailureArbitration.queuedNoticeReady === true
      && acquiringFailureArbitration.shareFailureQueued.state === 'error'
      && acquiringFailureArbitration.shareFailureQueued.label === 'LOAD FAILED'
      && acquiringFailureArbitration.failureEnd.state === 'error'
      && acquiringFailureArbitration.failureEnd.label === 'LOAD FAILED'
      && acquiringFailureArbitration.shareFailureStart.state === 'error'
      && acquiringFailureArbitration.shareFailureStart.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.shareFailureEnd.label === 'Shared flight could not be restored — feed unavailable'
      && acquiringFailureArbitration.settled.hidden === true,
    JSON.stringify(acquiringFailureArbitration),
  );

  // Unpinned mouse-away dismissal AFTER a tile click. Chromium focuses a
  // <button> on mouse press, so a close-guard reading plain
  // `document.activeElement` left the tray permanently open once Map Source
  // moved into it — switch a basemap and the popover never went away again
  // (owner field report). The pin samples the exact mechanism: focus IS parked
  // inside the panel and is NOT `:focus-visible`, and the tray closes anyway.
  const setControlPanelPinned = (wanted) => page.evaluate((want) => {
    const panel = document.getElementById('control-panel');
    if (panel.classList.contains('dock-pinned') !== want) {
      document.querySelector('.dock-pin-btn[data-pin-target="control-panel"]').click();
    }
    return panel.classList.contains('dock-pinned');
  }, wanted);
  const readTrayState = () => page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    const active = document.activeElement;
    let focusVisible = null;
    try { focusVisible = active?.matches?.(':focus-visible') ?? null; } catch { focusVisible = null; }
    return {
      collapsed: panel.classList.contains('collapsed'),
      expanded: document.getElementById('control-panel-toggle').getAttribute('aria-expanded'),
      focusInside: panel.contains(active),
      focusVisible,
    };
  });
  const clickTileThenLeave = async (stackId) => {
    await page.evaluate(() => window.__godsEyeView.styleManager
      .setPanelCollapsed('control-panel', false, { explicit: true }));
    await new Promise((resolve) => setTimeout(resolve, 240));
    await page.click(`[data-stack-id="${stackId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterClick = await readTrayState();
    await page.mouse.move(20, 20); // leave the dock entirely → pointerleave
    // Past the 420 ms unpinned close delay with room for a slow frame.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { afterClick, afterLeave: await readTrayState() };
  };

  // The OTHER half of the same rule, asserted positively: a KEYBOARD user who
  // tabbed to a tile and pressed Enter must keep the tray, because closing it
  // out from under them would strand the caret in a hidden surface. Same
  // mouse-away that dismisses after a click, opposite outcome — so a fix that
  // simply deleted the focus guard would fail here.
  await setControlPanelPinned(false);
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', true, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter'); // opens and hands focus to the active tile
  const selectedForHold = await page.evaluate(() => window.__godsEyeView.styleManager.mapStackController.getActiveId());
  await waitTray('true', selectedForHold);
  // Keyless starts on OSM, the last tile. Tab forward there correctly leaves
  // the tray, so navigate to a neighbouring tile in the available direction.
  const activeIsLastTile = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#map-stack-chips .map-stack-chip')];
    return document.activeElement === chips.at(-1);
  });
  if (activeIsLastTile) await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  if (activeIsLastTile) await page.keyboard.up('Shift');
  await page.keyboard.press('Enter'); // activate it from the keyboard
  await new Promise((resolve) => setTimeout(resolve, 200));
  const keyboardAfterActivate = await page.evaluate(() => ({
    focusedStack: document.activeElement?.dataset?.stackId || null,
    isChip: !!document.activeElement?.classList?.contains('map-stack-chip'),
  }));
  // Enter the tray with the pointer and leave again, so a real pointerleave
  // schedules the close this pin expects to be declined.
  const chipPoint = await page.$eval('#map-stack-chips .map-stack-chip', (chip) => {
    const rect = chip.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(chipPoint.x, chipPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await page.mouse.move(20, 20);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const keyboardHold = await readTrayState();
  check(
    'keyboard activation of a tile HOLDS the tray open through the same mouse-away',
    keyboardAfterActivate.isChip === true
      && keyboardHold.collapsed === false
      && keyboardHold.expanded === 'true'
      && keyboardHold.focusInside === true
      && keyboardHold.focusVisible === true,
    JSON.stringify({ keyboardAfterActivate, keyboardHold }),
  );

  await setControlPanelPinned(false);
  const dismissAfterTileClick = await clickTileThenLeave('osm');
  const pinnedForHold = await setControlPanelPinned(true);
  const pinnedHold = await clickTileThenLeave('photoreal');
  await setControlPanelPinned(false);
  await page.evaluate(() => window.__godsEyeView.styleManager
    ._setMapStack('photoreal', { syncShare: false }));
  // Approach the disclosure before opening: the previous mouse-away case
  // intentionally leaves a pending close, so an unattended programmatic reopen
  // can disappear while the next real pointer click is being dispatched.
  const pinApproach = await page.$eval('#control-panel-toggle', (toggle) => {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(pinApproach.x, pinApproach.y);
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', false, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 240));
  check(
    'a tile click does not exempt the unpinned tray from mouse-away auto-dismiss',
    dismissAfterTileClick.afterClick.collapsed === false
      && dismissAfterTileClick.afterClick.focusInside === true
      && dismissAfterTileClick.afterClick.focusVisible === false
      && dismissAfterTileClick.afterLeave.collapsed === true
      && dismissAfterTileClick.afterLeave.expanded === 'false'
      && pinnedForHold === true
      && pinnedHold.afterLeave.collapsed === false,
    JSON.stringify({ dismissAfterTileClick, pinnedForHold, pinnedHold }),
  );

  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  const desktop = await trayMetrics();
  check(
    'desktop tray is one row and fully inside the viewport',
    desktop.rows === 1
      && desktop.popover.left >= 0
      && desktop.popover.right <= desktop.viewport.width,
    JSON.stringify(desktop),
  );

  await checkResponsiveStyleFocus(1000);

  await page.setViewport({ width: 620, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at620 = await trayMetrics();
  check(
    '620 px tray uses two rows without clipping',
    at620.expanded === 'true'
      && at620.pinned
      && at620.rows === 2
      && at620.popover.left >= 0
      && at620.popover.right <= at620.viewport.width,
    JSON.stringify(at620),
  );

  await checkResponsiveStyleFocus(620);

  await page.setViewport({ width: 480, height: 900, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const at480 = await trayMetrics();
  const allRectsInside = at480.chips.every((chip) => (
    chip.left >= 0 && chip.right <= at480.viewport.width
      && chip.top >= 0 && chip.bottom <= at480.viewport.height
  ));
  check(
    '480 px live resize keeps the open tray and every tile in bounds',
    at480.expanded === 'true'
      && at480.pinned
      && at480.rows === 2
      && at480.popover.left >= 0
      && at480.popover.right <= at480.viewport.width
      && allRectsInside,
    JSON.stringify(at480),
  );
  await page.screenshot({ path: path.join(shotsDir, '480-open.png') });
  await checkResponsiveStyleFocus(480);

  await page.click('.dock-pin-btn[data-pin-target="control-panel"]');
  await page.click('#control-panel-toggle');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const toggleRect = await page.$eval('#control-panel-toggle', (toggle) => {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.touchscreen.tap(toggleRect.x, toggleRect.y);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const touchOpen = await page.$eval('#control-panel-toggle', (toggle) => toggle.getAttribute('aria-expanded'));
  check('coarse-pointer tap opens the compact wing', touchOpen === 'true', `aria-expanded=${touchOpen}`);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // Retired and unknown stack ids take the SAME path. `bing-road` was the fifth
  // source behind the retired left Map Stack panel; deleting it from
  // `MAP_STACKS` (no build carrying it ever shipped publicly, so no link is
  // owed anything) means an old `map=bing-road` link is now simply an
  // unrecognized id, and `setStack()`'s `getStack(id) || getStack('photoreal')`
  // fallback requests Google 3D. A keyed run lands there; a keyless run keeps
  // its truthful OSM recovery. Either way, the active tile must reflect the
  // rendered source — never a hidden fifth source with a ROAD status.
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  const photorealAvailable = await page.$eval(
    '[data-stack-id="photoreal"]',
    (chip) => chip.getAttribute('aria-disabled') !== 'true',
  );
  const expectedLegacyActive = photorealAvailable ? 'photoreal' : 'osm';
  for (const legacyId of ['bing-road', 'garbage']) {
    if (forceKeyless) {
      // Keep the forced-keyless seam alive. A full reload would rebuild the
      // controller from the keyed server before this in-page override exists,
      // so drive the same parse/apply startup contract on the current keyless
      // controller instead.
      await page.evaluate(async (id) => {
        const styleManager = window.__godsEyeView.styleManager;
        history.replaceState(null, '', `?welcome=0#v=2&lat=30.27&lon=-97.74&map=${id}`);
        const state = styleManager.shareLinkManager.parseInitialHash();
        await styleManager.shareLinkManager.applyState(state, { applyCamera: false });
        styleManager.shareLinkManager.completeInitialRestore();
      }, legacyId);
    } else {
      await page.goto(`${appUrl}/?welcome=0#v=2&lat=30.27&lon=-97.74&map=${legacyId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 60_000 });
      await page.waitForFunction(
        () => document.getElementById('loading-screen')?.classList.contains('hidden'),
        { timeout: 60_000 },
      );
    }
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.mapStackController.getState()?.status !== 'switching',
      { timeout: 20_000 },
    ).catch(() => {});
    const restored = await page.evaluate(() => ({
      activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
      lastError: window.__godsEyeView.styleManager.mapStackController.getState()?.lastError || null,
      status: document.getElementById('map-stack-status').textContent.trim(),
      pressed: [...document.querySelectorAll('.map-stack-chip')]
        .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
        .map((chip) => chip.dataset.stackId),
    }));
    check(
      `a map=${legacyId} link restores to the best available fallback with its tile lit`,
      restored.activeId === expectedLegacyActive
        // Keyless photoreal now explains itself as "Needs GOOGLE_MAPS_API_KEY — add it in
        // Provider Settings — or a Cesium ion token …"; a keyed-but-failing route still says "unavailable".
        && (photorealAvailable ? restored.lastError === null : /needs [A-Z_]+|unavailable/i.test(restored.lastError || ''))
        && JSON.stringify(restored.pressed) === JSON.stringify([expectedLegacyActive]),
      JSON.stringify(restored),
    );
    await page.screenshot({ path: path.join(shotsDir, `legacy-${legacyId}.png`) });
  }

  // Location is a native disclosure: Enter is immediate, while Space waits for
  // key release. A repeated keydown must not toggle or claim voice early.
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  await page.mouse.move(20, 20);
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    for (const id of ['control-panel', 'location-bar']) {
      manager._setCommandDockPanelPinState(id, false, { persist: false, syncShare: false });
      manager.setPanelCollapsed(id, true, { persist: false, syncShare: false });
    }
    const original = manager.setPanelCollapsed;
    const probe = { transitions: [], restore: () => { manager.setPanelCollapsed = original; } };
    manager.setPanelCollapsed = function (id, ...args) {
      const before = document.getElementById(id)?.classList.contains('collapsed');
      const result = original.call(this, id, ...args);
      const after = document.getElementById(id)?.classList.contains('collapsed');
      if (id === 'location-bar' && before !== after) probe.transitions.push({ before, after });
      return result;
    };
    window.__qaLocationFocus = probe;
  });
  try {
    await page.focus('#gev-voice-button');
    const locationTab = await tabTo('#location-bar-toggle', { backwards: true, limit: 8 });
    const locationClosed = await locationState();
    check('Location: native disclosure semantics and closed Tab focus without opening',
      locationTab.reached && hasVisibleControlFocus(locationClosed)
        && locationClosed.tag === 'BUTTON' && locationClosed.type === 'button'
        && locationClosed.controls === 'location-bar-popover' && locationClosed.popoverId === 'location-bar-popover'
        && locationClosed.locationExpanded === 'false' && /^Expand Location$/i.test(locationClosed.locationLabel)
        && locationClosed.transitions.length === 0, JSON.stringify({ locationTab, locationClosed }));

    await resetLocationTransitions();
    await page.keyboard.press('Enter');
    const locationEnter = await locationState();
    check('Location: Enter opens once with visible focus and accurate name',
      hasVisibleControlFocus(locationEnter) && locationEnter.locationExpanded === 'true'
        && /^Collapse Location$/i.test(locationEnter.locationLabel) && locationEnter.transitions.length === 1,
      JSON.stringify(locationEnter));
    await page.keyboard.press('Escape');
    const locationEscape = await locationState();
    check('Location: Escape on the disclosure closes without retaining focus',
      locationEscape.focusedId === null && locationEscape.locationExpanded === 'false'
        && /^Expand Location$/i.test(locationEscape.locationLabel), JSON.stringify(locationEscape));

    await page.focus('#location-bar-toggle');
    await resetLocationTransitions();
    const voiceBeforeLocationSpace = locationEscape.voice;
    let locationSpaceHeld = false;
    let locationSpaceDown;
    let locationSpaceRepeat;
    try {
      await page.keyboard.down('Space');
      locationSpaceHeld = true;
      locationSpaceDown = await locationState();
      await new Promise((resolve) => setTimeout(resolve, 320));
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      locationSpaceRepeat = await locationState();
      await page.keyboard.up('Space');
      locationSpaceHeld = false;
    } finally {
      if (locationSpaceHeld) await page.keyboard.up('Space');
    }
    const locationSpaceUp = await locationState();
    check('Location: short repeated Space toggles once on release without starting voice',
      [locationSpaceDown, locationSpaceRepeat].every((state) => (
        state.focusedId === 'location-bar-toggle' && state.locationExpanded === 'false'
          && state.transitions.length === 0 && state.voice.status === voiceBeforeLocationSpace.status
          && state.voice.epoch === voiceBeforeLocationSpace.epoch
          && state.voice.held === true && state.voice.pushToTalk === false
      ))
        && locationSpaceUp.focusedId === 'location-bar-toggle'
        && locationSpaceUp.locationExpanded === 'true' && locationSpaceUp.transitions.length === 1
        && JSON.stringify(locationSpaceUp.voice) === JSON.stringify(voiceBeforeLocationSpace),
      JSON.stringify({ down: locationSpaceDown, repeat: locationSpaceRepeat, up: locationSpaceUp }));

    const searchTab = await tabTo('#search-toggle', { limit: 30 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('focus cleanup'); // no submission or navigation
    const typedSearch = await page.$eval('#location-search', (input) => ({
      focused: document.activeElement === input, expanded: input.classList.contains('expanded'), value: input.value,
    }));
    await page.keyboard.press('Escape');
    const searchEscape = await locationState();
    check('Location: Escape clears typed search and restores disclosure focus',
      searchTab.reached && typedSearch.focused && typedSearch.expanded && typedSearch.value === 'focus cleanup'
        && searchEscape.focusedId === 'location-bar-toggle' && searchEscape.locationExpanded === 'false'
        && !searchEscape.searchExpanded && searchEscape.searchValue === '', JSON.stringify({ typedSearch, searchEscape }));

    await page.focus('#control-panel-toggle');
    await page.keyboard.press('Enter'); // begin the Map Source handoff
    const siblingTab = await tabTo('#location-bar-toggle', { backwards: true, limit: 30 });
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const siblingState = await locationState();
    check('Location: sibling opening cancels pending Map Source focus',
      siblingTab.reached && siblingState.focusedId === 'location-bar-toggle'
        && siblingState.locationExpanded === 'true'
        && await page.$eval('#control-panel-toggle', (toggle) => toggle.getAttribute('aria-expanded') === 'false'),
      JSON.stringify(siblingState));
    await tabTo('.dock-pin-btn[data-pin-target="location-bar"]', { limit: 3 });
    await page.keyboard.press('Enter');
    await page.focus('#control-panel-toggle');
    await page.keyboard.press('Enter');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pinnedSibling = await locationState();
    check('Location: pinned tray survives sibling opening',
      pinnedSibling.pinned && pinnedSibling.locationExpanded === 'true'
        && await page.$eval('#control-panel-toggle', (toggle) => toggle.getAttribute('aria-expanded') === 'true'),
      JSON.stringify(pinnedSibling));
    await page.focus('#location-bar-toggle');
    await tabTo('.dock-pin-btn[data-pin-target="location-bar"]', { limit: 3 });
    await page.keyboard.press('Enter');
    check('Location: pin can be removed by keyboard', !(await locationState()).pinned);

    for (const width of [1000, 620, 480]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        const manager = window.__godsEyeView.styleManager;
        manager.setPanelCollapsed('control-panel', true, { persist: false, syncShare: false });
        manager.setPanelCollapsed('location-bar', true, { persist: false, syncShare: false });
      });
      await page.focus('#gev-voice-button');
      const closedTab = await tabTo('#location-bar-toggle', { backwards: true, limit: 8 });
      const closed = await locationState();
      check(`Location: ${width} px closed Tab ring is visible without opening`,
        closedTab.reached && hasVisibleControlFocus(closed) && closed.locationExpanded === 'false', JSON.stringify(closed));
      await page.screenshot({ path: path.join(shotsDir, `${width}-location-closed-focus.png`) });
      await page.keyboard.press('Enter');
      await pressTabs(1); // disclosure -> pin
      const openTab = await tabTo('#location-bar-toggle', { backwards: true, limit: 3 });
      const open = await locationState();
      check(`Location: ${width} px open ShiftTab ring is visible`,
        openTab.reached && hasVisibleControlFocus(open) && open.locationExpanded === 'true', JSON.stringify(open));
      await page.screenshot({ path: path.join(shotsDir, `${width}-location-open-focus.png`) });
      await page.keyboard.press('Escape');
    }
  } finally {
    await page.evaluate(() => {
      window.__qaLocationFocus?.restore();
      delete window.__qaLocationFocus;
      const manager = window.__godsEyeView.styleManager;
      for (const id of ['control-panel', 'location-bar']) {
        manager._setCommandDockPanelPinState(id, false, { persist: false, syncShare: false });
        manager.setPanelCollapsed(id, true, { persist: false, syncShare: false });
      }
    });
  }

  // The existing dev-only QA registration seam supplies stable ON/STALE rows
  // through the real manager/renderer. These fixtures fetch nothing, render no
  // entities and have no periodic update; production layers are never toggled.
  let dataSetup;
  try {
    dataSetup = await page.evaluate(async () => {
      const manager = window.__godsEyeView.dataManager;
      const production = () => manager.getAll().filter((layer) => !layer.id.startsWith('qa-keyboard-focus-'))
        .map((layer) => ({
          id: layer.id, enabled: layer.enabled, phase: layer.lifecycleState, uncertain: layer.lifecycleUncertain,
          visibilityIntentEpoch: manager.layers.get(layer.id).visibilityIntentEpoch,
          paramsIntentEpoch: manager.layers.get(layer.id).paramsIntentEpoch,
        }));
      // Inspect this known layer-state key only. Keep its value inside the page;
      // evidence receives equality booleans, never stored contents.
      const durableBefore = localStorage.getItem('gev:layer-state:v2');
      const state = { ids: [], before: production(), production, durableBefore, collapsed: document.getElementById('data-panel').classList.contains('collapsed') };
      window.__qaDataFocus = state;
      if (typeof window.__gevQaRegisterLayer !== 'function' || typeof window.__gevQaUnregisterLayer !== 'function') {
        return { ready: false, reason: 'Existing dev-only QA registration seam is unavailable' };
      }
      for (const [suffix, stale] of [['on', false], ['status', true]]) {
        const id = `qa-keyboard-focus-${suffix}`;
        window.__gevQaRegisterLayer(manager, {
          id, name: `QA focus ${stale ? 'STALE' : 'ON'}`, icon: '◌', source: 'Local focus fixture',
          init() {}, enable() {}, disable() {}, destroy() {}, update() {},
          getStats: () => ({ count: 1, lastUpdate: Date.now() - (stale ? 60_000 : 0), stale, source: 'Local focus fixture' }),
        });
        state.ids.push(id);
        await manager.setEnabled(id, true, { origin: 'programmatic' });
      }
      const transitionId = 'qa-keyboard-focus-transition';
      const transition = {
        id: transitionId,
        enableCalls: 0,
        disableCalls: 0,
        releaseEnable: null,
        releaseDisable: null,
      };
      state.transition = transition;
      window.__gevQaRegisterLayer(manager, {
        id: transitionId,
        name: 'QA focus transition',
        icon: '◌',
        source: 'Local focus fixture',
        init() {},
        enable() {
          transition.enableCalls += 1;
          return new Promise((resolve) => {
            transition.releaseEnable = () => {
              transition.releaseEnable = null;
              resolve();
            };
          });
        },
        disable() {
          transition.disableCalls += 1;
          return new Promise((resolve) => {
            transition.releaseDisable = () => {
              transition.releaseDisable = null;
              resolve();
            };
          });
        },
        destroy() {},
        update() {},
        getStats: () => ({ count: 1, lastUpdate: Date.now(), source: 'Local focus fixture' }),
      });
      state.ids.push(transitionId);
      manager._renderToggles();
      const offId = manager.getAll().find((layer) => !state.ids.includes(layer.id) && layer.showInTogglePanel && !layer.enabled)?.id;
      return {
        ready: Boolean(offId), offId, fixtureIds: state.ids.slice(0, 2), transitionId,
        productionUnchanged: JSON.stringify(state.before) === JSON.stringify(production()),
        durableUnchanged: durableBefore === localStorage.getItem('gev:layer-state:v2'),
      };
    });
    check('Data Layers: explicit dev fixtures provide status coverage without changing production layers',
      dataSetup.ready && dataSetup.productionUnchanged && dataSetup.durableUnchanged, JSON.stringify(dataSetup));
    if (dataSetup.ready) {
      for (const width of [1000, 620, 480]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false, { persist: false, syncShare: false }));
        await page.focus('#data-panel .panel-collapse-btn');
        const targets = [[dataSetup.offId, 'OFF', false], [dataSetup.fixtureIds[0], 'ON', true], [dataSetup.fixtureIds[1], 'STALE', true]];
        for (const [id, label, enabled] of targets) {
          const navigation = await tabTo(`[data-layer-id="${id}"] .data-toggle-btn`);
          const state = await layerFocusState(id);
          check(`Data Layers: ${width} px ${label} Tab focus ring is visible`,
            navigation.reached && state.layerId === id && hasVisibleControlFocus(state)
              && state.label === label && state.buttonActive === enabled && state.lifecycle?.enabled === enabled
              && state.lifecycle?.lifecycleState === (enabled ? 'enabled' : 'disabled') && !state.lifecycle?.uncertain,
            JSON.stringify({ setup: enabled ? 'dev QA fixture' : 'real production OFF row; not activated', navigation, state }));
          await page.screenshot({ path: path.join(shotsDir, `${width}-data-${label.toLowerCase()}-focus.png`) });
          if (label === 'OFF') {
            const passive = await page.evaluate((layerId) => {
              const probe = window.__qaDataFocus;
              const focusBefore = document.activeElement;
              const productionBefore = JSON.stringify(probe.production());
              const durableBefore = localStorage.getItem('gev:layer-state:v2');
              window.__godsEyeView.dataManager._refreshTogglePanel();
              return {
                focusRetained: document.activeElement === focusBefore
                  && focusBefore.matches('.data-toggle-btn')
                  && focusBefore.closest('[data-layer-id]')?.dataset.layerId === layerId,
                productionUnchanged: productionBefore === JSON.stringify(probe.production())
                  && productionBefore === JSON.stringify(probe.before),
                durableUnchanged: durableBefore === localStorage.getItem('gev:layer-state:v2')
                  && durableBefore === probe.durableBefore,
              };
            }, id);
            const refreshed = await layerFocusState(id);
            check(`Data Layers: ${width} px passive refresh preserves OFF focus and state`,
              passive.focusRetained && passive.productionUnchanged && passive.durableUnchanged
                && hasVisibleControlFocus(refreshed) && refreshed.label === 'OFF' && !refreshed.lifecycle?.enabled,
              JSON.stringify({ passive, refreshed }));
          }
          if (label === 'STALE') check(`Data Layers: ${width} px native Tab scrolls to the lower status row`,
            state.listScrollHeight > state.listClientHeight && state.listScrollTop > 0 && hasVisibleControlFocus(state), JSON.stringify(state));
        }
      }
      check('Data Layers: focus traversal leaves production visibility unchanged', await page.evaluate(() => (
        JSON.stringify(window.__qaDataFocus.before) === JSON.stringify(window.__qaDataFocus.production())
          && window.__qaDataFocus.durableBefore === localStorage.getItem('gev:layer-state:v2')
      )));

      await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
      await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false, { persist: false, syncShare: false }));
      await page.focus('#data-panel .panel-collapse-btn');
      const transitionTab = await tabTo(`[data-layer-id="${dataSetup.transitionId}"] .data-toggle-btn`);
      const transitionBefore = await layerFocusState(dataSetup.transitionId);
      check('Data Layers: transition fixture receives native Tab focus',
        transitionTab.reached && transitionBefore.label === 'OFF' && hasVisibleControlFocus(transitionBefore),
        JSON.stringify({ transitionTab, transitionBefore }));

      await page.keyboard.press('Space');
      await page.waitForFunction((layerId) => {
        const state = window.__qaDataFocus?.transition;
        const button = document.querySelector(`[data-layer-id="${layerId}"] .data-toggle-btn`);
        return state?.enableCalls === 1 && typeof state.releaseEnable === 'function'
          && button?.textContent.trim() === 'ENABLING';
      }, { timeout: 5_000 }, dataSetup.transitionId);
      const enabling = await layerFocusState(dataSetup.transitionId);
      check('Data Layers: focused Space keeps a visible ring through ENABLING',
        hasVisibleControlFocus(enabling) && enabling.label === 'ENABLING' && !enabling.disabled
          && enabling.ariaDisabled === 'true' && enabling.ariaBusy === 'true', JSON.stringify(enabling));
      const enablingEpoch = await page.evaluate((layerId) => (
        window.__godsEyeView.dataManager.layers.get(layerId).visibilityIntentEpoch
      ), dataSetup.transitionId);
      await page.keyboard.press('Space');
      const enablingRepeat = await page.evaluate((layerId) => ({
        calls: window.__qaDataFocus.transition.enableCalls,
        epoch: window.__godsEyeView.dataManager.layers.get(layerId).visibilityIntentEpoch,
      }), dataSetup.transitionId);
      check('Data Layers: repeated Space is inert while ENABLING',
        enablingRepeat.calls === 1 && enablingRepeat.epoch === enablingEpoch, JSON.stringify(enablingRepeat));
      await page.evaluate(() => window.__qaDataFocus.transition.releaseEnable());
      await page.waitForFunction((layerId) => {
        const state = window.__godsEyeView.dataManager.getLayerLifecycleState(layerId);
        return state.enabled && state.lifecycleState === 'enabled';
      }, { timeout: 5_000 }, dataSetup.transitionId);
      const enabled = await layerFocusState(dataSetup.transitionId);
      check('Data Layers: settled ON keeps the same visible keyboard focus',
        hasVisibleControlFocus(enabled) && !enabled.disabled && enabled.ariaDisabled === 'false'
          && enabled.ariaBusy === 'false' && enabled.lifecycle?.enabled, JSON.stringify(enabled));

      await page.keyboard.press('Space');
      await page.waitForFunction((layerId) => {
        const state = window.__qaDataFocus?.transition;
        const button = document.querySelector(`[data-layer-id="${layerId}"] .data-toggle-btn`);
        return state?.disableCalls === 1 && typeof state.releaseDisable === 'function'
          && button?.textContent.trim() === 'DISABLING';
      }, { timeout: 5_000 }, dataSetup.transitionId);
      const disabling = await layerFocusState(dataSetup.transitionId);
      check('Data Layers: focused Space keeps a visible ring through DISABLING',
        hasVisibleControlFocus(disabling) && disabling.label === 'DISABLING' && !disabling.disabled
          && disabling.ariaDisabled === 'true' && disabling.ariaBusy === 'true', JSON.stringify(disabling));
      const disablingEpoch = await page.evaluate((layerId) => (
        window.__godsEyeView.dataManager.layers.get(layerId).visibilityIntentEpoch
      ), dataSetup.transitionId);
      await page.keyboard.press('Space');
      const disablingRepeat = await page.evaluate((layerId) => ({
        calls: window.__qaDataFocus.transition.disableCalls,
        epoch: window.__godsEyeView.dataManager.layers.get(layerId).visibilityIntentEpoch,
      }), dataSetup.transitionId);
      check('Data Layers: repeated Space is inert while DISABLING',
        disablingRepeat.calls === 1 && disablingRepeat.epoch === disablingEpoch, JSON.stringify(disablingRepeat));
      await page.evaluate(() => window.__qaDataFocus.transition.releaseDisable());
      await page.waitForFunction((layerId) => {
        const state = window.__godsEyeView.dataManager.getLayerLifecycleState(layerId);
        return !state.enabled && state.lifecycleState === 'disabled';
      }, { timeout: 5_000 }, dataSetup.transitionId);
      const disabled = await layerFocusState(dataSetup.transitionId);
      check('Data Layers: settled OFF keeps the same visible keyboard focus',
        hasVisibleControlFocus(disabled) && !disabled.disabled && disabled.ariaDisabled === 'false'
          && disabled.ariaBusy === 'false' && !disabled.lifecycle?.enabled, JSON.stringify(disabled));
    }
  } finally {
    const cleaned = await page.evaluate(async () => {
      const state = window.__qaDataFocus;
      if (!state) return { complete: false, reason: 'No fixture setup state' };
      const manager = window.__godsEyeView.dataManager;
      state.transition?.releaseEnable?.();
      state.transition?.releaseDisable?.();
      const removed = [];
      for (const id of state.ids) removed.push(await window.__gevQaUnregisterLayer(manager, id));
      manager._renderToggles();
      window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', state.collapsed, { persist: false, syncShare: false });
      // A native user-origin toggle legitimately asks the production state
      // coordinator to persist. Restore the exact pre-fixture value so this
      // hermetic QA journey leaves the user's durable layer snapshot untouched.
      if (state.durableBefore === null) localStorage.removeItem('gev:layer-state:v2');
      else localStorage.setItem('gev:layer-state:v2', state.durableBefore);
      const result = {
        complete: removed.every(Boolean) && state.ids.every((id) => !manager.layers.has(id)),
        productionUnchanged: JSON.stringify(state.before) === JSON.stringify(state.production()),
        durableUnchanged: state.durableBefore === localStorage.getItem('gev:layer-state:v2'),
      };
      delete window.__qaDataFocus;
      return result;
    });
    check('Data Layers: fixture teardown restores the original production registry and visibility',
      cleaned.complete && cleaned.productionUnchanged && cleaned.durableUnchanged, JSON.stringify(cleaned));
    await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  }

  check('no new page or console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nMap Source tray QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nMap Source tray QA passed.');
}
