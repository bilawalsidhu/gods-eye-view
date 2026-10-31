import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { StyleManager } from './applicationShell.js';
import { ContextControls } from './contextControls.js';
import {
  MOBILE_SHEET_PANELS,
  MOBILE_TABS,
  initMobileShell,
  nextSheet,
  sheetForPanelId,
} from './mobileShell.js';

function element(tag, document) {
  const node = new EventTarget();
  const attributes = new Map();
  const classes = new Set();
  Object.assign(node, {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    textContent: '',
    className: '',
    parent: null,
    scrollTop: 0,
    parentElement: null,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    style: {
      values: new Map(),
      setProperty(name, value) {
        this.values.set(name, value);
      },
      removeProperty(name) {
        this.values.delete(name);
      },
    },
    setAttribute: (key, value) => attributes.set(key, String(value)),
    getAttribute: (key) => attributes.get(key) ?? null,
    removeAttribute: (key) => attributes.delete(key),
    append(...children) {
      for (const child of children) {
        child.parent = node;
        child.parentElement = node;
        node.children.push(child);
        if (child.id) document.ids.set(child.id, child);
      }
    },
    remove() {
      const siblings = node.parent?.children;
      siblings?.splice(siblings.indexOf(node), 1);
      document.ids.delete(node.id);
    },
    contains(other) {
      for (let current = other; current; current = current.parent)
        if (current === node) return true;
      return false;
    },
    closest(selector) {
      for (let current = node; current; current = current.parent) {
        if (
          selector.startsWith('button, a') &&
          (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(
            current.tagName,
          ) ||
            ['slider', 'button'].includes(current.getAttribute('role')) ||
            (current.getAttribute('contenteditable') !== null &&
              current.getAttribute('contenteditable') !== 'false'))
        )
          return current;
        if (selector === '[data-mobile-sheet]' && current.dataset.mobileSheet)
          return current;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const matches = (child) =>
        selector === '[data-mobile-sheet]'
          ? Boolean(child.dataset.mobileSheet)
          : child.tagName === 'BUTTON';
      const walk = (parent) => {
        for (const child of parent.children) {
          if (matches(child)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
    getClientRects: () => (node.hidden ? [] : [{}]),
    matches: (selector) =>
      selector === '.panel-collapse-btn' &&
      node.className.split(' ').includes('panel-collapse-btn'),
    focus() {
      document.activeElement = node;
    },
    blur() {
      if (document.activeElement === node)
        document.activeElement = document.body;
    },
  });
  return node;
}

const PANEL_IDS = [...new Set(Object.values(MOBILE_SHEET_PANELS).flat())];

function fixture({
  mobile = true,
  expanded = [],
  onTabOpened = () => {},
} = {}) {
  const document = new EventTarget();
  document.ids = new Map();
  document.createElement = (tag) => element(tag, document);
  document.getElementById = (id) => document.ids.get(id) ?? null;
  const viewport = element('meta', document);
  viewport.setAttribute('content', 'width=device-width, initial-scale=1.0');
  document.querySelector = (selector) =>
    selector === 'meta[name="viewport"]'
      ? viewport
      : selector === 'dialog[open]' && document.openDialog
        ? {}
        : null;
  document.body = element('body', document);
  document.activeElement = document.body;
  const search = element('input', document);
  search.id = 'location-search';
  document.body.append(search);
  const rails = {};
  for (const id of ['left-panel-stack', 'right-context-rail', 'command-dock']) {
    rails[id] = element('div', document);
    rails[id].id = id;
    document.body.append(rails[id]);
  }
  for (const id of PANEL_IDS) {
    const panel = element('section', document);
    panel.id = id;
    if (!expanded.includes(id)) panel.classList.add('collapsed');
    // A hidden tray toggle and a collapse control first, like the panels'
    // own chrome in a sheet.
    const toggle = element('button', document);
    toggle.hidden = true;
    const collapse = element('button', document);
    collapse.className = 'panel-collapse-btn';
    panel.append(toggle, collapse, element('button', document));
    const root =
      id === 'data-panel'
        ? 'left-panel-stack'
        : ['location-bar', 'control-panel'].includes(id)
          ? 'command-dock'
          : 'right-context-rail';
    rails[root].append(panel);
  }

  const media = new EventTarget();
  media.matches = mobile;
  const calls = [];
  const frames = [];
  let closedCount = 0;
  let observed = null;
  class FakeMutationObserver {
    constructor(callback) {
      observed = callback;
    }
    observe() {}
    disconnect() {
      observed = null;
    }
  }
  const shell = initMobileShell({
    documentRef: document,
    onTabOpened,
    matchMedia: () => media,
    MutationObserverImpl: FakeMutationObserver,
    ResizeObserverImpl: null,
    requestFrame: (callback) => frames.push(callback),
    onSheetsClosed: () => {
      closedCount += 1;
    },
    setPanelCollapsed: (panelId, collapsed, options) => {
      calls.push({ panelId, collapsed, ...options });
      const panel = document.getElementById(panelId);
      if (collapsed) panel.classList.add('collapsed');
      else panel.classList.remove('collapsed');
    },
  });
  const tab = (sheet) =>
    document
      .getElementById('mobile-tab-bar')
      .children.find((button) => button.dataset.mobileSheet === sheet);
  const press = (sheet) => {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: tab(sheet) });
    document.getElementById('mobile-tab-bar').dispatchEvent(event);
  };
  const resize = (matches) => {
    media.matches = matches;
    const event = new Event('change');
    event.matches = matches;
    media.dispatchEvent(event);
  };
  const setBodyClass = (name) => {
    document.body.classList.add(name);
    observed?.();
  };
  const collapsed = (id) =>
    document.getElementById(id).classList.contains('collapsed');
  const runFrames = () => frames.splice(0).forEach((callback) => callback());
  return {
    document,
    shell,
    calls,
    runFrames,
    closedCount: () => closedCount,
    press,
    tab,
    resize,
    viewport,
    search,
    setBodyClass,
    collapsed,
  };
}

test('every tab names a sheet and every sheet panel maps back to its sheet', () => {
  assert.deepEqual(
    MOBILE_TABS.map(({ sheet }) => sheet),
    Object.keys(MOBILE_SHEET_PANELS),
  );
  for (const [sheet, panels] of Object.entries(MOBILE_SHEET_PANELS))
    for (const panelId of panels) assert.equal(sheetForPanelId(panelId), sheet);
  assert.equal(sheetForPanelId('unknown-panel'), null);
});

test('pressing a tab opens its sheet, pressing it again closes it', () => {
  assert.equal(nextSheet(null, 'layers'), 'layers');
  assert.equal(nextSheet('layers', 'layers'), null);
  assert.equal(nextSheet('layers', 'more'), 'more');
  assert.equal(nextSheet('layers', 'nonsense'), null);
  assert.equal(nextSheet(null, 'constructor'), null);
});

test('one sheet at a time, presented with aria-expanded and a backdrop', () => {
  const { document, shell, press, tab } = fixture();
  assert.equal(document.body.classList.contains('mobile-shell'), true);
  press('layers');
  assert.equal(shell.getSheet(), 'layers');
  assert.equal(document.body.getAttribute('data-mobile-sheet'), 'layers');
  assert.equal(tab('layers').getAttribute('aria-expanded'), 'true');
  assert.equal(document.getElementById('mobile-sheet-backdrop').hidden, false);
  press('more');
  assert.equal(shell.getSheet(), 'more');
  assert.equal(tab('layers').getAttribute('aria-expanded'), 'false');
  assert.equal(tab('more').getAttribute('aria-expanded'), 'true');
  press('more');
  assert.equal(shell.getSheet(), null);
  assert.equal(document.body.getAttribute('data-mobile-sheet'), null);
  assert.equal(document.getElementById('mobile-sheet-backdrop').hidden, true);
});

test('sheets borrow panels and put them back exactly as they were', () => {
  // The user left Data Layers and Presets open on desktop.
  const kept = ['data-panel', 'control-panel'];
  const { calls, press, collapsed } = fixture({ expanded: kept });
  press('cameras');
  assert.equal(collapsed('cctv-panel'), false);
  assert.equal(collapsed('street-level-panel'), false);
  press('search');
  assert.equal(collapsed('cctv-panel'), true, 'Cameras put back on switch');
  assert.equal(collapsed('location-bar'), false);
  press('search');
  for (const id of PANEL_IDS)
    assert.equal(collapsed(id), !kept.includes(id), `${id} is back as it was`);
  // Nothing a sheet does is the user's choice, persisted or shared.
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.explicit, undefined, `${call.panelId} is not explicit`);
    assert.equal(call.persist, false);
    assert.equal(call.syncShare, false);
  }
  // Already-open panels are not touched.
  assert.ok(!calls.some(({ panelId }) => kept.includes(panelId)));
});

test('a panel the user changes inside a sheet stays as they left it', () => {
  const { press, collapsed, document } = fixture();
  press('cameras');
  // The user collapses CCTV inside the sheet (their own, persisted choice).
  document.getElementById('cctv-panel').classList.add('collapsed');
  press('cameras');
  assert.equal(collapsed('cctv-panel'), true, 'their collapse is kept');
  assert.equal(
    collapsed('street-level-panel'),
    true,
    'the borrowed one is put back',
  );

  // Expanding one in a sheet is kept too, and later sheets respect it.
  press('layers');
  document.getElementById('cctv-panel').classList.remove('collapsed');
  press('more');
  press('more');
  assert.equal(collapsed('cctv-panel'), false);
});

test('focus moves into the sheet and returns to the tab on close', () => {
  const { document, press, search, tab } = fixture();
  press('search');
  assert.equal(document.activeElement, search);
  press('search');
  assert.equal(document.activeElement, tab('search'));

  press('layers');
  const dataPanel = document.getElementById('data-panel');
  // The first visible control that is not the panel's own collapse button.
  assert.equal(document.activeElement, dataPanel.children[2]);
  const escape = new Event('keydown', { cancelable: true });
  escape.key = 'Escape';
  document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(document.activeElement, tab('layers'));
});

test('the share link keeps the state from before the sheets', () => {
  const { shell, press, document, closedCount } = fixture({
    expanded: ['street-level-panel'],
  });
  assert.equal(shell.sharedCollapsed('data-panel'), undefined);
  press('layers');
  // Data Layers is open only because the sheet borrowed it.
  assert.equal(shell.sharedCollapsed('data-panel'), true);
  assert.equal(shell.sharedCollapsed('street-level-panel'), false);
  assert.equal(shell.sharedCollapsed('unrelated-panel'), undefined);
  // A user change inside the sheet is theirs to share.
  document.getElementById('cctv-panel').classList.remove('collapsed');
  assert.equal(shell.sharedCollapsed('cctv-panel'), false);
  press('more');
  assert.equal(closedCount(), 0, 'switching sheets is not closing');
  press('more');
  assert.equal(closedCount(), 1, 'closing refreshes the share link once');
  assert.equal(shell.sharedCollapsed('data-panel'), undefined);
});

test('Escape closes the sheet only when nothing else took it', () => {
  const { document, shell, press } = fixture();
  const escape = () => {
    const event = new Event('keydown', { cancelable: true, bubbles: true });
    event.key = 'Escape';
    return event;
  };
  press('layers');
  // A field cancelling its edit (or a lightbox closing) handles it first.
  const handled = escape();
  handled.preventDefault();
  document.dispatchEvent(handled);
  assert.equal(shell.getSheet(), 'layers');
  // An open dialog keeps Escape for its native close.
  document.openDialog = true;
  document.dispatchEvent(escape());
  assert.equal(shell.getSheet(), 'layers');
  document.openDialog = false;
  const plain = escape();
  document.dispatchEvent(plain);
  assert.equal(shell.getSheet(), null);
  assert.equal(plain.defaultPrevented, true);
});

test('share state and restores follow the preference, not layout collapse', () => {
  const { shell, press, collapsed, document } = fixture();
  // Layout collapsed Street Level only for space; the user left it open.
  const street = document.getElementById('street-level-panel');
  street.classList.add('layout-auto-collapsed');
  press('cameras');
  assert.equal(shell.sharedCollapsed('street-level-panel'), false);
  press('cameras');
  assert.equal(
    collapsed('street-level-panel'),
    false,
    'not turned into a real collapse',
  );
});

test('layout settling after a sheet opens is part of opening', () => {
  const { press, runFrames, collapsed, document } = fixture({
    expanded: ['street-level-panel'],
  });
  press('cameras');
  // A rail layout pass on the next frame collapses Street Level.
  document.getElementById('street-level-panel').classList.add('collapsed');
  runFrames();
  press('cameras');
  assert.equal(collapsed('street-level-panel'), false, 'put back as it was');
});

test('the backdrop closes the open sheet', () => {
  const { document, shell, press } = fixture();
  press('context');
  document
    .getElementById('mobile-sheet-backdrop')
    .dispatchEvent(new Event('click'));
  assert.equal(shell.getSheet(), null);
});

test('surfaces that own the screen close sheets; scene playback does not', () => {
  for (const mode of ['cockpit-mode', 'recording-mode', 'ui-clean-view']) {
    const { shell, press, setBodyClass, collapsed } = fixture();
    press('layers');
    setBodyClass(mode);
    assert.equal(shell.getSheet(), null, `${mode} closes the sheet`);
    assert.equal(collapsed('data-panel'), true, `${mode} puts panels back`);
    press('layers');
    assert.equal(shell.getSheet(), null, `${mode} keeps sheets closed`);
  }
  // Scene STOP lives in the Scenes panel of the Layers sheet.
  const playback = fixture();
  playback.setBodyClass('scene-playback-mode');
  playback.press('layers');
  assert.equal(playback.shell.getSheet(), 'layers');
});

test('desktop widths never see the shell; crossing to desktop restores it', () => {
  const desktop = fixture({ mobile: false });
  assert.equal(desktop.document.body.classList.contains('mobile-shell'), false);
  desktop.press('layers');
  assert.equal(desktop.shell.getSheet(), null);
  assert.equal(
    desktop.viewport.getAttribute('content'),
    'width=device-width, initial-scale=1.0',
  );

  const phone = fixture({ expanded: ['street-level-panel'] });
  assert.match(phone.viewport.getAttribute('content'), /viewport-fit=cover$/);
  phone.press('cameras');
  phone.resize(false);
  assert.equal(phone.shell.getSheet(), null);
  assert.equal(phone.document.body.classList.contains('mobile-shell'), false);
  assert.equal(phone.collapsed('cctv-panel'), true);
  assert.equal(phone.collapsed('street-level-panel'), false);
  assert.equal(
    phone.viewport.getAttribute('content'),
    'width=device-width, initial-scale=1.0',
  );
});

test('destroy puts panels back and removes the shell', () => {
  const { document, shell, press, viewport, collapsed } = fixture();
  press('layers');
  shell.destroy();
  assert.equal(collapsed('data-panel'), true);
  assert.equal(document.getElementById('mobile-tab-bar'), null);
  assert.equal(document.getElementById('mobile-sheet-backdrop'), null);
  assert.equal(document.body.classList.contains('mobile-shell'), false);
  assert.equal(document.body.getAttribute('data-mobile-sheet'), null);
  assert.equal(document.body.style.values.size, 0);
  assert.equal(
    viewport.getAttribute('content'),
    'width=device-width, initial-scale=1.0',
  );
});

test('the phone shell keeps the required attribution visible', () => {
  // Whitespace-normalised, so formatter line wrapping cannot hide a rule.
  const css = readFileSync(
    new URL('./styles/mobile-shell.css', import.meta.url),
    'utf8',
  )
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')');
  /** The declaration block of the rule whose selector list ends with `selector`. */
  const rule = (selector) => {
    const end = css.indexOf(`${selector} {`);
    assert.notEqual(end, -1, `missing rule ending in ${selector}`);
    const open = css.indexOf('{', end);
    return css.slice(open, css.indexOf('}', open));
  };
  const lift = (block) =>
    Number(
      /bottom: calc\(var\(--mobile-tab-space\) \+ (\d+)px\)/.exec(block)?.[1],
    );
  const z = (block) => Number(/z-index: (\d+);/.exec(block)?.[1]);
  const idleCredit = rule(
    'body.mobile-shell:not(.recording-mode):not(.cockpit-mode):not(.ui-clean-view) #cesium-credits',
  );
  const dock = rule('body.mobile-shell #command-dock');
  const voice = rule('body.mobile-shell #command-dock #gev-voice-control');
  const voiceHeightPx = Number(/height: ([\d.]+)rem/.exec(voice)[1]) * 16;
  // Idle: the credit line clears the voice bar, which clears the tab bar.
  assert.ok(lift(idleCredit) > lift(dock) + voiceHeightPx);
  // It must beat the dock's :has() placements, so the offset is !important.
  assert.match(idleCredit, /\) !important;/);
  assert.doesNotMatch(
    idleCredit,
    /display:\s*none|visibility:\s*hidden|opacity:\s*0/,
  );
  // Open sheet: above everything the sheet covers, drawn above the sheets.
  const sheetCredit = rule(
    'body.mobile-shell[data-mobile-sheet]:not(.recording-mode):not(.cockpit-mode):not(.ui-clean-view) #cesium-credits',
  );
  assert.match(
    sheetCredit,
    /bottom: calc\(var\(--mobile-sheet-cover, 0px\) \+ 6px\) !important;/,
  );
  const openDock = rule('body.mobile-shell[data-mobile-sheet] #command-dock');
  const railSheet = rule(
    "body.mobile-shell[data-mobile-sheet='more'] #right-context-rail",
  );
  assert.ok(z(sheetCredit) > z(openDock));
  assert.ok(z(sheetCredit) > z(railSheet));
});

