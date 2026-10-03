import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { displayPanelScroller } from './displayPanelScroll.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layoutLeftPanelRail,
  layoutRightPanelRail,
  measurePanelNaturalHeight,
} from './panelRails.js';

test('Display uses an inner scroll body only in Cyber', () => {
  const body = { scrollTop: 95 };
  const panel = {
    ownerDocument: { documentElement: { dataset: { uiTheme: 'cyber' } } },
    querySelector: () => body,
  };
  assert.equal(displayPanelScroller(panel), body);
  panel.ownerDocument.documentElement.dataset.uiTheme = 'tactical';
  assert.equal(displayPanelScroller(panel), panel);
  assert.equal(displayPanelScroller(null), null);
});

test('Cyber restores one expanded owner, keeps launchers, and restores other theme preferences', () => {
  for (const mobile of [false, true]) {
    const f = fixture('right', {
      mobile,
      hud: { visible: true, variant: 'cyber' },
    });
    f.expand(f.first, 250);
    f.expand(f.second, 250);
    f.options.preferredPanelId = f.second.id;
    f.run();
    assert.equal(f.first.classList.contains('cyber-accordion-collapsed'), true);
    assert.equal(f.second.classList.contains('collapsed'), false);
    assert.equal(f.first.getAttribute('aria-hidden'), undefined);
    f.run();
    assert.equal(
      f.first.classList.contains('collapsed'),
      true,
      'layout does not reopen a peer',
    );
    f.options.hud.variant = 'operator';
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(
      f.first.classList.contains('cyber-accordion-collapsed'),
      false,
    );
    assert.equal(f.second.classList.contains('collapsed'), false);
  }
});

test('Cyber restored accordion prefers keyboard focus when no explicit owner exists', () => {
  const f = fixture('right', { hud: { visible: true, variant: 'cyber' } });
  f.expand(f.first, 250);
  f.expand(f.second, 250);
  f.options.documentRef.activeElement = f.second;
  f.run();
  assert.equal(f.first.classList.contains('collapsed'), true);
  assert.equal(f.second.classList.contains('collapsed'), false);
});

function element(
  id,
  { height = 42, top = 234, left = 20, width = 272, collapsed = false } = {},
) {
  const classes = new Set(collapsed ? ['collapsed'] : []);
  const properties = new Map();
  const attributes = new Map();
  const writes = [];
  const node = {
    id,
    children: [],
    dataset: {},
    parentElement: null,
    scrollHeight: height,
    clientHeight: height,
    scrollTop: 0,
    computed: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      rowGap: '12px',
    },
    rect: {
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    },
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        writes.push(['set', name, value]);
        properties.set(name, value);
      },
      getPropertyValue: (name) => properties.get(name) || '',
      removeProperty(name) {
        writes.push(['remove', name]);
        properties.delete(name);
      },
    },
    getBoundingClientRect() {
      return this.rect;
    },
    matches: (selector) =>
      selector === '[data-panel-id]' ||
      (selector === '[data-panel-id]:not(.panel-floating)' &&
        !classes.has('panel-floating')),
    contains(target) {
      return (
        target === this || this.children.some((child) => child.contains(target))
      );
    },
    querySelectorAll() {
      return this.children;
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name),
    writes,
  };
  return node;
}
function fixture(
  side,
  { mobile = false, hud = { visible: true, variant: 'tactical' } } = {},
) {
  const first = element('first', { height: 42, collapsed: true });
  const second = element('second', { height: 42, collapsed: true });
  const stack = element('rail', {
    height: 96,
    left: side === 'left' ? 20 : 1100,
  });
  stack.children = [first, second];
  first.parentElement = second.parentElement = stack;
  const documentRef = { activeElement: null };
  stack.ownerDocument = documentRef;
  const collapsed = [];
  let retries = 0,
    aligned = 0;
  const options = {
    stack,
    hud,
    documentRef,
    obstacles: [],
    collapsedHeights: new Map(),
    windowRef: {
      innerHeight: 900,
      matchMedia: () => ({ matches: mobile }),
      getComputedStyle: (node) => node.computed,
    },
    onCollapse: (panel) => collapsed.push(panel.id),
    onRetry: () => {
      retries += 1;
    },
    onAligned: () => {
      aligned += 1;
    },
    displayPanel: null,
    readDisplayScrollTop: () => 0,
    leftStack: element('left'),
  };
  const run = () =>
    (side === 'left' ? layoutLeftPanelRail : layoutRightPanelRail)(options);
  const expand = (panel, height) => {
    panel.classList.remove('collapsed');
    panel.scrollHeight = height;
    panel.rect.height = height;
    panel.rect.bottom = panel.rect.top + height;
  };
  return {
    options,
    first,
    second,
    stack,
    run,
    expand,
    collapsed,
    retries: () => retries,
    aligned: () => aligned,
  };
}

