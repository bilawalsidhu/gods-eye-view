// The navigation control view renders what the navigation owner publishes to
// the gev-nav-control store and sends every press, drag and key back through
// it. These tests mount the real view over happy-dom with a fake owner.
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../../testSupport/vueDom.mjs';

let mount;
let nextTick;
let createPinia;
let useNavControlStore;
let NavControl;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ nextTick } = await import('vue'));
  ({ createPinia } = await import('pinia'));
  ({ useNavControlStore } = await import('../../stores/navControl.js'));
  NavControl = (await import('./NavControl.vue')).default;
});
after(() => uninstall());

const VIEW = { heading: 0, tilt: 30, following: false, dragging: false };
let wrapper;
let nav;
let calls;
let token;

/** Mount the view with a fake owner that records what the view asks of it. */
function setup(answers = {}) {
  const pinia = createPinia();
  nav = useNavControlStore(pinia);
  calls = [];
  const record =
    (name, answer) =>
    (...args) => {
      calls.push([name, ...args]);
      return answer;
    };
  token = nav.connect({
    press: record('press'),
    release: record('release'),
    activate: record('activate'),
    ringStart: record('ringStart', answers.ringStart ?? true),
    ringMove: record('ringMove'),
    ringEnd: record('ringEnd'),
    ringKey: record('ringKey', answers.ringKey ?? false),
    sliderStart: record('sliderStart'),
    sliderInput: record('sliderInput'),
    sliderEnd: record('sliderEnd'),
  });
  wrapper = mount(NavControl, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  });
}
const show = async (change = {}) => {
  nav.publish(token, { ...VIEW, ...change });
  await nextTick();
};
const root = () => document.getElementById('gev-nav-control');
const control = (name) => root().querySelector(`[data-nav="${name}"]`);
const fire = (node, type, fields = {}) => {
  const event = new window.Event(type, {
    bubbles: type !== 'blur',
    cancelable: true,
  });
  Object.assign(event, fields);
  node.dispatchEvent(event);
  return event;
};

beforeEach(() => document.body.replaceChildren());
afterEach(() => wrapper?.unmount());

test('nothing shows until the owner publishes, and it goes when the owner does', async () => {
  setup();
  assert.equal(root(), null);
  await show();
  assert.ok(root());
  nav.detach(token);
  await nextTick();
  assert.equal(root(), null);
});

test('every control is a labelled, typed element under one group', async () => {
  setup();
  await show();
  assert.equal(root().getAttribute('role'), 'group');
  assert.equal(root().getAttribute('aria-label'), 'Map navigation');
  assert.equal(root().parentElement, document.body, 'teleported to the body');
  const names = [...root().querySelectorAll('[data-nav]')]
    .map((node) => node.getAttribute('data-nav'))
    .sort();
  assert.deepEqual(names, [
    'look-down',
    'look-left',
    'look-right',
    'look-up',
    'north',
    'ring',
    'tilt-down',
    'tilt-slider',
    'tilt-up',
    'top-down',
    'zoom-in',
    'zoom-out',
  ]);
  for (const node of root().querySelectorAll('[data-nav]')) {
    assert.ok(node.getAttribute('aria-label'), `${node.tagName} is labelled`);
    if (node.tagName === 'BUTTON')
      assert.equal(node.getAttribute('type'), 'button');
  }
  assert.equal(control('zoom-in').getAttribute('aria-label'), 'Zoom in');
  assert.equal(control('zoom-in').getAttribute('title'), 'Zoom in');
  assert.equal(control('ring').getAttribute('role'), 'slider');
  assert.equal(control('ring').getAttribute('tabindex'), '0');
  assert.equal(control('tilt-slider').getAttribute('type'), 'range');
  assert.equal(control('tilt-slider').getAttribute('max'), '79');
});

test('the heading, tilt and follow state render from the published view', async () => {
  setup();
  await show({ heading: 270, tilt: 12 });
  assert.equal(root().style.getPropertyValue('--gev-nav-heading'), '270deg');
  assert.equal(root().getAttribute('data-north-up'), 'false');
  assert.equal(root().getAttribute('data-following'), 'false');
  assert.equal(control('ring').getAttribute('aria-valuenow'), '270');
  assert.equal(
    control('ring').getAttribute('aria-valuetext'),
    '270 degrees from north',
  );
  assert.equal(
    control('north').getAttribute('aria-label'),
    'Reset map to north up. Current heading 270 degrees',
  );
  assert.equal(control('north').getAttribute('title'), 'North up');
  assert.equal(control('tilt-slider').value, '12');

  await show({ heading: 0, tilt: 12 });
  assert.equal(root().getAttribute('data-north-up'), 'true');
  assert.equal(control('ring').getAttribute('aria-valuetext'), 'North, 0 degrees');

  await show({ following: true });
  assert.equal(root().getAttribute('data-following'), 'true');
  for (const name of ['look-up', 'look-down', 'look-left', 'look-right'])
    assert.equal(control(name).disabled, true, `${name} is disabled`);
  assert.equal(control('zoom-in').disabled, false);
  await show({ following: false });
  assert.equal(control('look-up').disabled, false);

  assert.equal(root().getAttribute('data-dragging'), null);
  await show({ dragging: true });
  assert.equal(root().getAttribute('data-dragging'), 'ring');
});