function touchEvent(
  document,
  type,
  target,
  { x = 10, y = 10, count = 1, id = 1, cancelable = true } = {},
) {
  const event = new Event(type, { cancelable });
  const touch = { identifier: id, clientX: x, clientY: y };
  Object.defineProperty(event, 'target', { value: target });
  event.touches =
    type === 'touchend' || type === 'touchcancel'
      ? []
      : Array.from({ length: count }, (_, i) => ({
          ...touch,
          identifier: id + i,
        }));
  event.changedTouches = [touch];
  document.dispatchEvent(event);
  return event;
}

test('downward sheet pull closes through borrowed-panel lifecycle and returns tab focus', () => {
  for (const sheet of Object.keys(MOBILE_SHEET_PANELS)) {
    const phone = fixture();
    const { document, shell, press, tab } = phone;
    press(sheet);
    const target = document.getElementById(MOBILE_SHEET_PANELS[sheet][0]);
    touchEvent(document, 'touchstart', target);
    const move = touchEvent(document, 'touchmove', target, { y: 90 });
    assert.equal(move.defaultPrevented, true);
    assert.equal(shell.getSheet(), sheet, 'waits until finger lifts');
    touchEvent(document, 'touchend', target, { y: 90 });
    assert.equal(shell.getSheet(), null);
    assert.equal(phone.closedCount(), 1);
    assert.equal(document.activeElement, tab(sheet));
    for (const id of MOBILE_SHEET_PANELS[sheet])
      assert.equal(phone.collapsed(id), true);
    assert.ok(
      phone.calls.every(
        (call) => call.persist === false && call.syncShare === false,
      ),
    );
    shell.destroy();
  }
});

