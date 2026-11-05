// src/cockpitSignalFocus.test.mjs — the Cockpit signal rows keep keyboard
// focus while they refresh and reorder, over happy-dom with the real view.
import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { formatAwarenessLabel } from './data/militaryAwarenessEngine.js';
import { createBriefState } from './ui/cockpitBriefPages.js';
import {
  handleSignalClick,
  publishCockpitSignals,
  pushCockpitSignal,
  updateCockpitSignals,
} from './ui/cockpitSignals.js';
import { useCockpitStore } from './ui/stores/cockpit.js';
import CockpitBriefing from './ui/views/panels/CockpitBriefing.vue';

/**
 * A browser blurs an element it removes or moves. happy-dom only models the
 * removal, so count both: any insert or removal of a node that holds focus
 * is a loss, and a moved node gives its focus up as a browser's would.
 */
function trackFocus(t) {
  const counts = { losses: 0, focusCalls: 0 };
  const holdsFocus = (node) =>
    node.isConnected && node.contains(document.activeElement);
  const insertBefore = Node.prototype.insertBefore;
  t.mock.method(Node.prototype, 'insertBefore', function (node, anchor) {
    const lost = holdsFocus(node);
    const result = insertBefore.call(this, node, anchor);
    if (lost) {
      counts.losses += 1;
      document.activeElement.blur();
    }
    return result;
  });
  const removeChild = Node.prototype.removeChild;
  t.mock.method(Node.prototype, 'removeChild', function (node) {
    if (holdsFocus(node)) counts.losses += 1;
    return removeChild.call(this, node);
  });
  const focus = HTMLElement.prototype.focus;
  t.mock.method(HTMLElement.prototype, 'focus', function (...args) {
    assert.ok(this.isConnected, 'a focus destination must still be connected');
    counts.focusCalls += 1;
    return focus.apply(this, args);
  });
  return counts;
}

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitBriefing).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  const button = () => {
    const element = document.createElement('button');
    element.type = 'button';
    return document.body.appendChild(element);
  };
  const display = button();
  const radio = button();
  const outside = button();
  const counts = trackFocus(t);
  t.after(() => app.unmount());
  const selected = [];
  // The signal presenters need only this much of the controller.
  const owner = {
    destroyed: false,
    brief: createBriefState(),
    signalItems: [],
    signalSignatures: new Map(),
    publishSignals: (rows) => store.publishSignals(rows),
    publishCockpitSignals,
    scheduleContextLayout() {},
    services: {
      formatAwarenessLabel,
      militaryAwarenessLayer: {
        focusTarget: (...args) => selected.push(args),
      },
    },
  };
  // The controller shows the card on entering Cockpit.
  document.getElementById('cockpit-signal-stream').hidden = false;
  const list = document.getElementById('cockpit-signal-list');
  list.addEventListener('click', (event) =>
    handleSignalClick.call(owner, event),
  );
  const buttons = () => [...list.querySelectorAll('button')];
  // Tab visits the enabled buttons no hidden ancestor removes from view.
  const tab = () => {
    const nodes = [...document.querySelectorAll('button')].filter(
      (node) => !node.disabled && !node.closest('[hidden]'),
    );
    nodes[(nodes.indexOf(document.activeElement) + 1) % nodes.length].focus();
  };
  const pageTab = (index) =>
    document.querySelector(`[data-cockpit-brief-index="${index}"]`);
  const signalTab = () => pageTab(0);
  return {
    owner,
    list,
    buttons,
    display,
    radio,
    outside,
    selected,
    tab,
    pageTab,
    signalTab,
    store,
    losses: () => counts.losses,
    focusCalls: () => counts.focusCalls,
  };
}

const item = (id, overrides = {}) => ({
  key: `flight:flights:${id}`,
  tone: 'nearby',
  title: `Flight ${id}`,
  detail: 'COMMERCIAL FLIGHT · 2 KM',
  target: { layerId: 'flights', id },
  timestamp: 1_700_000_000_000,
  ...overrides,
});
const render = async (f, items) => {
  f.owner.signalItems = items;
  publishCockpitSignals.call(f.owner);
  await nextTick();
};
const refresh = async (f, distanceM) => {
  updateCockpitSignals.call(f.owner, snapshot(distanceM), 0);
  await nextTick();
};
const snapshot = (distanceM = 2000) => ({
  evaluatedAt: 1_700_000_000_000,
  subject: { layerId: 'flights', id: 'current', label: 'CURRENT' },
  cohorts: [
    {
      id: 'flights',
      count: 1,
      nearest: [{ id: 'nearby', label: 'NEARBY', distanceM }],
    },
  ],
});

