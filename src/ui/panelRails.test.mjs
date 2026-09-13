import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layoutLeftPanelRail,
  layoutRightPanelRail,
  measurePanelNaturalHeight,
} from './panelRails.js';

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
    matches: (selector) => selector === '[data-panel-id]',
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
