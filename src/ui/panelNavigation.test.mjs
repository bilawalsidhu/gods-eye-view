import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { installVueDom } from '../testSupport/vueDom.mjs';

let PanelNavigation;
let createUiRuntime;
let nextTick;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ nextTick } = await import('vue'));
  ({ PanelNavigation } = await import('./panelNavigation.js'));
  ({ createUiRuntime } = await import('./vueRuntime.js'));
});
after(() => uninstall());

function panel(id, { collapsed = true, hidden = false, title = '' } = {}) {
  const element = document.createElement('div');
  element.id = id;
  element.dataset.panelId = id;
  element.className = collapsed
    ? 'panel-collapsible collapsed'
    : 'panel-collapsible';
  // Data Layers shows only while `active` (the `f` shortcut toggles it).
  if (id === 'data-panel') element.classList.add('active');
  element.hidden = hidden;
  if (title) element.innerHTML = `<span class="panel-title">${title}</span>`;
  return element;
}

function setup() {
  document.body.innerHTML = '';
  const left = document.createElement('div');
  left.id = 'left-panel-stack';
  left.append(panel('data-panel', { collapsed: false }), panel('scene-panel'));
  const right = document.createElement('div');
  right.id = 'right-context-rail';
  right.append(
    panel('pp-toggles'),
    panel('weather-panel', { hidden: true }),
    panel('global-context-panel'),
    panel('host-panel', { title: 'HOST' }),
  );
  document.body.append(left, right);
  const calls = [];
  const ui = createUiRuntime();
  const navigation = new PanelNavigation({
    ui,
    stacks: { left, right },
    setPanelCollapsed: (...args) => calls.push(args),
  });
  navigation.init();
  return { left, right, calls, ui, navigation };
}

const railItems = (stack) =>
  [...stack.querySelectorAll('.gev-panel-rail [data-rail-item]')].map(
    (button) => [button.dataset.railItem, button.getAttribute('aria-pressed')],
  );

test('each stack gets a rail of its offered panels, marking the open one', async () => {
  const { left, right, ui, navigation } = setup();
  await nextTick();
  assert.equal(
    left.firstElementChild.className,
    'gev-panel-rail gev-panel-rail--left',
  );
  assert.deepEqual(railItems(left), [
    ['data-panel', 'true'],
    ['scene-panel', 'false'],
  ]);
  // Hidden panels are not offered; a host's panel gets a generic item.
  assert.deepEqual(railItems(right), [
    ['pp-toggles', 'false'],
    ['global-context-panel', 'false'],
    ['host-panel', 'false'],
  ]);
  assert.equal(
    right
      .querySelector('[data-rail-item="host-panel"]')
      .getAttribute('aria-label'),
    'HOST',
  );
  assert.equal(
    left.querySelector('nav').getAttribute('aria-label'),
    'Left panels',
  );
  navigation.destroy();
  ui.destroy();
});

test('selecting an item toggles its panel explicitly', async () => {
  const { left, calls, ui, navigation } = setup();
  await nextTick();
  left.querySelector('[data-rail-item="scene-panel"]').click();
  left.querySelector('[data-rail-item="data-panel"]').click();
  assert.deepEqual(calls, [
    ['scene-panel', false, { explicit: true }],
    ['data-panel', true, { explicit: true }],
  ]);
  navigation.destroy();
  ui.destroy();
});

test('Minimal offers tools through dropdowns and marks the selected inspector', async () => {
  const { useHudStore } = await import('./stores/hud.js');
  const { left, right, calls, ui, navigation } = setup();
  const hud = useHudStore(ui.pinia);
  hud.publish({ variant: 'minimal' });
  document.getElementById('data-panel').classList.add('collapsed');
  document.getElementById('pp-toggles').classList.remove('collapsed');
  navigation.sync();
  await nextTick();
  assert.equal(left.querySelector('.ui-rail'), null);
  left
    .querySelector('[data-minimal-tools-trigger]')
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const minimalItems = [
    ...left.querySelectorAll('[data-rail-item]'),
    ...document.querySelectorAll('#minimal-tools-menu [data-rail-item]'),
  ].map((button) => [
    button.dataset.railItem,
    button.getAttribute('aria-pressed'),
  ]);
  assert.deepEqual(minimalItems, [
    ['data-panel', 'false'],
    ['scene-panel', 'false'],
    ['pp-toggles', 'true'],
    ['global-context-panel', 'false'],
    ['host-panel', 'false'],
  ]);
  document
    .querySelector('#minimal-tools-menu [data-rail-item="pp-toggles"]')
    .click();
  assert.deepEqual(calls.at(-1), ['pp-toggles', true, { explicit: true }]);
  hud.publish({ variant: 'tactical' });
  await nextTick();
  assert.equal(railItems(left).length, 2);
  assert.equal(railItems(right).length, 3);
  navigation.destroy();
  ui.destroy();
});