test('missing rails are inert without browser globals', () => {
  layoutLeftPanelRail({});
  layoutRightPanelRail({});
});

test('left layout records collapsed heights and aligns the right rail without changing disclosure', () => {
  const f = fixture('left');
  f.run();
  assert.equal(f.options.collapsedHeights.get('first'), 42);
  assert.equal(f.first.classList.contains('collapsed'), true);
  assert.equal(f.aligned(), 1);
  assert.equal(f.retries(), 0);
  assert.equal(f.stack.dataset.layoutMode, 'normal');
});

test('left corridor respects a lower obstacle but ignores an obstacle hidden by its parent', () => {
  const f = fixture('left');
  const blocker = element('blocker', { top: 600, height: 80 });
  const hidden = element('hidden', { top: 300, height: 80 });
  hidden.parentElement = element('hidden-parent');
  hidden.parentElement.computed.opacity = '0';
  f.options.obstacles = [blocker, hidden];
  f.run();
  assert.equal(Number(f.stack.dataset.safeBottomPct), 65.47);
});

for (const side of ['left', 'right']) {
  test(`${side} mobile layout releases desktop height/position styles and labels`, () => {
    const f = fixture(side, { mobile: true });
    f.stack.classList.add('layout-focus');
    f.stack.style.setProperty(`--${side}-stack-safe-top`, '300px');
    f.first.style.setProperty(`--${side}-panel-allocated-height`, '99px');
    f.first.setAttribute('aria-hidden', 'true');
    f.run();
    assert.equal(f.stack.dataset.layoutMode, 'mobile');
    assert.equal(
      f.stack.style.getPropertyValue(`--${side}-stack-safe-top`),
      '',
    );
    assert.equal(
      f.first.style.getPropertyValue(`--${side}-panel-allocated-height`),
      '',
    );
    assert.equal(f.first.getAttribute('aria-hidden'), undefined);
  });
  test(`${side} constrained layout preserves the preferred panel and requests another pass`, () => {
    const f = fixture(side);
    f.expand(f.first, 900);
    f.expand(f.second, 900);
    f.options.preferredPanelId = 'second';
    f.run();
    assert.equal(f.second.classList.contains('collapsed'), false);
    assert.equal(f.first.classList.contains('layout-auto-collapsed'), true);
    assert.deepEqual(f.collapsed, ['first']);
    assert.equal(f.retries(), 1);
  });
  test(`${side} hidden HUD restores automatic collapse without altering manual collapse`, () => {
    const f = fixture(side, { hud: { visible: false, variant: 'tactical' } });
    f.first.classList.add('layout-auto-collapsed');
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), true);
    assert.deepEqual(f.collapsed, ['first']);
  });
}

test('right layout uses keyboard focus when there is no preferred panel', () => {
  const f = fixture('right');
  f.expand(f.first, 900);
  f.expand(f.second, 900);
  f.options.documentRef.activeElement = f.second;
  f.run();
  assert.equal(f.first.classList.contains('layout-auto-collapsed'), true);
  assert.equal(f.second.classList.contains('collapsed'), false);
});

