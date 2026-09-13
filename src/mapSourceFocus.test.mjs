import { createHoverDisclosure, collapsePanelOnEscape } from './ui/panelDisclosure.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the installed event routes and central close method, without WebGL.
const source = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const locationMarkup = markup.slice(markup.indexOf('<div id="location-bar"'), markup.indexOf('<div id="left-panel-stack"'));
const locationToggleMarkup = locationMarkup.match(/<button\b([^>]*\bid="location-bar-toggle"[^>]*)>([\s\S]*?)<\/button>/);
const locationToggleAttributes = Object.fromEntries(
  [...(locationToggleMarkup?.[1] || '').matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
);
const initStart = source.indexOf('  _initAutoHoverPanel(');
const initEnd = source.indexOf('  /**\n   * Sets up drag-to-reposition', initStart);
const escapeStart = source.indexOf('  _collapsePanelOnEscape(');
const escapeEnd = source.indexOf('  _initCommandDockPins(', escapeStart);
const closeStart = source.indexOf('  setPanelCollapsed(panelId, collapsed, {');
const closeEnd = source.indexOf('  /**\n   * Toggles "clean view"', closeStart);
const syncStart = source.indexOf('  _syncPanelCollapseButton(panelEl) {');
const syncEnd = source.indexOf('  /**\n   * Converts a panel', syncStart);
assert.ok(initStart >= 0 && initEnd > initStart && escapeStart >= 0 && escapeEnd > escapeStart
  && closeStart >= 0 && closeEnd > closeStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart);

function harness({ hidden = false, selected = true, noChips = false } = {}) {
  let now = 0;
  let nextTimer = 0;
  let focusCalls = 0;
  const timers = new Map();
  const document = { activeElement: null };
  const makeNode = (id, attributes = {}) => {
    const listeners = new Map();
    const classes = new Set();
    return {
      id, listeners, classes, hovered: false,
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      classList: {
        contains: (name) => classes.has(name),
        remove: (name) => classes.delete(name),
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); },
      },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      removeEventListener(type, callback) {
        const values = listeners.get(type) || [];
        listeners.set(type, values.filter((item) => item !== callback));
      },
      matches(selector) { return selector === ':hover' ? this.hovered : true; },
      closest() { return this.isDisclosure ? this : null; },
    };
  };
  const panel = makeNode('control-panel');
  const location = makeNode('location-bar');
  panel.classes.add('collapsed');
  location.classes.add('collapsed');
  const disclosure = makeNode('control-panel-toggle');
  disclosure.isDisclosure = true;
  const locationDisclosure = locationToggleMarkup ? makeNode('location-bar-toggle', { ...locationToggleAttributes }) : null;
  if (locationDisclosure) locationDisclosure.isDisclosure = true;
  const locationSearch = makeNode('location-search');
  const first = makeNode('photoreal');
  const active = makeNode('osm');
  const elsewhere = makeNode('elsewhere');
  const nodes = [panel, location, disclosure, locationDisclosure, locationSearch, first, active, elsewhere].filter(Boolean);
  document.getElementById = (id) => nodes.find((node) => node.id === id);
  panel.contains = (node) => [panel, disclosure, first, active].includes(node);
  location.contains = (node) => Boolean(node) && [location, locationDisclosure, locationSearch].includes(node);
  panel.querySelector = (selector) => {
    if (selector.startsWith('[data-dock-toggle-target')) return disclosure;
    if (selector.split(',').some((part) => part.trim() === '.panel-title')) return { textContent: 'VISUAL STYLES' };
    if (noChips) return null;
    if (selector === '.map-stack-chip.active') return selected ? active : null;
    return selector === '.map-stack-chip' ? first : null;
  };
  location.querySelector = (selector) => {
    if (selector === '[data-dock-toggle-target="location-bar"]') {
      return locationDisclosure?.getAttribute('data-dock-toggle-target') === 'location-bar' ? locationDisclosure : null;
    }
    if (selector.split(',').some((part) => part.trim() === '.location-toolbar-label')) return { textContent: 'LOCATION' };
    return null;
  };
  panel.querySelectorAll = location.querySelectorAll = () => [];
  const emit = (node, type, values = {}) => {
    assert.ok(node, 'the event target exists in the actual panel markup');
    const event = {
      target: node, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...values,
    };
    for (const callback of node.listeners.get(type) || []) callback(event);
    return event;
  };
  const focus = (node) => {
    const prior = document.activeElement;
    if (prior === node) return;
    document.activeElement = node;
    for (const owner of [panel, location]) {
      if (owner.contains(prior)) emit(owner, 'focusout', { target: prior, relatedTarget: node });
      if (owner.contains(node)) emit(owner, 'focusin', { target: node, relatedTarget: prior });
    }
  };
  disclosure.focus = () => focus(disclosure);
  if (locationDisclosure) locationDisclosure.focus = () => focus(locationDisclosure);
  for (const chip of [first, active]) {
    chip.focus = () => { focusCalls += 1; if (!hidden) focus(chip); };
  }
  const window = {
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.performance = { now: () => now };
  document.defaultView = window;
  const methods = new Function('createHoverDisclosure', 'collapsePanelOnEscape', 'document', 'window', 'clearTimeout', 'performance', 'requestAnimationFrame',
    `return ({${source.slice(initStart, initEnd)},\n${source.slice(escapeStart, escapeEnd)},\n${source.slice(closeStart, closeEnd)},\n${source.slice(syncStart, syncEnd)}});`)(
    createHoverDisclosure, collapsePanelOnEscape, document, window, (id) => timers.delete(id), { now: () => now }, () => {},
  );
  const saves = [];
  const claims = [];
  let shareSyncs = 0;
  const manager = {
    ...methods,
    _savePanelCollapsedState(...args) { saves.push(args); },
    _scheduleLeftPanelLayout() {}, _scheduleRightPanelLayout() {},
    shareLinkManager: {
      claimRestoreLane(...args) { claims.push(args); },
      onPanelStateChange() { shareSyncs += 1; },
    },
  };
  manager._initAutoHoverPanel('control-panel');
  manager._initAutoHoverPanel('location-bar');
  disclosure.focus();
  const tick = () => {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    timers.delete(next[0]); now = next[1].at; next[1].callback();
  };
  return {
    manager, panel, location, disclosure, locationDisclosure, locationSearch,
    first, active, elsewhere, document, timers, emit, focus, tick, saves, claims,
    calls: () => focusCalls,
    shareSyncs: () => shareSyncs,
    show() { hidden = false; },
    select(value) { selected = value; },
    key(key = 'Enter', repeat = false) { return emit(disclosure, 'keydown', { key, repeat }); },
    keyUp(key = ' ', repeat = false) {
      const event = emit(disclosure, 'keyup', { key, repeat });
      if (key === ' ' && !repeat && document.activeElement === disclosure && !event.defaultPrevented) emit(disclosure, 'click', { detail: 0 });
      return event;
    },
    escape() { emit(panel, 'keydown', { key: 'Escape' }); },
    locationKey(key = 'Enter', repeat = false) { return emit(locationDisclosure, 'keydown', { key, repeat }); },
    locationKeyUp(key = ' ', repeat = false) {
      const event = emit(locationDisclosure, 'keyup', { key, repeat });
      if (key === ' ' && !repeat && document.activeElement === locationDisclosure && !event.defaultPrevented) {
        emit(locationDisclosure, 'click', { detail: 0 });
      }
      return event;
    },
    locationEscape() { return emit(location, 'keydown', { key: 'Escape', target: document.activeElement }); },
    click(detail = 1) { emit(disclosure, 'click', { detail }); },
    drain() { for (let i = 0; i < 40 && timers.size; i += 1) tick(); },
  };
}

