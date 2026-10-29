import assert from 'node:assert/strict';
import test from 'node:test';
import { fire, makeDocument } from '../testSupport/fakeDom.mjs';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { readFileSync } from 'node:fs';
import {
  RAIL_TAB_ICONS,
  createRightRailTabs,
  nextRailTabIndex,
  railJoinPath,
} from './rightRailTabs.js';

function panel(
  doc,
  id,
  { title, titleClass = 'panel-title', collapsed = true, hidden = false },
) {
  const node = doc.createElement('div');
  node.id = id;
  node.dataset.panelId = id;
  node.hidden = hidden;
  if (collapsed) node.classList.add('collapsed');
  const header = doc.createElement('div');
  header.className = 'panel-header';
  const label = doc.createElement('span');
  label.className = titleClass;
  label.textContent = title;
  header.append(label);
  node.append(header);
  return node;
}

function fixture() {
  const doc = makeDocument();
  const rail = doc.createElement('aside');
  rail.id = 'right-context-rail';
  const display = panel(doc, 'pp-toggles', {
    title: 'DISPLAY',
    titleClass: 'pp-header-label',
  });
  const cctv = panel(doc, 'cctv-panel', { title: 'CCTV' });
  const weather = panel(doc, 'weather-panel', {
    title: 'WEATHER',
    collapsed: false,
    hidden: true,
  });
  const context = panel(doc, 'global-context-panel', { title: 'CONTEXT' });
  rail.append(display, cctv, weather, context);
  doc.body.append(rail);
  const calls = [];
  const tabs = createRightRailTabs({
    rail,
    documentRef: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  const strip = tabs.element;
  const column = doc.getElementById('right-rail-column');
  const tools = doc.getElementById('right-rail-tools');
  const join = rail.querySelector('.right-rail-join');
  const tabFor = (id) =>
    strip.children.find((tab) => tab.dataset.railTab === id);
  const iconOf = (tab) =>
    tab.children.find((child) =>
      child.classList.contains('right-rail-tab-icon'),
    );
  return {
    doc,
    rail,
    display,
    cctv,
    weather,
    context,
    tabs,
    strip,
    column,
    tools,
    join,
    calls,
    tabFor,
    iconOf,
  };
}

test('builds one icon tab per visible rail panel, in rail order, named from the panel header', () => {
  const f = fixture();
  assert.equal(
    f.rail.children[0],
    f.column,
    'the column precedes its panels in the tab order',
  );
  assert.deepEqual(
    f.column.children,
    [f.strip, f.tools],
    'the tablist, then the tool slot',
  );
  assert.deepEqual(f.tools.children, [], 'the slot starts empty');
  assert.equal(f.strip.getAttribute('role'), 'tablist');
  assert.equal(f.strip.getAttribute('aria-orientation'), 'vertical');
  assert.equal(f.rail.getAttribute('data-rail-tabs'), 'vertical');
  assert.deepEqual(
    f.strip.children.map((tab) => [
      tab.dataset.railTab,
      f.iconOf(tab).textContent,
      tab.getAttribute('aria-label'),
      tab.getAttribute('aria-controls'),
    ]),
    [
      ['pp-toggles', 'tune', 'DISPLAY', 'pp-toggles'],
      ['cctv-panel', 'videocam', 'CCTV', 'cctv-panel'],
      [
        'global-context-panel',
        'travel_explore',
        'CONTEXT',
        'global-context-panel',
      ],
    ],
    'a hidden panel (Weather off) has no tab',
  );
  for (const tab of f.strip.children) {
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(tab.type, 'button');
    assert.equal(f.iconOf(tab).getAttribute('aria-hidden'), 'true');
  }
});

test('the icon font subset carries every rail tab glyph', () => {
  const html = readFileSync(
    new URL('../../index.html', import.meta.url),
    'utf8',
  );
  const subset = /icon_names=([a-z0-9_,]+)/.exec(html)[1].split(',');
  for (const glyph of Object.values(RAIL_TAB_ICONS))
    assert.ok(subset.includes(glyph), glyph);
});

test('mirrors collapsed state into aria-selected, a roving tabindex and titles', () => {
  const f = fixture();
  assert.deepEqual(
    f.strip.children.map((tab) => tab.getAttribute('aria-selected')),
    ['false', 'false', 'false'],
  );
  assert.deepEqual(
    f.strip.children.map((tab) => tab.tabIndex),
    [0, -1, -1],
    'nothing open: the first tab is reachable',
  );
  assert.equal(f.tabFor('cctv-panel').title, 'Expand CCTV');
  f.cctv.classList.remove('collapsed');
  f.tabs.sync();
  assert.deepEqual(
    f.strip.children.map((tab) => tab.getAttribute('aria-selected')),
    ['false', 'true', 'false'],
  );
  assert.deepEqual(
    f.strip.children.map((tab) => tab.tabIndex),
    [-1, 0, -1],
    'the open panel owns the tab stop',
  );
  assert.equal(f.tabFor('cctv-panel').title, 'Collapse CCTV');
});

test('a click asks the owner for an explicit toggle and never touches the panel itself', () => {
  const f = fixture();
  fire(f.tabFor('cctv-panel'), 'click');
  assert.deepEqual(f.calls, [['cctv-panel', false, { explicit: true }]]);
  assert.equal(
    f.cctv.classList.contains('collapsed'),
    true,
    'the strip leaves the class to the owner',
  );
  f.cctv.classList.remove('collapsed');
  f.tabs.sync();
  fire(f.tabFor('cctv-panel'), 'click');
  assert.deepEqual(f.calls.at(-1), ['cctv-panel', true, { explicit: true }]);
  fire(f.strip, 'click');
  assert.equal(f.calls.length, 2, 'a click beside the tabs does nothing');
});

test('arrow keys move focus through the visible tabs and wrap; Home and End jump', () => {
  assert.equal(nextRailTabIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextRailTabIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextRailTabIndex('Home', 2, 3), 0);
  assert.equal(nextRailTabIndex('End', 0, 3), 2);
  assert.equal(nextRailTabIndex('Enter', 1, 3), 1);
  assert.equal(nextRailTabIndex('ArrowDown', 0, 0), -1);
  const f = fixture();
  const first = f.tabFor('pp-toggles');
  first.focus();
  const down = fire(first, 'keydown', { key: 'ArrowDown' });
  assert.equal(f.doc.activeElement, f.tabFor('cctv-panel'));
  assert.equal(down.defaultPrevented, true);
  fire(f.doc.activeElement, 'keydown', { key: 'ArrowUp' });
  fire(f.doc.activeElement, 'keydown', { key: 'ArrowUp' });
  assert.equal(
    f.doc.activeElement,
    f.tabFor('global-context-panel'),
    'Up from the first tab wraps to the last',
  );
  const enter = fire(f.doc.activeElement, 'keydown', { key: 'Enter' });
  assert.equal(
    enter.defaultPrevented,
    false,
    'activation keys stay with the button',
  );
  assert.deepEqual(f.calls, [], 'moving focus opens nothing');
});

test('a panel that appears gets its tab in rail order; one that leaves loses it', () => {
  const f = fixture();
  f.weather.hidden = false;
  f.tabs.sync();
  assert.deepEqual(
    f.strip.children.map((tab) => tab.dataset.railTab),
    ['pp-toggles', 'cctv-panel', 'weather-panel', 'global-context-panel'],
  );
  assert.equal(f.tabFor('weather-panel').getAttribute('aria-selected'), 'true');
  const cctvTab = f.tabFor('cctv-panel');
  f.cctv.remove();
  f.tabs.sync();
  assert.deepEqual(
    f.strip.children.map((tab) => tab.dataset.railTab),
    ['pp-toggles', 'weather-panel', 'global-context-panel'],
  );
  assert.equal(cctvTab.parentElement, null);
  assert.equal(f.tabFor('pp-toggles').tabIndex, -1);
  assert.equal(f.tabFor('weather-panel').tabIndex, 0);
});

test('a sync that changes nothing keeps the same tab elements in place', () => {
  const f = fixture();
  const before = [...f.strip.children];
  f.tabFor('cctv-panel').focus();
  f.tabs.sync();
  assert.deepEqual([...f.strip.children], before);
  assert.equal(f.doc.activeElement, f.tabFor('cctv-panel'));
});

test('publishes the open tab extent on the rail and keeps a join element under the panels', () => {
  const f = fixture();
  // The strip's offsets are relative to its column, the column's to the rail.
  Object.assign(f.column, { offsetTop: 0, offsetLeft: 320 });
  Object.assign(f.strip, { offsetLeft: 10 });
  const { props } = f.rail.style;
  assert.equal(f.join.parentElement, f.rail);
  assert.equal(f.join.getAttribute('aria-hidden'), 'true');
  assert.equal(f.join.hidden, true, 'nothing open, nothing to join');
  assert.deepEqual(
    f.join.children.map((layer) => layer.getAttribute('class')),
    [
      'right-rail-join-shadow',
      'right-rail-join-glass',
      'right-rail-join-outline',
    ],
  );
  const tab = f.tabFor('cctv-panel');
  Object.assign(tab, {
    offsetTop: 86,
    offsetLeft: 0,
    offsetHeight: 56,
    offsetWidth: 42,
  });
  Object.assign(f.cctv, {
    offsetTop: 0,
    offsetLeft: 0,
    offsetHeight: 300,
    offsetWidth: 330,
  });
  f.cctv.classList.remove('collapsed');
  f.tabs.sync();
  assert.deepEqual([...props], [['--rail-tab-bottom', '142px']]);
  assert.equal(f.join.hidden, false);
  const [, glass] = f.join.children;
  assert.match(
    glass.style.clipPath,
    /^path\('M 16 0 L 314 0 A 16 16 0 0 1 330 16 L 330 78 /,
  );
  f.cctv.classList.add('collapsed');
  f.tabs.sync();
  assert.deepEqual([...props], [], 'no open panel, no join');
  assert.equal(f.join.hidden, true);
  f.tabs.destroy();
  assert.equal(f.join.parentElement, null);
});

test('railJoinPath traces the panel with the tab attached: corners, fillets, tab corners', () => {
  const geometry = {
    panel: { x0: 0, y0: 0, x1: 330, y1: 378 },
    tab: { top: 85, bottom: 141, right: 372 },
    corner: 16,
    tabRadius: 10,
    fillet: 8,
  };
  assert.equal(
    railJoinPath(geometry),
    'M 16 0 L 314 0 A 16 16 0 0 1 330 16 L 330 77 A 8 8 0 0 0 338 85 ' +
      'L 362 85 A 10 10 0 0 1 372 95 L 372 131 A 10 10 0 0 1 362 141 ' +
      'L 338 141 A 8 8 0 0 0 330 149 L 330 362 A 16 16 0 0 1 314 378 ' +
      'L 16 378 A 16 16 0 0 1 0 362 L 0 16 A 16 16 0 0 1 16 0 Z',
  );
  assert.equal(
    railJoinPath({ ...geometry, tab: { top: 0, bottom: 79, right: 372 } }),
    'M 16 0 L 362 0 A 10 10 0 0 1 372 10 L 372 69 A 10 10 0 0 1 362 79 ' +
      'L 338 79 A 8 8 0 0 0 330 87 L 330 362 A 16 16 0 0 1 314 378 ' +
      'L 16 378 A 16 16 0 0 1 0 362 L 0 16 A 16 16 0 0 1 16 0 Z',
    'a tab level with the top shares the top edge: no corner, no upper fillet',
  );
  const stroke = railJoinPath({ ...geometry, inset: 0.5 });
  assert.match(stroke, /^M 16 0\.5 L 314 0\.5 A 15\.5 15\.5 0 0 1 329\.5 16 /);
  assert.match(
    stroke,
    / L 329\.5 77 A 8\.5 8\.5 0 0 0 338 85\.5 /,
    'an inset grows the concave fillets and shrinks the convex corners',
  );
  const chamfer = railJoinPath({
    ...geometry,
    panel: { x0: 0, y0: 0, x1: 312, y1: 374 },
    corner: 10,
    style: 'chamfer',
  });
  assert.equal(
    chamfer,
    'M 0 10 L 10 0 L 131 0 L 138 6 L 174 6 L 181 0 L 302 0 L 312 10 ' +
      'L 312 85 L 372 85 L 372 141 L 312 141 L 312 364 L 302 374 ' +
      'L 10 374 L 0 364 Z',
    'Cyber: chamfers, the calibration bay and a square tab',
  );
});

/** A browser-like MutationObserver over the fake tree. */
function installObservers(doc) {
  const live = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      live.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.targets = [];
    }
  }
  doc.defaultView = { MutationObserver: FakeMutationObserver };
  return {
    attributeChanged(target, name) {
      for (const observer of live) {
        const hit = observer.targets.some(
          ({ target: observed, options }) =>
            observed === target &&
            options.attributes &&
            (!options.attributeFilter ||
              options.attributeFilter.includes(name)),
        );
        if (hit)
          observer.callback([
            { type: 'attributes', target, attributeName: name },
          ]);
      }
    },
  };
}

test('a rail panel hidden at mount gets its tab when its owner unhides it, from the observers alone', () => {
  const doc = makeDocument();
  const { attributeChanged } = installObservers(doc);
  const rail = doc.createElement('aside');
  rail.id = 'right-context-rail';
  const display = panel(doc, 'pp-toggles', {
    title: 'DISPLAY',
    titleClass: 'pp-header-label',
    collapsed: false,
  });
  const cctv = panel(doc, 'cctv-panel', { title: 'CCTV' });
  const recent = panel(doc, 'recent-imagery-panel', {
    title: 'RECENT IMAGERY',
    hidden: true,
  });
  const context = panel(doc, 'global-context-panel', { title: 'CONTEXT' });
  rail.append(display, cctv, recent, context);
  doc.body.append(rail);
  const tabs = createRightRailTabs({
    rail,
    documentRef: doc,
    setPanelCollapsed() {},
  });
  const ids = () => tabs.element.children.map((tab) => tab.dataset.railTab);
  assert.deepEqual(ids(), ['pp-toggles', 'cctv-panel', 'global-context-panel']);
  // Recent Imagery's layer turns on: its owner removes `hidden`, then the
  // rail pass marks it collapsed behind the Display owner.
  recent.hidden = false;
  attributeChanged(recent, 'hidden');
  recent.classList.add('rail-owner-collapsed');
  attributeChanged(recent, 'class');
  assert.deepEqual(ids(), [
    'pp-toggles',
    'cctv-panel',
    'recent-imagery-panel',
    'global-context-panel',
  ]);
  tabs.destroy();
});

test('railJoinPath shrinks the fillet and corner to the room left, down to a shared edge', () => {
  const base = {
    panel: { x0: 0, y0: 0, x1: 330, y1: 160 },
    corner: 16,
    tabRadius: 10,
    fillet: 8,
  };
  const tight = railJoinPath({
    ...base,
    tab: { top: 60, bottom: 148, right: 372 },
  });
  assert.match(
    tight,
    /A 10 10 0 0 1 362 148 L 330 148 A 12 12 0 0 1 318 160 L 16 160 /,
    '12px below the tab: no fillet, a 12px corner',
  );
  const flush = railJoinPath({
    ...base,
    tab: { top: 60, bottom: 160, right: 372 },
  });
  assert.match(
    flush,
    /A 10 10 0 0 1 362 160 L 16 160 A 16 16 0 0 1 0 144 /,
    'a tab level with the panel bottom shares its bottom edge',
  );
  const chamfer = railJoinPath({
    ...base,
    panel: { x0: 0, y0: 0, x1: 312, y1: 160 },
    tab: { top: 4, bottom: 158, right: 372 },
    corner: 10,
    style: 'chamfer',
  });
  assert.match(
    chamfer,
    / L 312 10 L 372 10 L 372 150 L 312 150 L 312 150 L 302 160 /,
    "Cyber keeps the tab's edges between the chamfers",
  );
});

test('the stylesheet keeps phones on border-box, folds the strip into narrow desktops, keeps icon tabs square and whole without scrolling', () => {
  const css = readStylesheet(new URL('../../style.css', import.meta.url));
  assert.match(
    css,
    /body\.mobile-shell #right-context-rail \{[^}]*box-sizing: border-box;/,
  );
  assert.match(
    css,
    /@media \(min-width: 721px\) and \(max-width: 760px\) \{\s*#right-context-rail\[data-rail-tabs\] \{\s*width: calc\(330px - var\(--right-rail-tabs-inset\)\);/,
  );
  // The tabs keep their size: a square icon, never shrunk or rotated.
  assert.match(
    css,
    /\.right-rail-tab \{[^}]*flex: 0 0 auto;[^}]*width: var\(--right-rail-tabs-width\);\s*height: var\(--right-rail-tabs-width\);/,
  );
  assert.doesNotMatch(
    css,
    /\.right-rail-tab[^{]*\{[^}]*(writing-mode|mask-image)/,
  );
  // The column keeps its natural height: every tab stays whole, nothing
  // scrolls or clips; only the strip and the slot take the pointer.
  assert.doesNotMatch(
    css,
    /#right-rail-(column|tabs) \{[^}]*(max-height|overflow|scrollbar-width)/,
  );
  assert.match(css, /#right-rail-column \{[^}]*pointer-events: none;/);
  assert.match(css, /#right-rail-tabs \{[^}]*pointer-events: auto;/);
  assert.match(css, /#right-rail-tools \{[^}]*pointer-events: auto;/);
  assert.match(css, /--right-rail-panel-cover: min\(/);
  // The column hides on phones, where the Radio launcher is back in Context's
  // header; in the slot the launcher's popover opens upward and to the left.
  assert.match(
    css,
    /body\.mobile-shell #right-context-rail > #right-rail-column \{\s*display: none;/,
  );
  assert.doesNotMatch(
    css,
    /body\.mobile-shell #right-context-rail > #right-rail-tabs/,
  );
  assert.match(
    css,
    /#right-rail-tools \.context-radio-mini \{\s*top: auto;\s*right: calc\(100% \+ var\(--right-rail-tabs-gap\) \+ 6px\);\s*bottom: 0;/,
  );
  assert.match(css, /#right-rail-tools:empty \{\s*display: none;/);
  assert.match(
    css,
    /body:not\(\.mobile-shell\)\s*#right-context-rail\[data-rail-tabs\]\s*:is\(\s*\[data-collapse-target='pp-toggles'\],\s*\[data-collapse-target='cctv-panel'\],\s*\[data-collapse-target='street-level-panel'\],\s*\[data-collapse-target='global-context-panel'\],\s*\[data-collapse-target='weather-panel'\],\s*\[data-collapse-target='recent-imagery-panel'\]\s*\) \{\s*display: none;/,
    'the rail panels own collapse buttons are hidden on desktop, the Radio section keeps its own',
  );
});

test('destroy removes the column and stops listening', () => {
  const f = fixture();
  const tab = f.tabFor('cctv-panel');
  f.tabs.destroy();
  assert.equal(f.column.parentElement, null);
  assert.equal(f.rail.children.includes(f.column), false);
  assert.equal(f.rail.getAttribute('data-rail-tabs'), null);
  fire(tab, 'click');
  assert.deepEqual(f.calls, []);
  f.tabs.destroy();
});
