import { readShellSource } from './testSupport/readShellSource.mjs';
import { onKeyDown as cockpitKeyDown } from './ui/cockpitInput.js';
import { readFileSync as readRadioSource } from 'node:fs';
const radioBindings = readRadioSource(new URL('./ui/radioBindings.js', import.meta.url), 'utf8');
import { bindPanelDisclosure, collapsePanelOnEscape } from './ui/panelDisclosure.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readShellSource();

function method(name, nextName) {
  const start = source.indexOf(`  ${name}(`);
  const end = source.indexOf(`\n  ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source is available`);
  return source.slice(start, end);
}

function panelFixture({ id = 'data-panel', nested = false, nestedCollapsed = false, onDisclosure = false } = {}) {
  let collapsed = false;
  let focused = false;
  let blurred = false;
  const disclosure = {
    focus: () => { focused = true; },
    blur: () => { blurred = true; focused = false; },
    contains: (candidate) => candidate === disclosure,
  };
  const panel = {
    id,
    classList: { contains: (name) => name === 'collapsed' && collapsed },
    contains: (target) => target?.panel === panel,
    querySelector: () => disclosure,
  };
  const inner = nested ? { id: 'param-slider-panel' } : panel;
  const target = onDisclosure ? disclosure : {
    panel,
    closest: (selector) => (
      nested && nestedCollapsed && selector.includes(':not(.collapsed)') ? panel : inner
    ),
  };
  if (onDisclosure) {
    disclosure.panel = panel;
    disclosure.closest = () => panel;
  }
  const document = { getElementById: (candidate) => candidate === id ? panel : null };
  const manager = new Function('document', 'getComputedStyle', 'collapsePanelOnEscape', `return {${method('_collapsePanelOnEscape', '_togglePanel')}};`)(document, (el) => ({ visibility: el.visibility ?? 'visible' }), collapsePanelOnEscape);
  manager.setPanelCollapsed = (candidate, value, options) => {
    assert.equal(candidate, id);
    assert.equal(value, true);
    assert.deepEqual(options, { explicit: true });
    collapsed = true;
  };
  const event = {
    key: 'Escape', target, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  return {
    manager, panel, inner, target, event, document,
    collapsed: () => collapsed,
    focused: () => focused,
    blurred: () => blurred,
  };
}

test('Escape collapses an expanded panel and returns focus to its disclosure', () => {
  const fixture = panelFixture();
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'data-panel'), true);
  assert.equal(fixture.collapsed(), true);
  assert.equal(fixture.focused(), true);
  assert.equal(fixture.event.defaultPrevented, true);
  assert.equal(fixture.event.propagationStopped, true);
});

test('Escape hands focus to the rail item when collapsing hides the panel', () => {
  const fixture = panelFixture();
  let railFocused = false;
  const railItem = {
    disabled: false,
    getClientRects: () => [{}],
    focus: () => { railFocused = true; },
  };
  fixture.panel.getClientRects = () => (fixture.collapsed() ? [] : [{}]);
  fixture.document.querySelector = (selector) => {
    assert.equal(selector, '.ui-rail [data-rail-item="data-panel"]');
    return railItem;
  };
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'data-panel'), true);
  assert.equal(fixture.collapsed(), true);
  assert.equal(railFocused, true);
  assert.equal(fixture.focused(), false, 'not the hidden disclosure');
});

test('Escape keeps the disclosure path when the rail is hidden', () => {
  const fixture = panelFixture();
  let railFocused = false;
  const railItem = {
    disabled: false,
    visibility: 'hidden',
    getClientRects: () => [{}],
    focus: () => { railFocused = true; },
  };
  fixture.panel.getClientRects = () => (fixture.collapsed() ? [] : [{}]);
  fixture.document.querySelector = () => railItem;
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'data-panel'), true);
  assert.equal(railFocused, false);
  assert.equal(fixture.focused(), true);
});

test('Escape on an expanded panel disclosure closes it without retaining focus', () => {
  const fixture = panelFixture({ onDisclosure: true });
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'data-panel'), true);
  assert.equal(fixture.collapsed(), true);
  assert.equal(fixture.focused(), false);
  assert.equal(fixture.blurred(), true);
  assert.equal(fixture.event.defaultPrevented, true);
  assert.equal(fixture.event.propagationStopped, true);
});

test('non-Escape, handled, collapsed, and outside events do not collapse a panel', () => {
  for (const mutate of [
    (fixture) => { fixture.event.key = 'Enter'; },
    (fixture) => { fixture.event.defaultPrevented = true; },
    (fixture) => { fixture.manager.setPanelCollapsed('data-panel', true, { explicit: true }); },
    (fixture) => { fixture.event.target = { panel: null, closest: () => null }; },
  ]) {
    const fixture = panelFixture();
    mutate(fixture);
    const wasCollapsed = fixture.collapsed();
    assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'data-panel'), false);
    assert.equal(fixture.collapsed(), wasCollapsed);
    assert.equal(fixture.focused(), false);
  }
});