test('Enter focuses selected OSM rather than the first chip', () => {
  const h = harness(); h.key(); h.tick();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.timers.size, 0);
});
test('Space waits for release before its synthesized click opens the tray', () => {
  const h = harness();
  const down = h.key(' ');
  assert.equal(down.defaultPrevented, false);
  assert.equal(down.propagationStopped, false);
  assert.equal(h.panel.classList.contains('collapsed'), true);
  assert.equal(h.timers.size, 0);
  h.keyUp(' '); h.tick();
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.document.activeElement, h.active);
});
test('repeated keydown does not close an opening tray or replace its timer', () => {
  const h = harness(); h.key(); const timer = [...h.timers.keys()][0]; h.key('Enter', true);
  assert.equal([...h.timers.keys()][0], timer);
  assert.equal(h.panel.classList.contains('collapsed'), false);
});
test('missing selection falls back to the first chip', () => {
  const h = harness({ selected: false }); h.key(); h.tick();
  assert.equal(h.document.activeElement, h.first);
});
test('delayed visibility retries until focus lands', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.tick();
  assert.equal(h.document.activeElement, h.disclosure);
  assert.equal(h.timers.size, 1); h.show(); h.tick();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.calls(), 3); assert.equal(h.timers.size, 0);
});
test('selection is read again when a delayed attempt can focus', () => {
  const h = harness({ hidden: true, selected: false }); h.key(); h.tick();
  h.select(true); h.show(); h.tick();
  assert.equal(h.document.activeElement, h.active);
});
test('permanently hidden and missing targets have bounded work', () => {
  for (const options of [{ hidden: true }, { noChips: true }]) {
    const h = harness(options); h.key(); h.drain();
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls(), options.noChips ? 0 : 25);
    assert.equal(h.document.activeElement, h.disclosure);
  }
});
test('focus departure cancels immediately even if focus returns before the timer', () => {
  const h = harness(); h.key(); h.focus(h.elsewhere); h.focus(h.disclosure);
  assert.equal(h.timers.size, 0); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('deliberate focus movement inside the tray cancels pending retries', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.focus(h.first);
  assert.equal(h.timers.size, 0); h.show(); h.drain();
  assert.equal(h.document.activeElement, h.first); assert.equal(h.calls(), 1);
});
test('Escape cancels immediately, closes the tray and restores disclosure focus', () => {
  const h = harness({ hidden: true }); h.key(); h.tick(); h.escape();
  assert.equal(h.timers.size, 0); assert.equal(h.document.activeElement, h.disclosure);
  assert.equal(h.panel.classList.contains('collapsed'), true); h.show(); h.drain();
  assert.equal(h.calls(), 1);
});
test('the central close seam cancels before both transition and already-closed return', () => {
  for (const alreadyClosed of [false, true]) {
    const h = harness(); h.key();
    if (alreadyClosed) h.panel.classes.add('collapsed');
    h.manager.setPanelCollapsed('control-panel', true, { persist: false, syncShare: false });
    assert.equal(h.timers.size, 0); h.drain(); assert.equal(h.calls(), 0);
  }
});
test('opening the unpinned Location sibling cancels the Map Source request', () => {
  const h = harness(); h.key(); h.manager.setPanelCollapsed('location-bar', false);
  assert.equal(h.panel.classList.contains('collapsed'), true);
  assert.equal(h.timers.size, 0); h.drain(); assert.equal(h.calls(), 0);
});
test('a pinned Map Source tray retains its own request when the sibling opens', () => {
  const h = harness(); h.panel.classes.add('dock-pinned'); h.key();
  h.manager.setPanelCollapsed('location-bar', false); h.tick();
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.document.activeElement, h.active);
});
test('pointer activation revokes a pending keyboard request without moving focus', () => {
  const h = harness(); h.key(); h.emit(h.panel, 'pointerdown');
  assert.equal(h.timers.size, 0); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('close then pointer or programmatic reopen cannot inherit a keyboard request', () => {
  for (const reopen of [(h) => h.click(1), (h) => h.manager.setPanelCollapsed('control-panel', false)]) {
    const h = harness(); h.key(); const stale = [...h.timers.values()][0].callback;
    h.escape(); reopen(h); stale(); h.drain();
    assert.equal(h.panel.classList.contains('collapsed'), false);
    assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
  }
});
test('a stale callback cannot focus or clear the timer owned by a new keyboard opening', () => {
  const h = harness(); h.key(); const stale = [...h.timers.values()][0].callback;
  h.escape(); h.key(); const timer = [...h.timers.keys()][0]; stale();
  assert.equal(h.calls(), 0); assert.equal([...h.timers.keys()][0], timer);
  h.tick(); assert.equal(h.document.activeElement, h.active);
});
test('plain pointer opening does not request focus', () => {
  const h = harness(); h.click(1); h.drain();
  assert.equal(h.document.activeElement, h.disclosure); assert.equal(h.calls(), 0);
});
test('pointer leave preserves established keyboard focus and the open tray', () => {
  const h = harness(); h.key(); h.tick(); h.emit(h.panel, 'pointerleave', { pointerType: 'mouse' }); h.drain();
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.panel.classList.contains('collapsed'), false);
});


test('Location markup provides one named native disclosure linked to its popover', () => {
  assert.ok(locationToggleMarkup, 'Location must expose a native button in the real markup');
  assert.equal(locationToggleAttributes.type, 'button');
  assert.equal(locationToggleAttributes['data-dock-toggle-target'], 'location-bar');
  assert.equal(locationToggleAttributes['aria-controls'], 'location-bar-popover');
  assert.equal(locationToggleAttributes['aria-expanded'], 'false');
  assert.match(locationToggleAttributes['aria-label'], /expand.*location/i);
  assert.match(locationToggleAttributes.class, /(?:^|\s)dock-tray-toggle(?:\s|$)/);
  assert.match(locationToggleMarkup[2], /class="location-toolbar-label"/);
  assert.doesNotMatch(locationToggleMarkup[2], /<button\b/);
  assert.match(locationMarkup.slice(locationToggleMarkup.index + locationToggleMarkup[0].length),
    /^\s*<button class="panel-collapse-btn" data-collapse-target="location-bar"/);
  assert.match(locationMarkup, /<div id="location-bar-popover" class="dock-popover-content">/);
});

test('Location Enter stays immediate while Space waits for native key release', () => {
  for (const key of ['Enter', ' ']) {
    const h = harness(); h.focus(h.locationDisclosure); h.drain();
    const event = h.locationKey(key);
    assert.equal(event.defaultPrevented, key === 'Enter');
    assert.equal(event.propagationStopped, key === 'Enter');
    if (key === ' ') {
      assert.equal(h.location.classList.contains('collapsed'), true);
      h.locationKeyUp(key);
    }
    assert.equal(h.location.classList.contains('collapsed'), false);
    assert.equal(h.locationDisclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(h.locationDisclosure.getAttribute('aria-label'), 'Collapse LOCATION');
    assert.equal(h.document.activeElement, h.locationDisclosure);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls(), 0);
    const repeated = h.locationKey(key, true);
    assert.equal(repeated.defaultPrevented, key === 'Enter');
    assert.equal(repeated.propagationStopped, key === 'Enter');
    assert.equal(h.location.classList.contains('collapsed'), false);
    assert.equal(h.timers.size, 0);
    const release = key === ' ' ? h.locationKeyUp(key, true) : h.emit(h.locationDisclosure, 'keyup', { key });
    assert.equal(release.defaultPrevented, false, 'global voice release must remain reachable');
    assert.equal(release.propagationStopped, false);
    h.locationKey(key);
    if (key === ' ') h.locationKeyUp(key);
    assert.equal(h.location.classList.contains('collapsed'), true);
    assert.equal(h.locationDisclosure.getAttribute('aria-label'), 'Expand LOCATION');
  }
});

test('Location synthesized click and Escape retain focus and its accessible name', () => {
  const h = harness(); h.focus(h.locationDisclosure); h.drain();
  h.emit(h.locationDisclosure, 'click', { detail: 0 });
  assert.equal(h.location.classList.contains('collapsed'), false);
  assert.equal(h.calls(), 0);
  assert.equal(h.timers.size, 0);
  h.focus(h.locationSearch);
  const escape = h.locationEscape();
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.location.classList.contains('collapsed'), true);
  assert.equal(h.locationDisclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(h.locationDisclosure.getAttribute('aria-label'), 'Expand LOCATION');
  assert.equal(h.locationDisclosure.title, 'Expand LOCATION');
  assert.equal(h.document.activeElement, h.locationDisclosure);
  h.drain();
  assert.equal(h.calls(), 0);
});

test('Location keyboard opening cancels the unpinned sibling and cannot revive its old callback', () => {
  const h = harness({ hidden: true }); h.key(); h.tick();
  const stale = [...h.timers.values()][0].callback;
  h.focus(h.locationDisclosure); h.locationKey();
  assert.equal(h.panel.classList.contains('collapsed'), true);
  assert.equal(h.location.classList.contains('collapsed'), false);
  const attemptsBefore = h.calls();
  h.show(); stale(); h.drain();
  assert.equal(h.calls(), attemptsBefore);
  assert.equal(h.document.activeElement, h.locationDisclosure);
});

test('Location keyboard opening preserves a pinned sibling and a pinned Location survives sibling opening', () => {
  const h = harness(); h.panel.classes.add('dock-pinned'); h.key(); h.tick();
  h.focus(h.locationDisclosure); h.locationKey(); h.drain();
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.location.classList.contains('collapsed'), false);
  assert.equal(h.document.activeElement, h.locationDisclosure);
  h.location.classes.add('dock-pinned');
  h.manager.setPanelCollapsed('control-panel', true);
  h.focus(h.disclosure); h.key(); h.tick();
  assert.equal(h.location.classList.contains('collapsed'), false);
  assert.equal(h.locationDisclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.active);
});