test('Minimal folds restored extra inspectors without persisting the presentation', () => {
  const { calls, ui, navigation } = setup();
  document.getElementById('pp-toggles').classList.remove('collapsed');
  document.documentElement.dataset.uiTheme = 'minimal';
  try {
    navigation.sync();
    assert.deepEqual(calls, [
      [
        'data-panel',
        true,
        {
          restore: true,
          persist: false,
          syncShare: false,
        },
      ],
    ]);
  } finally {
    delete document.documentElement.dataset.uiTheme;
    navigation.destroy();
    ui.destroy();
  }
});

test('Minimal time dropdown seeks real coverage and returns to live', async () => {
  const { worldClock } = await import('../time/worldClock.js');
  const { useHudStore } = await import('./stores/hud.js');
  const { left, ui, navigation } = setup();
  const id = 'minimal-time-test';
  const start = worldClock.wallNow() - 30 * 60_000;
  const off = worldClock.register({
    id,
    coverage: () => ({ start, end: start + 30 * 60_000 }),
  });
  try {
    useHudStore(ui.pinia).publish({ variant: 'minimal' });
    await nextTick();
    const select = left.querySelector('#minimal-time-select');
    async function open() {
      select.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const option = (text) =>
      [...document.querySelectorAll('[data-slot="select-item"]')].find(
        (item) => item.textContent.trim() === text,
      );
    await open();
    assert.equal(option('1 hour ago').getAttribute('aria-disabled'), 'true');
    select.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    worldClock.follow(id);
    await nextTick();
    if (!option('1 hour ago')) await open();
    assert.notEqual(option('1 hour ago').getAttribute('aria-disabled'), 'true');
    option('1 hour ago').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(worldClock.isLive(), false);
    assert.equal(worldClock.now(), start);
    await open();
    option('Live').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(worldClock.isLive(), true);
  } finally {
    worldClock.goLive();
    worldClock.follow(id, false);
    off();
    navigation.destroy();
    ui.destroy();
  }
});

test('Minimal dismisses its open panel on a map click and cleans up the listener', () => {
  const { calls, ui, navigation } = setup();
  document.documentElement.dataset.uiTheme = 'minimal';
  const map = document.createElement('canvas');
  map.id = 'cesiumContainer';
  document.body.append(map);
  try {
    map.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    assert.deepEqual(calls, [['data-panel', true, { explicit: true }]]);
    navigation.destroy();
    map.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    assert.equal(calls.length, 1);
  } finally {
    delete document.documentElement.dataset.uiTheme;
    navigation.destroy();
    ui.destroy();
  }
});

test('selecting right after a same-task collapse reads the panel, not the store', async () => {
  const { left, calls, ui, navigation } = setup();
  await nextTick();
  // A host collapses Data Layers and selects its item in one task, before
  // the store follows the class change.
  left.querySelector('#data-panel').classList.add('collapsed');
  navigation.select('data-panel');
  assert.deepEqual(calls, [['data-panel', false, { explicit: true }]]);
  navigation.destroy();
  ui.destroy();
});

test('the rails follow disclosure and availability changes', async () => {
  const { left, right, ui, navigation } = setup();
  document.getElementById('data-panel').classList.add('collapsed');
  document.getElementById('scene-panel').classList.remove('collapsed');
  document.getElementById('weather-panel').hidden = false;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.deepEqual(railItems(left), [
    ['data-panel', 'false'],
    ['scene-panel', 'true'],
  ]);
  assert.deepEqual(railItems(right), [
    ['pp-toggles', 'false'],
    ['weather-panel', 'false'],
    ['global-context-panel', 'false'],
    ['host-panel', 'false'],
  ]);
  // `f` hides Data Layers outright, so the rail stops offering it.
  document.getElementById('data-panel').classList.remove('active');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.deepEqual(railItems(left), [['scene-panel', 'true']]);
  navigation.destroy();
  ui.destroy();
});

test('destroy removes the rails and stops following the stacks', async () => {
  const { left, right, calls, ui, navigation } = setup();
  navigation.destroy();
  navigation.destroy();
  assertSameNode(left.querySelector('.gev-panel-rail'), null);
  assertSameNode(right.querySelector('.gev-panel-rail'), null);
  navigation.select('data-panel');
  assert.deepEqual(calls, []);
  ui.destroy();
});