test('content scroll stays native, including a scroll that reaches the top mid-gesture', () => {
  for (const nested of [false, true]) {
    const { document, shell, press } = fixture();
    press('layers');
    const panel = document.getElementById('data-panel');
    const scroller = nested
      ? panel
      : document.getElementById('left-panel-stack');
    scroller.scrollTop = 40;
    touchEvent(document, 'touchstart', panel);
    scroller.scrollTop = 0;
    assert.equal(
      touchEvent(document, 'touchmove', panel, { y: 120 }).defaultPrevented,
      false,
    );
    touchEvent(document, 'touchend', panel, { y: 120 });
    assert.equal(shell.getSheet(), 'layers');
    shell.destroy();
  }
});

test('taps, short pulls, upward and horizontal gestures never dismiss', () => {
  for (const path of [
    [],
    [{ x: 12, y: 14 }],
    [{ y: 40 }],
    [{ y: -30 }, { y: 120 }],
    [{ x: 60, y: 12 }, { y: 120 }],
  ]) {
    const { document, shell, press } = fixture();
    press('layers');
    const panel = document.getElementById('data-panel');
    touchEvent(document, 'touchstart', panel);
    for (const point of path) touchEvent(document, 'touchmove', panel, point);
    touchEvent(document, 'touchend', panel, path.at(-1) ?? {});
    assert.equal(shell.getSheet(), 'layers');
    shell.destroy();
  }
});