test('Location restoration syncs its real name without claiming focus, collapsing its sibling or persisting', () => {
  const h = harness(); h.key(); h.tick();
  const saves = h.saves.length;
  const claims = h.claims.length;
  const shareSyncs = h.shareSyncs();
  h.manager.setPanelCollapsed('location-bar', false, { restore: true, persist: false, syncShare: false });
  assert.equal(h.panel.classList.contains('collapsed'), false);
  assert.equal(h.location.classList.contains('collapsed'), false);
  assert.equal(h.locationDisclosure.getAttribute('aria-label'), 'Collapse LOCATION');
  assert.equal(h.document.activeElement, h.active);
  assert.equal(h.saves.length, saves);
  assert.equal(h.claims.length, claims);
  assert.equal(h.shareSyncs(), shareSyncs);
  h.locationDisclosure.setAttribute('aria-label', 'stale');
  h.manager.setPanelCollapsed('location-bar', false, { restore: true, persist: false, syncShare: false });
  assert.equal(h.locationDisclosure.getAttribute('aria-label'), 'Collapse LOCATION', 'same-state synchronization keeps the Location name');
  assert.equal(h.timers.size, 0);
});

test('disposed UI cannot complete a pending handoff', () => {
  const h = harness({ hidden: true }); h.key(); h.tick();
  h.manager._disposed = true; h.show(); h.drain();
  assert.equal(h.document.activeElement, h.disclosure);
  assert.equal(h.calls(), 1); assert.equal(h.timers.size, 0);
});


