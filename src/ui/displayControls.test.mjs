import assert from 'node:assert/strict';
import test from 'node:test';
import { bindDisplayControls } from './displayControls.js';

function element(value = '') {
  const el = new EventTarget();
  el.value = value;
  el.dataset = {};
  return el;
}

test('controls read current values without preventing native input behavior', () => {
  const bloomSlider = element('24');
  const hudLayout = element('tactical');
  const calls = [];
  const control = bindDisplayControls({
    elements: { bloomSlider, hudLayout },
    actions: {
      setBloomIntensity: (value) => calls.push(value),
      setHudLayout: (value) => calls.push(value),
    },
  });
  const event = new Event('input', { cancelable: true });
  bloomSlider.dispatchEvent(event);
  bloomSlider.value = '37';
  bloomSlider.dispatchEvent(new Event('input'));
  hudLayout.value = 'minimal';
  hudLayout.dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [24, 37, 'minimal']);
  assert.equal(event.defaultPrevented, false);
  control.destroy();
});

test('destroyed and replaced controls cannot issue stale actions', () => {
  const bloomButton = element();
  let oldCalls = 0;
  let newCalls = 0;
  const first = bindDisplayControls({
    elements: { bloomButton },
    actions: { toggleBloom: () => oldCalls++ },
  });
  bloomButton.dispatchEvent(new Event('click'));
  first.destroy();
  const second = bindDisplayControls({
    elements: { bloomButton },
    actions: { toggleBloom: () => newCalls++ },
  });
  first.destroy();
  bloomButton.dispatchEvent(new Event('click'));
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
  second.destroy();
  bloomButton.dispatchEvent(new Event('click'));
  assert.equal(newCalls, 1);
});

test('style, allocation and model choices retain their current data attributes', () => {
  const style = element();
  const allocation = element();
  const mode = element();
  style.dataset.style = 'thermal';
  allocation.dataset.allocation = 'balanced';
  mode.dataset.mode = 'all';
  const calls = [];
  const control = bindDisplayControls({
    elements: {
      styleButtons: [style],
      allocationButtons: [allocation],
      modelModeButtons: [mode],
    },
    actions: {
      setStyle: (value) => calls.push(value),
      setAllocation: (value) => calls.push(value),
      setModelsMode: (value) => calls.push(value),
    },
  });
  for (const el of [style, allocation, mode])
    el.dispatchEvent(new Event('click'));
  mode.dataset.mode = 'unknown';
  mode.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['thermal', 'balanced', 'all', 'proximity']);
  control.destroy();
});

test('optional controls are absent safely and subscriptions stay instance-owned', () => {
  const calls = [];
  const a = element();
  const b = element();
  const one = bindDisplayControls({
    elements: { fadeSliders: [null, a] },
    actions: { setFade: () => calls.push('a') },
  });
  const two = bindDisplayControls({
    elements: { fadeSliders: [b] },
    actions: { setFade: () => calls.push('b') },
  });
  one.destroy();
  a.dispatchEvent(new Event('input'));
  b.dispatchEvent(new Event('input'));
  assert.deepEqual(calls, ['b']);
  two.destroy();
});
