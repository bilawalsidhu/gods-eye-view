// src/ui/statusChipsView.test.mjs — the split-flap label and the scene's
// status chips, rendered from the status store over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, ref } from 'vue';
import { createPinia } from 'pinia';
import { FLAP_SETTLE_SLACK_MS, planSplitFlap } from '../splitFlap.js';
import { useStatusStore } from './stores/status.js';
import SceneChromeView from './views/SceneChromeView.vue';
import SplitFlapText from './views/panels/SplitFlapText.vue';

// happy-dom lays nothing out: the label counts as on screen unless a test
// says otherwise, and is wider while its cells stand in for the text.
let onScreen = true;
HTMLElement.prototype.checkVisibility = function () {
  return onScreen && !this.closest('[hidden]');
};
HTMLElement.prototype.getBoundingClientRect = function () {
  const width = this.querySelector('.gev-flap-cell') ? 80 : 50;
  return { width, height: 10, left: 0, top: 0, right: width, bottom: 10 };
};

// A change renders, then its cells go in once the label is seen on screen.
const rendered = async () => {
  for (let flush = 0; flush < 4; flush += 1) await nextTick();
};

function mountLabel(t, initial = 'LOADING LIVE DATA') {
  onScreen = true;
  document.body.replaceChildren();
  const text = ref(initial);
  const immediate = ref(false);
  const app = createApp({
    render: () =>
      h(SplitFlapText, {
        id: 'label',
        text: text.value,
        immediate: immediate.value,
      }),
  });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const label = document.getElementById('label');
  return {
    text,
    immediate,
    label,
    node: () => label.querySelector('.gev-flap-text').firstChild,
    cells: () => [...label.querySelectorAll('.gev-flap-cell')],
  };
}

test('the label is one text node beside empty decorative cells', (t) => {
  const { label, node, cells } = mountLabel(t);
  assert.equal(label.className, 'gev-flap-host');
  assert.equal(node().nodeType, Node.TEXT_NODE);
  assert.equal(node().data, 'LOADING LIVE DATA');
  assert.equal(label.textContent, 'LOADING LIVE DATA');
  assert.equal(
    label.querySelector('.gev-flap-cells').getAttribute('aria-hidden'),
    'true',
  );
  assert.equal(cells().length, 0);
});

test('a change flaps its changed columns over the same text node, then settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { text, label, node, cells } = mountLabel(t);
  const permanent = node();
  text.value = 'LOAD COMPLETE';
  await rendered();
  assert.ok(node() === permanent, 'the text node never moves');
  assert.equal(permanent.data, 'LOAD COMPLETE');
  assert.equal(label.textContent, 'LOAD COMPLETE', 'cells carry no text');
  assert.equal(label.classList.contains('gev-flap-active'), true);
  assert.equal(label.style.getPropertyValue('--gev-flap-dur'), '190ms');
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  assert.equal(cells().length, plan.cells.length);
  assert.deepEqual(
    cells().map((cell) => cell.dataset.flapNext),
    plan.cells.map((cell) => cell.to || ' '),
  );
  const flapping = cells().filter((cell) =>
    cell.classList.contains('is-flapping'),
  );
  assert.equal(flapping.length, plan.changedCount);
  const first = plan.cells.find((cell) => cell.changed);
  assert.equal(cells()[first.index].dataset.flapPrev, first.from);
  assert.equal(
    cells()[first.index].style.getPropertyValue('--gev-flap-delay'),
    `${first.delayMs}ms`,
  );
  assert.equal(cells()[0].dataset.flapPrev, undefined, 'L stays put');
  t.mock.timers.tick(plan.durationMs + FLAP_SETTLE_SLACK_MS);
  await rendered();
  assert.equal(cells().length, 0);
  assert.equal(label.classList.contains('gev-flap-active'), false);
  assert.equal(label.style.getPropertyValue('--gev-flap-dur'), '');
  assert.ok(node() === permanent);
});

test('an interrupted cascade rebuilds its cells so every flap restarts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { text, cells } = mountLabel(t, 'AAAA');
  text.value = 'BBBB';
  await rendered();
  const before = cells();
  text.value = 'CCCC';
  await rendered();
  assert.equal(cells().length, 4);
  assert.ok(cells().every((cell) => !before.includes(cell)));
  // Nothing had turned yet, so the ORIGINAL label flaps away (invariant 3).
  assert.deepEqual(
    cells().map((cell) => cell.dataset.flapPrev),
    ['A', 'A', 'A', 'A'],
  );
});

test('a completion, a hidden label or an unchanged label swaps without flaps', async (t) => {
  const { text, immediate, label, cells } = mountLabel(t);
  immediate.value = true;
  text.value = 'LOAD COMPLETE';
  await rendered();
  assert.equal(label.textContent, 'LOAD COMPLETE');
  assert.equal(cells().length, 0);
  immediate.value = false;
  onScreen = false;
  text.value = 'LOAD FAILED';
  await rendered();
  assert.equal(label.textContent, 'LOAD FAILED');
  assert.equal(cells().length, 0);
  assert.equal(label.classList.contains('gev-flap-active'), false);
});