test('an expanded nested panel owns Escape before its expanded parent', () => {
  const inner = panelFixture({ id: 'param-slider-panel' });
  assert.equal(inner.manager._collapsePanelOnEscape(inner.event, 'param-slider-panel'), true);

  const outer = panelFixture({ id: 'pp-toggles', nested: true });
  assert.equal(outer.manager._collapsePanelOnEscape(outer.event, 'pp-toggles'), false);
  assert.equal(outer.collapsed(), false);
  assert.equal(outer.focused(), false);
});

test('a collapsed nested panel does not block the next Escape from closing its parent', () => {
  const outer = panelFixture({ id: 'pp-toggles', nested: true, nestedCollapsed: true });
  assert.equal(outer.manager._collapsePanelOnEscape(outer.event, 'pp-toggles'), true);
  assert.equal(outer.collapsed(), true);
  assert.equal(outer.focused(), true);
});

test('Location Escape clears a hidden draft search before restoring disclosure focus', () => {
  const fixture = panelFixture({ id: 'location-bar' });
  // The location controls close the field and drop its draft
  // (src/ui/locationControls.test.mjs).
  let closed = 0;
  fixture.manager._closeLocationSearch = () => { closed += 1; };
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'location-bar'), true);
  assert.equal(closed, 1);
  assert.equal(fixture.focused(), true);
});

test('panel chrome wires Escape for every declared collapse target', () => {
  const init = method('_initPanelChrome', '_collapsePanelOnEscape');
  assert.match(init, /for \(const targetId of targets\)/);
  assert.match(init, /bindPanelDisclosure\(\{[\s\S]*?onEscape: \(event\) => this\._collapsePanelOnEscape\(event, targetId\)/);
  assert.match(source, /createHoverDisclosure\(\{[\s\S]*?onEscape: \(event\) => this\._collapsePanelOnEscape\(event, panelId\)/);
});

test('Cockpit Escape collapses Contact or Live Signals before exiting Cockpit', () => {
  const onKeyDown = cockpitKeyDown.toString();
  assert.match(
    onKeyDown,
    /event\.target\?\.closest\?\.\('\.cesium-credit-lightbox'\)[\s\S]*?return;/,
    'the focused attribution lightbox keeps ownership of Escape before Cockpit',
  );
  assert.match(
    onKeyDown,
    /this\.context\?\.contains\(event\.target\)[\s\S]*?setContextCollapsed\(true\)[\s\S]*?event\.target === this\.contextToggle[\s\S]*?contextToggle\?\.blur[\s\S]*?contextToggle\?\.focus/,
  );
  assert.match(
    onKeyDown,
    /this\.signalStream\?\.contains\(event\.target\)[\s\S]*?setSignalCollapsed\(true, \{ user: true \}\)[\s\S]*?event\.target === this\.signalToggle[\s\S]*?signalToggle\?\.blur[\s\S]*?signalToggle\?\.focus/,
  );
  assert.ok(onKeyDown.indexOf('setContextCollapsed(true)') < onKeyDown.indexOf('this.exit()'));
  assert.ok(onKeyDown.indexOf('setSignalCollapsed(true') < onKeyDown.indexOf('this.exit()'));
});

test('Cockpit utility Escape leaves an expanded nested Parameters panel to the shared handler', () => {
  assert.match(
    radioBindings,
    /const nestedPanel = event\.target\?\.closest\?\.\(\s*'\.panel-collapsible:not\(\.collapsed\), #param-slider-panel:not\(\.collapsed\)',?\s*\);[\s\S]*?if \(nestedPanel\) return;[\s\S]*?setCockpitDisclosure/,
  );
  assert.match(
    radioBindings,
    /const kind = displayOpen \? 'display' : 'radio';[\s\S]*?escapedFromDisclosure[\s\S]*?returnFocus: !escapedFromDisclosure[\s\S]*?disclosure\?\.blur/,
    'Cockpit utility disclosures clear their own focus when Escape closes them',
  );
});


test('panel bindings have a single owner and are inert after destruction', () => {
  const panel = new EventTarget();
  let keys = 0;
  const bind = () => bindPanelDisclosure({ panel, onEscape() { keys += 1; } });
  const first = bind();
  panel.dispatchEvent(new Event('keydown'));
  assert.equal(keys, 1);
  first.destroy();
  first.destroy();
  panel.dispatchEvent(new Event('keydown'));
  assert.equal(keys, 1);
  const second = bind();
  panel.dispatchEvent(new Event('keydown'));
  assert.equal(keys, 2);
  second.destroy();
});
