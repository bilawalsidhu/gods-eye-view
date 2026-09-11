import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

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
  const manager = new Function('document', `return {${method('_collapsePanelOnEscape', '_initCommandDockPins')}};`)(document);
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
    manager, panel, inner, target, event,
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
  const removed = [];
  let blurred = false;
  fixture.manager._locationSearch = {
    classList: { remove: (...names) => removed.push(...names) },
    value: 'focus cleanup',
    blur: () => { blurred = true; },
  };
  assert.equal(fixture.manager._collapsePanelOnEscape(fixture.event, 'location-bar'), true);
  assert.deepEqual(removed, ['expanded']);
  assert.equal(fixture.manager._locationSearch.value, '');
  assert.equal(blurred, true);
  assert.equal(fixture.focused(), true);
});

test('panel chrome wires Escape for every declared collapse target', () => {
  const init = method('_initPanelChrome', '_collapsePanelOnEscape');
  assert.match(init, /for \(const targetId of targets\)[\s\S]*?addEventListener\('keydown'[\s\S]*?_collapsePanelOnEscape\(event, targetId\)/);
  assert.match(source, /_initAutoHoverPanel[\s\S]*?if \(event\.key !== 'Escape'\) return;[\s\S]*?_collapsePanelOnEscape\(event, panelId\)[\s\S]*?clearOpen\(\);[\s\S]*?clearClose\(\);/);
});

test('Cockpit Escape collapses Contact or Live Signals before exiting Cockpit', () => {
  const onKeyDown = method('onKeyDown', 'enter');
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
    source,
    /const nestedPanel = event\.target\?\.closest\?\.\('\.panel-collapsible:not\(\.collapsed\), #param-slider-panel:not\(\.collapsed\)'\);[\s\S]*?if \(nestedPanel\) return;[\s\S]*?setCockpitDisclosure/,
  );
  assert.match(
    source,
    /const kind = displayOpen \? 'display' : 'radio';[\s\S]*?escapedFromDisclosure[\s\S]*?returnFocus: !escapedFromDisclosure[\s\S]*?disclosure\?\.blur/,
    'Cockpit utility disclosures clear their own focus when Escape closes them',
  );
  assert.match(
    source,
    /_contextRadioDock\?\.classList\.contains\('disclosure-open'\)[\s\S]*?escapedFromDisclosure[\s\S]*?setRadioDisclosure\(false, \{ returnFocus: !escapedFromDisclosure \}\)[\s\S]*?_contextRadioToggleBtn\?\.blur/,
    'compact Radio disclosure clears its own focus when Escape closes it',
  );
});
