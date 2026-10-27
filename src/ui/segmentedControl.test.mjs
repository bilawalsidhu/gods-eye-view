import test from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from './railTestFixture.mjs';
import {
  createSegmentedControl,
  nextSegmentValue,
} from './segmentedControl.js';

function fixture(options = {}) {
  let writes = 0;
  const f = railFixture(() => writes++);
  const buttons = ['a', 'b', 'c'].map((value) => {
    const button = f.document.createElement('button');
    button.dataset.value = value;
    f.container.appendChild(button);
    return button;
  });
  const calls = [];
  const control = createSegmentedControl({
    buttons,
    valueOf: (button) => button.dataset.value,
    onChange: (value) => calls.push(value),
    ...options,
  });
  const key = (target, value) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { ...f, buttons, calls, control, key, writes: () => writes };
}

test('controlled restoration updates selection without emitting or stealing focus', () => {
  const f = fixture();
  f.buttons[0].focus();
  f.control.update('b', { rovingFocus: true });
  assert.deepEqual(f.calls, []);
  assert.equal(f.document.activeElement, f.buttons[0]);
  assert.deepEqual(
    f.buttons.map((b) => b.getAttribute('aria-checked')),
    ['false', 'true', 'false'],
  );
  assert.deepEqual(
    f.buttons.map((b) => b.getAttribute('tabindex')),
    ['-1', '0', '-1'],
  );
  const before = f.writes();
  f.control.update('b', { rovingFocus: true });
  assert.equal(
    f.writes(),
    before,
    'unchanged renders must not retrigger rail observers',
  );
  f.control.destroy();
});

test('clicks emit current values once, including reselection; disabled controls do not emit', () => {
  const f = fixture();
  f.control.update('a');
  f.buttons[0].click();
  f.buttons[0].click();
  f.buttons[1].dataset.value = 'renamed';
  f.buttons[1].click();
  f.buttons[2].disabled = true;
  f.buttons[2].dispatchEvent(new Event('click'));
  assert.deepEqual(f.calls, ['a', 'a', 'renamed']);
  assert.equal(
    f.buttons[0].getAttribute('aria-checked'),
    'true',
    'the owner controls selection',
  );
  f.control.destroy();
});

test('radio navigation wraps, skips disabled choices, and retains Home/End semantics', () => {
  const f = fixture({ keyboard: 'radio' });
  f.buttons[1].disabled = true;
  assert.equal(f.key(f.buttons[0], 'ArrowRight'), true);
  assert.equal(f.document.activeElement, f.buttons[2]);
  assert.deepEqual(f.calls, ['c']);
  f.key(f.buttons[2], 'ArrowDown');
  assert.equal(f.document.activeElement, f.buttons[0]);
  f.key(f.buttons[0], 'Home');
  assert.deepEqual(
    f.calls,
    ['c', 'a'],
    'Home on the first button does not reselect it',
  );
  f.key(f.buttons[0], 'End');
  assert.equal(f.document.activeElement, f.buttons[2]);
  assert.deepEqual(f.calls, ['c', 'a', 'c']);
  f.control.destroy();
});

test('legacy click-only groups leave arrows and tab order to their existing owner', () => {
  const f = fixture();
  f.control.update('b');
  assert.equal(f.key(f.buttons[0], 'ArrowRight'), false);
  assert.equal(f.key(f.buttons[0], 'Home'), false);
  assert.deepEqual(f.calls, []);
  assert.ok(
    f.buttons.every((button) => button.getAttribute('tabindex') === null),
  );
  f.control.destroy();
});

test('delegated imagery keys navigate from the controlled value, not stale focus', () => {
  const f = railFixture();
  const buttons = ['a', 'b', 'c'].map((value) => {
    const button = f.document.createElement('button');
    button.dataset.value = value;
    f.container.appendChild(button);
    return button;
  });
  let selected = 'c';
  const calls = [];
  const control = createSegmentedControl({
    buttons,
    valueOf: (b) => b.dataset.value,
    onChange: (value) => {
      calls.push(value);
      selected = value;
    },
    keyboard: 'arrows',
    keyTarget: f.container,
    readValue: () => selected,
  });
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: 'ArrowRight' });
  f.container.dispatchEvent(event);
  assert.deepEqual(calls, ['a']);
  assert.equal(f.document.activeElement, buttons[0]);
  const home = new Event('keydown', { cancelable: true });
  Object.defineProperty(home, 'key', { value: 'Home' });
  f.container.dispatchEvent(home);
  assert.equal(home.defaultPrevented, false);
  assert.deepEqual(calls, ['a']);
  control.destroy();
});

test('disposal revokes detached controls and replacement subscriptions fire once', () => {
  const f = fixture({ keyboard: 'radio' });
  f.control.destroy();
  const next = [];
  const replacement = createSegmentedControl({
    buttons: f.buttons,
    valueOf: (b) => b.dataset.value,
    onChange: (value) => next.push(value),
    keyboard: 'radio',
  });
  f.buttons[0].click();
  f.key(f.buttons[0], 'End');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(next, ['a', 'c']);
  replacement.destroy();
  replacement.destroy();
  f.buttons[1].click();
  f.key(f.buttons[0], 'End');
  assert.deepEqual(next, ['a', 'c']);
});

test('pure value navigation can be reused without a DOM', () => {
  assert.equal(nextSegmentValue(['fit', 'fill'], 'fill', 'ArrowRight'), 'fit');
  assert.equal(nextSegmentValue(['fit', 'fill'], 'fit', 'ArrowUp'), 'fill');
  assert.equal(nextSegmentValue(['fit', 'fill'], 'fill', 'Home'), 'fit');
  assert.equal(nextSegmentValue(['fit', 'fill'], 'fit', 'End'), 'fill');
  assert.equal(
    nextSegmentValue(['fit', 'fill'], 'fit', 'Home', { homeEnd: false }),
    undefined,
  );
  assert.equal(nextSegmentValue([], 'fit', 'ArrowRight'), undefined);
  assert.equal(nextSegmentValue(['fit'], 'fit', 'Escape'), undefined);
});