test('rows render the signals the controller presents', async (t) => {
  const f = fixture(t);
  await render(f, [
    item('a'),
    item('status', { tone: 'warning', target: null, title: 'UNKNOWN' }),
  ]);
  const [action, status] = f.list.children;
  assert.equal(action.className, 'nearby actionable');
  assert.equal(action.querySelector('time').textContent, '22:13:20Z');
  const button = action.querySelector('button.cockpit-signal-target');
  assert.equal(button.type, 'button');
  assert.equal(button.dataset.signalLayer, 'flights');
  assert.equal(button.dataset.signalId, 'a');
  assert.equal(button.getAttribute('aria-label'), 'Select flight Flight a');
  assert.equal(
    button.querySelector('.cockpit-signal-target-label').textContent,
    'Flight a',
  );
  assert.equal(
    button.querySelector('.cockpit-signal-target-chevron').textContent,
    'chevron_right',
  );
  assert.equal(
    action.querySelector('div > span').textContent,
    'COMMERCIAL FLIGHT · 2 KM',
  );
  assert.equal(status.className, 'warning');
  assert.equal(status.querySelector('div > strong').textContent, 'UNKNOWN');
  assert.equal(status.querySelector('button'), null);
});

test('actual Context refresh retains the focused signal button across unchanged and changed details', async (t) => {
  const f = fixture(t);
  await refresh(f);
  const target = f.buttons()[1];
  target.focus();
  const calls = f.focusCalls();
  for (let tick = 0; tick < 8; tick += 1) await refresh(f, 2500);
  assert.equal(f.buttons()[1] === target, true);
  assert.equal(document.activeElement === target, true);
  assert.equal(f.losses(), 0);
  assert.equal(
    f.focusCalls(),
    calls,
    'refresh must preserve focus without repeatedly restoring it',
  );
  assert.match(f.list.textContent, /2\.5\u00a0KM/);
});

test('signal content and accessible name update without replacing the active target', async (t) => {
  const f = fixture(t);
  await render(f, [item('a')]);
  const target = f.buttons()[0];
  target.focus();
  await render(f, [
    item('a', {
      title: 'RENAMED',
      tone: 'track',
      detail: 'CURRENT',
      timestamp: 1_700_000_001_000,
    }),
  ]);
  assert.equal(f.buttons()[0] === target, true);
  assert.equal(target.getAttribute('aria-label'), 'Select flight RENAMED');
  assert.match(target.textContent, /RENAMED/);
  assert.match(f.list.textContent, /CURRENT/);
  assert.equal(f.list.children[0].className, 'track actionable');
  assert.equal(document.activeElement === target, true);
  assert.equal(f.losses(), 0);
});

test('signal ranking changes move surrounding rows without disconnecting the focused row', async (t) => {
  const f = fixture(t);
  await render(
    f,
    ['a', 'b', 'c', 'd'].map((id) => item(id)),
  );
  const target = f.buttons()[1];
  target.focus();
  const calls = f.focusCalls();
  for (const order of [
    ['d', 'c', 'b', 'a'],
    ['b', 'c', 'd', 'a'],
    ['a', 'd', 'c', 'b'],
    ['c', 'a', 'b', 'd'],
    ['b', 'a', 'd', 'c'],
  ]) {
    await render(
      f,
      order.map((id) => item(id)),
    );
    assert.deepEqual(
      f.buttons().map((button) => button.dataset.signalId),
      order,
    );
    assert.equal(document.activeElement === target, true);
    assert.equal(f.losses(), 0);
  }
  assert.equal(f.focusCalls(), calls);
});

test('a new pushed signal preserves existing focus and delegated selection reads the current target', async (t) => {
  const f = fixture(t);
  await render(f, [item('a'), item('b')]);
  const target = f.buttons()[1];
  target.focus();
  pushCockpitSignal.call(
    f.owner,
    'status',
    'warning',
    'INPUT UNKNOWN',
    'SOURCE UNAVAILABLE',
  );
  await nextTick();
  assert.equal(f.list.children.length, 3);
  assert.equal(document.activeElement === target, true);
  assert.equal(f.losses(), 0);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.querySelector('.cockpit-signal-target-label').dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(f.selected, [['flights', 'b', { origin: 'user' }]]);
});