test('a pointer press acts once on pointerdown and the release stops it', async () => {
  setup();
  await show();
  const zoomIn = control('zoom-in');
  fire(zoomIn, 'pointerdown', { button: 0 });
  fire(zoomIn, 'pointerup', { button: 0 });
  fire(zoomIn, 'click', { detail: 1 }); // the compatibility click
  assert.deepEqual(calls, [['press', 'zoom-in'], ['release']]);
});

test('keyboard activation is a click with no pointer and acts once', async () => {
  setup();
  await show();
  fire(control('north'), 'click', { detail: 0 });
  assert.deepEqual(calls, [['activate', 'north']]);
});

test('a secondary button does not press, and leaving or cancelling releases', async () => {
  setup();
  await show();
  const tiltUp = control('tilt-up');
  fire(tiltUp, 'pointerdown', { button: 2 });
  assert.deepEqual(calls, []);
  fire(tiltUp, 'pointerleave');
  fire(tiltUp, 'pointercancel');
  assert.deepEqual(calls, [['release'], ['release']]);
});

test('losing window focus releases a held press, until the view is gone', async () => {
  setup();
  await show();
  window.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(calls, [['release']]);
  wrapper.unmount();
  window.dispatchEvent(new window.Event('blur'));
  assert.equal(calls.length, 1, 'the listener left with the view');
});

test('the ring reports its centre and the pointer, and captures when accepted', async () => {
  setup();
  await show();
  const ring = control('ring');
  ring.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    width: 80,
    height: 80,
  });
  const captured = [];
  ring.setPointerCapture = (id) => captured.push(id);
  fire(ring, 'pointerdown', {
    button: 0,
    clientX: 180,
    clientY: 140,
    pointerId: 7,
  });
  fire(ring, 'pointermove', { clientX: 170, clientY: 168 });
  fire(ring, 'pointerup', { pointerId: 7 });
  assert.deepEqual(calls, [
    ['ringStart', { centerX: 140, centerY: 140, clientX: 180, clientY: 140 }],
    ['ringMove', { clientX: 170, clientY: 168 }],
    ['ringEnd'],
  ]);
  assert.deepEqual(captured, [7]);
});

test('a refused ring drag does not capture the pointer, and an unmeasured ring is ignored', async () => {
  setup({ ringStart: false });
  await show();
  const ring = control('ring');
  const captured = [];
  ring.setPointerCapture = (id) => captured.push(id);
  ring.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  fire(ring, 'pointerdown', { button: 0, pointerId: 1 });
  assert.deepEqual(calls, [], 'no size, no drag');
  ring.getBoundingClientRect = () => ({ left: 0, top: 0, width: 80, height: 80 });
  fire(ring, 'pointerdown', { button: 0, clientX: 80, clientY: 40, pointerId: 1 });
  fire(ring, 'pointerdown', { button: 2, pointerId: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(captured, []);
});

test('ring keys go to the owner, which says whether the ring uses them', async () => {
  setup({ ringKey: true });
  await show();
  const taken = fire(control('ring'), 'keydown', { key: 'ArrowRight' });
  assert.deepEqual(calls, [['ringKey', 'ArrowRight']]);
  assert.equal(taken.defaultPrevented, true);
  wrapper.unmount();

  setup({ ringKey: false });
  await show();
  const left = fire(control('ring'), 'keydown', { key: 'a' });
  assert.equal(left.defaultPrevented, false);
});

test('the tilt slider sends numbers and its drag and blur', async () => {
  setup();
  await show({ tilt: 30 });
  const slider = control('tilt-slider');
  assert.equal(slider.value, '30');
  fire(slider, 'pointerdown');
  slider.value = '60';
  fire(slider, 'input');
  fire(slider, 'pointerup');
  fire(slider, 'blur');
  assert.deepEqual(calls, [
    ['sliderStart'],
    ['sliderInput', 60],
    ['sliderEnd'],
    ['sliderEnd'],
  ]);
  assert.equal(
    slider.getAttribute('aria-valuetext'),
    '30 degrees from top-down',
  );
  await show({ tilt: 45 });
  assert.equal(slider.value, '45', 'the owner moves an unfocused handle');
});