test('native controls and custom sliders keep touch gestures', () => {
  for (const tag of [
    'button',
    'a',
    'input',
    'select',
    'textarea',
    'label',
    'slider',
    'editable',
  ]) {
    const { document, shell, press } = fixture();
    press('more');
    const control = document.createElement(
      ['slider', 'editable'].includes(tag) ? 'div' : tag,
    );
    if (tag === 'slider') control.setAttribute('role', 'slider');
    if (tag === 'editable') control.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    control.append(child);
    document.getElementById('control-panel').append(control);
    touchEvent(document, 'touchstart', child);
    assert.equal(
      touchEvent(document, 'touchmove', child, { y: 120 }).defaultPrevented,
      false,
    );
    touchEvent(document, 'touchend', child, { y: 120 });
    assert.equal(shell.getSheet(), 'more');
    shell.destroy();
  }
});

test('multitouch, cancellation, sheet changes and desktop transitions abandon the gesture', () => {
  for (const cancel of [
    'multitouch',
    'cancel',
    'sheet',
    'desktop',
    'noncancelable',
  ]) {
    const { document, shell, press, resize } = fixture();
    press('layers');
    const panel = document.getElementById('data-panel');
    touchEvent(document, 'touchstart', panel);
    if (cancel === 'multitouch')
      touchEvent(document, 'touchstart', document.body, { count: 2 });
    if (cancel === 'cancel') touchEvent(document, 'touchcancel', panel);
    if (cancel === 'sheet') press('context');
    if (cancel === 'desktop') {
      resize(false);
      resize(true);
      press('layers');
    }
    if (cancel === 'noncancelable')
      touchEvent(document, 'touchmove', panel, { y: 30, cancelable: false });
    assert.equal(
      touchEvent(document, 'touchmove', panel, { y: 120 }).defaultPrevented,
      false,
    );
    touchEvent(document, 'touchend', panel, { y: 120 });
    assert.equal(shell.getSheet(), cancel === 'sheet' ? 'context' : 'layers');
    shell.destroy();
  }
});