test('destroying hover controls cancels pending opens and removes their event routes', () => {
  const h = harness();
  h.panel.hovered = true;
  h.emit(h.panel, 'pointerenter', { pointerType: 'mouse' });
  assert.ok(h.timers.size > 0);
  const control = h.manager._hoverPanelControls.get('control-panel');
  control.destroy();
  control.destroy();
  assert.equal(h.timers.size, 0);
  for (const node of [h.panel, h.disclosure]) {
    assert.equal([...node.listeners.values()].flat().length, 0);
  }
  h.key();
  h.drain();
  assert.equal(h.panel.classes.has('collapsed'), true);
  assert.equal(h.calls(), 0);
});

test('destroying an open tray cancels close and focus work without changing saved state', () => {
  const h = harness({ hidden: true });
  h.key();
  h.emit(h.panel, 'pointerleave', { pointerType: 'mouse' });
  const callbacks = [...h.timers.values()].map((timer) => timer.callback);
  const saves = h.saves.length;
  h.manager._hoverPanelControls.get('control-panel').destroy();
  assert.equal(h.timers.size, 0);
  h.show();
  for (const callback of callbacks) callback();
  assert.equal(h.panel.classes.has('collapsed'), false);
  assert.equal(h.saves.length, saves);
  assert.equal(h.calls(), 0, 'even an already queued focus attempt is revoked');
});

test('replacing hover controls removes the previous listeners before rebinding', () => {
  const h = harness();
  h.manager._initAutoHoverPanel('control-panel');
  h.key();
  assert.equal(h.panel.classes.has('collapsed'), false, 'one activation toggles only once');
  h.tick();
  assert.equal(h.calls(), 1);
});


test('teardown during an opening callback cannot enqueue a later focus handoff', () => {
  const h = harness({ hidden: true });
  const change = h.manager.setPanelCollapsed.bind(h.manager);
  h.manager.setPanelCollapsed = (...args) => {
    change(...args);
    h.manager._hoverPanelControls.get('control-panel').destroy();
  };
  h.key();
  assert.equal(h.timers.size, 0);
  h.show();
  h.drain();
  assert.equal(h.calls(), 0);
});