for (const collapsed of [true, false]) {
  test(`right layout ignores a hidden ${collapsed ? 'collapsed' : 'expanded'} panel`, () => {
    const baseline = fixture('right');
    baseline.stack.children = [baseline.first];
    baseline.expand(baseline.first, 600);
    baseline.run();

    const f = fixture('right');
    f.expand(f.first, 600);
    f.second.id = 'weather-panel';
    f.second.hidden = true;
    if (!collapsed) f.expand(f.second, 900);
    f.options.preferredPanelId = 'weather-panel';
    f.run();

    assert.deepEqual(f.stack.dataset, baseline.stack.dataset);
    assert.equal(
      f.first.style.getPropertyValue('--right-panel-allocated-height'),
      baseline.first.style.getPropertyValue('--right-panel-allocated-height'),
    );
    assert.equal(f.second.classList.contains('collapsed'), collapsed);
    assert.deepEqual(f.second.writes, []);
    assert.deepEqual(f.collapsed, []);
    assert.equal(f.retries(), 0);
    assert.equal(f.stack.classList.contains('layout-focus'), false);
  });
}

test('right layout retains Display allocation during measurement and caps restored scroll', () => {
  const f = fixture('right');
  f.first.id = 'pp-toggles';
  f.expand(f.first, 900);
  f.first.clientHeight = 400;
  f.options.displayPanel = f.first;
  f.options.readDisplayScrollTop = () => 800;
  f.first.style.setProperty('--right-panel-allocated-height', '600px');
  f.first.writes.length = 0;
  f.run();
  assert.equal(f.first.scrollTop, 500);
  assert.equal(
    f.first.writes.some(
      ([op, name]) =>
        op === 'remove' && name === '--right-panel-allocated-height',
    ),
    false,
  );
  f.first.writes.length = 0;
  f.run();
  assert.equal(
    f.first.writes.some(
      ([, name]) => name === '--right-panel-allocated-height',
    ),
    false,
    'stable allocation must not churn the style attribute',
  );
});

test('right rail neither measures nor allocates a panel floating out of it', () => {
  const f = fixture('right');
  f.expand(f.first, 900);
  f.expand(f.second, 300);
  f.first.classList.add('panel-floating');
  f.first.style.setProperty('--right-panel-allocated-height', '500px');
  f.first.writes.length = 0;
  f.run();
  assert.equal(f.stack.dataset.expandedCount, '1');
  assert.deepEqual(
    f.first.writes,
    [],
    'a floating panel keeps whatever inline style it left the rail with',
  );
  assert.equal(f.first.getAttribute('aria-hidden'), undefined);
  assert.equal(f.first.classList.contains('layout-auto-collapsed'), false);
  assert.ok(
    f.second.style.getPropertyValue('--right-panel-allocated-height'),
    'the docked panel still receives its allocation',
  );
});

test('right rail aligns to the current left rail and excludes hidden obstacles', () => {
  const f = fixture('right');
  f.options.leftStack.rect.top = 200;
  const hidden = element('hidden', { left: 1100, top: 100, height: 200 });
  hidden.computed.display = 'none';
  f.options.obstacles = [hidden];
  f.run();
  assert.equal(f.stack.dataset.safeTop, '200.0');
});

test('natural height includes visible content, margins and wrapper chrome, excluding hidden rows', () => {
  const panel = element('panel');
  const inner = element('inner', { top: 100 });
  inner.computed.paddingTop = '10px';
  inner.computed.paddingBottom = '5px';
  const row = element('row', { top: 110, height: 40 });
  row.scrollHeight = 80;
  row.computed.marginBottom = '3px';
  const hidden = element('hidden', { top: 1000, height: 900 });
  hidden.computed.visibility = 'hidden';
  panel.computed.borderTopWidth = '1px';
  panel.computed.borderBottomWidth = '1px';
  panel.children = [inner];
  inner.children = [row, hidden];
  assert.equal(
    measurePanelNaturalHeight(panel, (node) => node.computed),
    100,
  );
});