test('a growing label eases to its cascade width and ends on transitionend', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { text, label } = mountLabel(t, 'OFF');
  text.value = 'LOADING';
  // The ease renders its start width, lays it out, then renders the end.
  for (let flush = 0; flush < 2; flush += 1) await rendered();
  assert.equal(label.classList.contains('gev-flap-sizing'), true);
  assert.equal(label.style.width, '80px');
  const other = new Event('transitionend');
  other.propertyName = 'opacity';
  label.dispatchEvent(other);
  await rendered();
  assert.equal(label.style.width, '80px', 'only the width ease ends it');
  const end = new Event('transitionend');
  end.propertyName = 'width';
  label.dispatchEvent(end);
  await rendered();
  assert.equal(label.classList.contains('gev-flap-sizing'), false);
  assert.equal(label.style.width, '');
});

test('a stopped label rests at once and changes without flaps from then on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = ref(false);
  const text = ref('AAAA');
  document.body.replaceChildren();
  onScreen = true;
  const app = createApp({
    render: () =>
      h(SplitFlapText, {
        id: 'label',
        text: text.value,
        stopped: stopped.value,
      }),
  });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const label = document.getElementById('label');
  text.value = 'BBBB';
  await rendered();
  await rendered();
  assert.equal(label.querySelectorAll('.gev-flap-cell').length, 4);
  stopped.value = true;
  await rendered();
  assert.equal(label.querySelectorAll('.gev-flap-cell').length, 0);
  assert.equal(label.classList.contains('gev-flap-active'), false);
  text.value = 'CCCC';
  await rendered();
  await rendered();
  assert.equal(label.textContent, 'CCCC');
  assert.equal(label.querySelectorAll('.gev-flap-cell').length, 0);
});

function mountChrome(t) {
  onScreen = false;
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { store: useStatusStore(pinia) };
}

const $ = (selector) => document.querySelector(selector);

test('before anything publishes, the chips hold their resting labels', (t) => {
  mountChrome(t);
  assert.equal($('#global-loading-status').hidden, true);
  assert.equal($('#global-loading-status').hasAttribute('data-state'), false);
  assert.equal($('#global-loading-label').textContent, 'LOADING LIVE DATA');
  assert.equal($('#global-loading-detail').textContent, '');
  assert.equal($('#traffic-sync-chip').classList.contains('visible'), false);
  assert.equal($('#traffic-sync-label').textContent, 'syncing road network');
  assert.equal($('#traffic-sync-progress').textContent, '0%');
  assert.equal($('#cctv-sync-chip').classList.contains('visible'), false);
  assert.equal($('#cctv-sync-label').textContent, 'loading frames');
  assert.equal($('#cctv-sync-progress').textContent, '0/0');
});

test('the chips render what the status store publishes', async (t) => {
  const { store } = mountChrome(t);
  store.publishLoading({
    hidden: false,
    state: 'complete',
    label: 'LOAD COMPLETE',
    detail: 'Flights · Ships',
  });
  store.publishTraffic({
    visible: true,
    label: 'road network ready',
    immediate: true,
    progress: '',
  });
  store.publishCctv({
    visible: true,
    label: 'camera grid ready',
    immediate: false,
    progress: '12/12',
  });
  await rendered();
  assert.equal($('#global-loading-status').hidden, false);
  assert.equal($('#global-loading-status').dataset.state, 'complete');
  assert.equal($('#global-loading-label').textContent, 'LOAD COMPLETE');
  assert.equal($('#global-loading-detail').textContent, 'Flights · Ships');
  assert.equal($('#traffic-sync-chip').classList.contains('visible'), true);
  assert.equal($('#traffic-sync-label').textContent, 'road network ready');
  assert.equal($('#traffic-sync-progress').textContent, '');
  assert.equal($('#cctv-sync-chip').classList.contains('visible'), true);
  assert.equal($('#cctv-sync-progress').textContent, '12/12');
  $('#traffic-sync-chip').classList.add('panel-avoid');
  store.publishTraffic({
    visible: false,
    label: 'road network ready',
    immediate: true,
    progress: '',
  });
  store.publishLoading({
    hidden: true,
    state: null,
    label: 'LOAD COMPLETE',
    detail: 'Flights · Ships',
  });
  await rendered();
  assert.equal($('#traffic-sync-chip').classList.contains('visible'), false);
  assert.equal(
    $('#traffic-sync-chip').classList.contains('panel-avoid'),
    true,
    'classes other code sets survive',
  );
  assert.equal($('#global-loading-status').hidden, true);
  assert.equal($('#global-loading-status').hasAttribute('data-state'), false);
  assert.equal($('#global-loading-label').textContent, 'LOAD COMPLETE');
});

test('a label that changes as its status shows flaps once the status is visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store } = mountChrome(t);
  onScreen = true;
  store.publishLoading({
    hidden: false,
    state: 'error',
    label: 'LOAD FAILED',
    detail: '',
  });
  await rendered();
  await rendered();
  const label = $('#global-loading-label');
  assert.equal($('#global-loading-status').hidden, false);
  assert.equal(label.classList.contains('gev-flap-active'), true);
  assert.ok(label.querySelectorAll('.gev-flap-cell.is-flapping').length > 0);
});