test('touches outside the active sheet and destroyed listeners cannot dismiss or claim a gesture', () => {
  const { document, shell, press } = fixture();
  press('layers');
  const hiddenPanel = document.getElementById('global-context-panel');
  touchEvent(document, 'touchstart', hiddenPanel);
  assert.equal(
    touchEvent(document, 'touchmove', hiddenPanel, { y: 120 }).defaultPrevented,
    false,
  );
  touchEvent(document, 'touchend', hiddenPanel, { y: 120 });
  assert.equal(shell.getSheet(), 'layers');
  const panel = document.getElementById('data-panel');
  touchEvent(document, 'touchstart', panel);
  shell.destroy();
  assert.equal(
    touchEvent(document, 'touchmove', panel, { y: 120 }).defaultPrevented,
    false,
  );
  touchEvent(document, 'touchend', panel, { y: 120 });
  assert.equal(shell.getSheet(), null);
});

test('the tab-open callback reports only a successful manual opening', () => {
  const opened = [];
  const phone = fixture({ onTabOpened: (sheet) => opened.push(sheet) });
  phone.shell.setSheet('context');
  assert.deepEqual(opened, []);
  phone.press('context');
  assert.deepEqual(opened, [], 'closing is not a new context request');
  phone.press('context');
  assert.deepEqual(opened, ['context']);
  phone.setBodyClass('cockpit-mode');
  phone.press('context');
  assert.deepEqual(
    opened,
    ['context'],
    'blocked sheets cannot activate a mode',
  );
  phone.shell.destroy();
});