// Reproduce the allocation-dependent readings seen beside the weather card.
// Outside measurement, CCTV is 391 px in focus and 629 px in normal mode;
// Removing only the allocation leaves focus CSS active: its next reading is
// 422 px, so the old decision exits focus and then re-enters on the 629 px read.
function thrashingRightRail({ focused = false, weatherOpen = false } = {}) {
  const f = fixture('right');
  f.options.windowRef.innerHeight = 920;
  f.options.leftStack.rect.top = 439.6;
  f.stack.computed.rowGap = '8px';
  const display = element('pp-toggles', { collapsed: true });
  const cctv = element('cctv-panel', { height: 629 });
  const weather = element('weather-panel', {
    height: 444,
    collapsed: !weatherOpen,
  });
  const context = element('global-context-panel', { collapsed: true });
  if (!weatherOpen) weather.classList.add('layout-auto-collapsed');
  f.stack.children = [display, cctv, weather, context];
  f.stack.classList.toggle('layout-focus', focused);
  f.options.preferredPanelId = cctv.id;
  f.options.displayPanel = display;
  const allocation = '--right-panel-allocated-height';
  const measuring = () =>
    f.stack.getAttribute('data-rail-measuring') !== undefined;
  for (const panel of f.stack.children) {
    panel.parentElement = f.stack;
    panel.intrinsicHeight = panel.rect.height;
    panel.style.setProperty(allocation, '391px');
    panel.getBoundingClientRect = () => {
      let height;
      if (panel.classList.contains('collapsed')) {
        height =
          measuring() || f.stack.classList.contains('layout-focus') ? 44 : 0;
      } else if (measuring()) {
        height = panel.intrinsicHeight;
      } else if (f.stack.classList.contains('layout-focus')) {
        height = 391;
      } else {
        height = panel.intrinsicHeight;
      }
      return { ...panel.rect, height, bottom: panel.rect.top + height };
    };
    Object.defineProperty(panel, 'scrollHeight', {
      get: () => {
        if (measuring())
          return panel.classList.contains('collapsed')
            ? 44
            : panel.intrinsicHeight;
        if (panel.classList.contains('collapsed'))
          return panel.getBoundingClientRect().height;
        return f.stack.classList.contains('layout-focus') &&
          panel.style.getPropertyValue(allocation)
          ? 603
          : 422;
      },
    });
  }
  return { ...f, cctv, weather };
}

for (const focused of [false, true]) {
  test(`right rail settles mode-dependent CCTV and weather heights within two passes from ${focused ? 'focus' : 'normal'}`, () => {
    const f = thrashingRightRail({ focused });
    assert.equal(f.cctv.getBoundingClientRect().height, focused ? 391 : 629);
    assert.equal(f.weather.getBoundingClientRect().height, focused ? 44 : 0);
    const modes = [];
    const needs = [];
    for (let pass = 0; pass < 10; pass++) {
      f.run();
      modes.push(f.stack.classList.contains('layout-focus'));
      needs.push(f.stack.dataset.requiredHeight);
      assert.equal(f.stack.dataset.availableHeight, '443.6');
      assert.equal(f.stack.getAttribute('data-rail-measuring'), undefined);
    }
    assert.deepEqual(modes.slice(1), Array(9).fill(true));
    assert.deepEqual(needs, Array(10).fill('681.0'));
    assert.equal(f.retries(), 0);
    assert.equal(f.cctv.writes.filter(([op]) => op === 'remove').length, 0);
  });
}

test('right rail keeps focus through 30 px content growth inside the hysteresis band', () => {
  const f = thrashingRightRail();
  f.run();
  // Header + gap contribute 52 px: need moves 420 -> 450 -> 420.
  for (const height of [368, 398, 368, 398, 368]) {
    f.cctv.intrinsicHeight = height;
    f.run();
    assert.equal(f.stack.classList.contains('layout-focus'), true);
  }
  f.cctv.intrinsicHeight = 335; // Need 387 < 443.6 - 55.2.
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
  f.cctv.intrinsicHeight = 365;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
});