test('removing the focused identity uses the shown briefing tab once and permits forward traversal', async (t) => {
  const f = fixture(t);
  await render(f, [item('a'), item('b')]);
  const removed = f.buttons()[1];
  removed.focus();
  const calls = f.focusCalls();
  await render(f, [item('a')]);
  assert.equal(removed.isConnected, false);
  assert.equal(document.activeElement === f.signalTab(), true);
  assert.equal(f.focusCalls(), calls + 1);
  assert.equal(f.losses(), 0);
  assert.equal(f.signalTab().closest('[hidden]'), null);
  // Traversal carries on forward from the footer tab.
  f.tab();
  assert.equal(document.activeElement === f.pageTab(1), true);
  while (document.activeElement !== f.display) f.tab();
  await render(f, [item('a', { detail: 'UPDATED' })]);
  assert.equal(
    document.activeElement === f.display,
    true,
    'later refresh must not pull focus back',
  );
  f.tab();
  assert.equal(document.activeElement === f.radio, true);
});

test('a changed target cannot reuse a focused action for another flight', async (t) => {
  const f = fixture(t);
  await render(f, [item('a', { key: 'shared-status-key' })]);
  const removed = f.buttons()[0];
  removed.focus();
  await render(f, [
    item('b', {
      key: 'shared-status-key',
      target: { layerId: 'military', id: 'b' },
    }),
  ]);
  const target = f.buttons()[0];
  assert.equal(target === removed, false);
  assert.equal(removed.isConnected, false);
  assert.equal(document.activeElement === f.signalTab(), true);
  target.click();
  assert.deepEqual(f.selected, [['military', 'b', { origin: 'user' }]]);
});

test('empty, informational and duplicate-key rows have no stale or aliased actions', async (t) => {
  const f = fixture(t);
  await render(f, [item('a'), item('a')]);
  const [first, second] = f.buttons();
  assert.equal(first === second, false);
  second.focus();
  await render(f, [item('a'), item('a')]);
  const again = f.buttons();
  assert.equal(again[0] === first && again[1] === second, true);
  assert.equal(document.activeElement === second, true);
  await render(f, [item('status', { target: null, title: 'UNKNOWN' })]);
  assert.equal(f.buttons().length, 0);
  assert.match(f.list.textContent, /UNKNOWN/);
  assert.equal(document.activeElement === f.signalTab(), true);
  f.outside.focus();
  await render(f, []);
  assert.equal(f.list.children.length, 0);
  await render(f, [item('a')]);
  assert.equal(f.buttons()[0] === first, false);
  assert.equal(document.activeElement === f.outside, true);
  assert.equal(f.losses(), 0);
});

test('any reordering of five rows keeps focus wherever it sits', async (t) => {
  const f = fixture(t);
  const ids = ['a', 'b', 'c', 'd', 'e'];
  // A fixed pseudo-random sequence, so a failure reproduces.
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const shuffle = (list) => {
    const next = [...list];
    for (let index = next.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [next[index], next[swap]] = [next[swap], next[index]];
    }
    return next;
  };
  await render(
    f,
    ids.map((id) => item(id)),
  );
  for (let round = 0; round < 60; round += 1) {
    const target = f.buttons()[round % ids.length];
    target.focus();
    const order = shuffle(ids);
    await render(
      f,
      order.map((id) => item(id)),
    );
    assert.deepEqual(
      f.buttons().map((button) => button.dataset.signalId),
      order,
    );
    assert.equal(document.activeElement === target, true);
  }
  assert.equal(f.losses(), 0);
});

test('the fallback follows the shown page, and the collapse toggle without tabs', async (t) => {
  const f = fixture(t);
  f.store.publishBrief({ ...createBriefState(), pageIndex: 2 });
  await render(f, [item('a'), item('b')]);
  f.buttons()[1].focus();
  await render(f, [item('a')]);
  assert.equal(document.activeElement === f.pageTab(2), true);
  for (const index of [0, 1, 2]) f.pageTab(index).remove();
  f.buttons()[0].focus();
  await render(f, []);
  assert.equal(
    document.activeElement === document.getElementById('cockpit-signal-toggle'),
    true,
  );
});