test('manual Context opens the existing transaction without disabling the tracked aircraft', async () => {
  const calls = [];
  const tracked = { layerId: 'flights', icao24: 'abc123', callsign: 'EJA225' };
  const viewer = { trackedEntity: { gevTrackedId: 'flights:abc123' } };
  const entity = viewer.trackedEntity;
  const enabled = new Set(['flights', 'weather']);
  const controls = new ContextControls({
    elements: {},
    installations: {},
    actions: {
      getCockpit: () => null,
      claimVisualAuthority: () => calls.push('claim'),
      syncDetection() {},
      scheduleLayout() {},
      showToast() {},
    },
  });
  controls.connect({
    layers: new Map(
      ['flights', 'weather', 'military-awareness'].map((id) => [id, {}]),
    ),
    getEnabledLayerIds: () => [...enabled],
    getLayerParams: () => ({}),
    isEffectivelyEnabled: (id) => enabled.has(id),
    isEnabled: (id) => enabled.has(id),
    setLayerParams: (id, params) => calls.push({ id, params }),
    setEnabled: async (id, value) => {
      calls.push({ id, value });
      if (!value) enabled.delete(id);
      if (id === 'flights' && !value) viewer.trackedEntity = null;
      return true;
    },
    _setEnabledWithIntent: (id, value) => {
      calls.push({ id, value });
      enabled.add(id);
      return { intentEpoch: 1, promise: Promise.resolve(true) };
    },
  });
  const shell = {
    cockpitView: {
      readAircraftInfo: () => (viewer.trackedEntity ? tracked : null),
    },
    getAircraftTrackingTarget: StyleManager.prototype.getAircraftTrackingTarget,
    getContextModeState: () => controls.getContextModeState(),
    setContextMode: (mode) => controls.setContextMode(mode),
    _showToast: () => assert.fail('successful entry must not report a failure'),
  };
  try {
    assert.equal(
      await StyleManager.prototype._onMobileTabOpened.call(shell, 'context'),
      true,
    );
    assert.equal(controls.getContextModeState().mode, 'flights');
    assert.equal(viewer.trackedEntity, entity);
    assert.deepEqual(shell.getAircraftTrackingTarget(), {
      layerId: 'flights',
      id: 'abc123',
    });
    assert.ok(enabled.has('flights'));
    assert.ok(
      calls.some(
        (call) => call.id === 'military-awareness' && call.value === true,
      ),
    );
    assert.ok(!calls.some((call) => call.id === 'flights'));
    const count = calls.length;
    assert.equal(
      await StyleManager.prototype._onMobileTabOpened.call(shell, 'context'),
      false,
    );
    assert.equal(
      calls.length,
      count,
      'an already active Contacts session is not restarted',
    );
  } finally {
    controls.stop();
    controls.disconnect();
  }
});