test('right rail enters focus only above available height and leaves below the full deadband', () => {
  const f = thrashingRightRail();
  f.options.windowRef.innerHeight = 1000;
  f.options.leftStack.rect.top = 500;
  f.cctv.intrinsicHeight = 408; // Need equals available (460 px).
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
  f.cctv.intrinsicHeight = 409;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), true);
  f.cctv.intrinsicHeight = 348; // Need equals the 400 px exit boundary.
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), true);
  f.cctv.intrinsicHeight = 347;
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), false);
});

test('right rail auto-collapse requests only one retry and settles within two passes', () => {
  const f = thrashingRightRail({ weatherOpen: true });
  const modes = [];
  for (let pass = 0; pass < 10; pass++) {
    f.run();
    modes.push(f.stack.classList.contains('layout-focus'));
  }
  assert.deepEqual(f.collapsed, ['weather-panel']);
  assert.equal(f.retries(), 1);
  assert.deepEqual(modes.slice(1), Array(9).fill(true));
});

test('right rail retry cannot enqueue another retry even if disclosure changes before it runs', () => {
  const f = thrashingRightRail({ weatherOpen: true });
  f.run();
  assert.equal(f.retries(), 1);
  f.weather.classList.remove('collapsed', 'layout-auto-collapsed');
  f.run();
  assert.equal(f.retries(), 1);
  assert.equal(f.stack.dataset.layoutMode, 'focus');
});

test('right rail restores presentation even when intrinsic measurement throws', () => {
  const f = thrashingRightRail();
  f.cctv.getBoundingClientRect = () => {
    throw new Error('measurement failed');
  };
  assert.throws(() => f.run(), /measurement failed/);
  assert.equal(f.stack.getAttribute('data-rail-measuring'), undefined);
});

test('right rail measuring pass keeps an opted-in scroller position', () => {
  const f = fixture('right');
  f.expand(f.first, 300);
  let scrollTop = 240;
  let writes = 0;
  let clamp = true;
  const body = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      writes++;
      scrollTop = value;
    },
  };
  f.stack.querySelectorAll = (selector) =>
    selector === '[data-rail-scroller]' ? [body] : [];
  const setAttribute = f.stack.setAttribute;
  f.stack.setAttribute = (name, value) => {
    setAttribute(name, value);
    // The lifted max-height removes the overflow and clamps the offset.
    if (clamp && name === 'data-rail-measuring') scrollTop = 0;
  };
  f.run();
  assert.equal(scrollTop, 240);
  assert.equal(writes, 1);
  clamp = false;
  f.run();
  assert.equal(writes, 1, 'an unclamped offset is not rewritten');
});

for (const variant of ['minimal', 'full']) {
  test(`right rail does not retry collapse that the ${variant} HUD immediately restores`, () => {
    const f = fixture('right', { hud: { visible: true, variant } });
    f.expand(f.first, 900);
    f.expand(f.second, 900);
    for (let pass = 0; pass < 10; pass++) f.run();
    assert.equal(f.retries(), 0);
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), false);
  });
}
// ── Narrow-screen rail overflow pin ──────────────────────────────────────────
// At ≤720px both panel stacks become scroll containers (overflow-y: auto),
// which also makes their overflow-x compute to auto. Each panel's decorative
// .panel-glow is absolutely positioned with a negative inset, so inside a
// scroll container that overhang is no longer harmless paint: it becomes
// 18–20px of scrollable overflow on both axes, drawing a horizontal scrollbar
// band under the expanded CCTV/Context/Data panel plus a vertical scrollbar
// that scrolls nothing but glow. The narrow block therefore pins every hosted
// glow to its panel box.

/** Strip comments and return the bodies of every ≤720px media block. */
function narrowScreenBlocks(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media (max-width: 720px) {', from);
    if (start === -1) break;
    const open = source.indexOf('{', start);
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}' && (depth -= 1) === 0) {
        close = index;
        break;
      }
    }
    assert.notEqual(close, -1, 'unterminated narrow-screen media block');
    blocks.push(source.slice(open + 1, close));
    from = close + 1;
  }
  assert.ok(blocks.length, 'narrow-screen media block is missing');
  return blocks;
}

/** Split a flat (non-nested) rule list into [selectors, declarations] pairs. */
function flatRules(block) {
  assert.doesNotMatch(block, /@media/, 'nested media queries are not modelled');
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selectors, declarations]) => [
      selectors.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
      declarations,
    ],
  );
}

test('narrow-screen rails pin every hosted panel glow inside its panel box', () => {
  const css = readStylesheet(new URL('../../style.css', import.meta.url));
  for (const panel of [
    'data-panel',
    'scene-panel',
    'cctv-panel',
    'global-context-panel',
  ]) {
    assert.match(
      css,
      new RegExp(`#${panel} \\.panel-glow \\{[^}]*\\binset: -\\d+px;`),
      `${panel} glow no longer overhangs its panel; revisit this pin`,
    );
  }
  const narrow = narrowScreenBlocks(css).flatMap(flatRules);
  const scrollingRails = [
    ...new Set(
      narrow
        .filter(([, declarations]) =>
          /\boverflow(?:-y)?:\s*(?:auto|scroll)\b/.test(declarations),
        )
        .flatMap(([selectors]) => selectors)
        .filter((selector) =>
          /^#(?:left-panel-stack|right-context-rail)$/.test(selector),
        ),
    ),
  ].sort();
  assert.deepEqual(scrollingRails, [
    '#left-panel-stack',
    '#right-context-rail',
  ]);
  for (const rail of scrollingRails) {
    assert.ok(
      narrow.some(
        ([selectors, declarations]) =>
          selectors.includes(`${rail} .panel-glow`) &&
          /(?:^|;)\s*inset:\s*0\s*;/.test(declarations),
      ),
      `${rail} scrolls at ≤720px but does not pin its panel glows (inset: 0)`,
    );
  }
});

test('right layout ignores a hidden panel: no lane, no gap, no auto-collapse', () => {
  const f = fixture('right');
  const imagery = element('recent-imagery-panel', { height: 0 });
  imagery.hidden = true;
  imagery.scrollHeight = 0;
  imagery.rect.height = 0;
  f.stack.children.push(imagery);
  imagery.parentElement = f.stack;
  // A tall panel expands into focus mode: the hidden sibling is not among the
  // later panels that focus mode collapses, and it counts for nothing.
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'focus');
  assert.equal(imagery.classList.contains('collapsed'), false);
  assert.equal(imagery.classList.contains('layout-auto-collapsed'), false);
  assert.equal(f.stack.dataset.expandedCount, '1');
  assert.equal(
    imagery.style.getPropertyValue('--right-panel-allocated-height'),
    '',
  );
  assert.equal(imagery.getAttribute('aria-hidden'), undefined);
  const alone = parseFloat(
    f.first.style.getPropertyValue('--right-panel-allocated-height'),
  );
  // Shown (and expanded) it joins the allocation like any other panel.
  imagery.hidden = false;
  imagery.scrollHeight = 300;
  imagery.rect.height = 300;
  const retriesBefore = f.retries();
  f.run();
  assert.ok(
    f.collapsed.includes('recent-imagery-panel'),
    'focus mode collapses the later panel and asks for another pass',
  );
  assert.equal(f.retries(), retriesBefore + 1);
  f.run();
  assert.equal(f.stack.dataset.expandedCount, '1');
  assert.ok(
    parseFloat(
      f.first.style.getPropertyValue('--right-panel-allocated-height'),
    ) <= alone,
  );
});