test('manual Context respects Space Missions, busy transitions, missing tracks and disposal', async () => {
  for (const state of [
    { mode: 'space-missions' },
    { mode: 'flights' },
    { changing: true },
    { entering: 'space-missions' },
    { noTrack: true },
    { disposed: true },
    { sheet: 'layers' },
  ]) {
    const shell = {
      _disposed: state.disposed,
      getContextModeState: () => state,
      getAircraftTrackingTarget: () =>
        state.noTrack ? null : { layerId: 'flights', id: 'abc123' },
      setContextMode: () =>
        assert.fail('guarded tab must not mutate Context or tracking'),
    };
    assert.equal(
      await StyleManager.prototype._onMobileTabOpened.call(
        shell,
        state.sheet || 'context',
      ),
      false,
    );
  }
});

test('failed mobile Contacts entry uses the existing notice and cancelled/disposed entries stay quiet', async () => {
  for (const outcome of ['failure', 'throw', 'cancelled', 'disposed']) {
    const notices = [];
    const shell = {
      getContextModeState: () => ({ mode: null }),
      getAircraftTrackingTarget: () => ({ layerId: 'flights', id: 'abc123' }),
      setContextMode: async () => {
        if (outcome === 'throw') throw new Error('source unavailable');
        if (outcome === 'disposed') shell._disposed = true;
        return { ok: false, cancelled: outcome === 'cancelled' };
      },
      _showToast: (message) => notices.push(message),
    };
    assert.equal(
      await StyleManager.prototype._onMobileTabOpened.call(shell, 'context'),
      false,
    );
    assert.equal(
      notices.length,
      ['failure', 'throw'].includes(outcome) ? 1 : 0,
    );
  }
});

test('a slow downward pull is claimed before Android native scroll takes ownership', () => {
  const { document, shell, press } = fixture();
  press('layers');
  const panel = document.getElementById('data-panel');
  touchEvent(document, 'touchstart', panel, { y: 100 });
  assert.equal(
    touchEvent(document, 'touchmove', panel, { y: 102 }).defaultPrevented,
    false,
    'tap jitter is left native',
  );
  assert.equal(
    touchEvent(document, 'touchmove', panel, { y: 109.3 }).defaultPrevented,
    true,
    'cancel the first directional move while Android still allows it',
  );
  assert.equal(
    touchEvent(document, 'touchmove', panel, { y: 131 }).defaultPrevented,
    true,
  );
  touchEvent(document, 'touchend', panel, { y: 175 });
  assert.equal(shell.getSheet(), null);
  shell.destroy();
});
