import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { installRailEdgeScroll } from './railEdgeScroll.js';

// A page with a left and a right rail of three items each, laid out by hand:
// happy-dom does no layout, so boxes and the clock are stubbed.
function page({ rtl = false } = {}) {
  const window = new Window({ width: 1600, height: 900 });
  const doc = window.document;
  let now = 1000;
  const timers = new Map();
  let nextTimer = 1;
  window.performance.now = () => now;
  window.setTimeout = (fn, ms) => {
    const id = nextTimer++;
    timers.set(id, { fn, at: now + ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 1600 });
  const box = (el, left, top, width, height) => {
    el.getBoundingClientRect = () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    Object.defineProperty(el, 'offsetWidth', { get: () => width });
  };
  const clicks = [];
  const rail = (name, left) => {
    const el = doc.createElement('div');
    el.className = `ui-rail ui-rail--${name}`;
    box(el, left, 200, 40, 120);
    for (let i = 0; i < 3; i++) {
      const item = doc.createElement('button');
      item.className = 'ui-rail__item';
      item.dataset.railItem = `${name}-${i}`;
      item.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      box(item, left + 4, 204 + i * 40, 32, 32);
      item.addEventListener('click', () => {
        clicks.push(item.dataset.railItem);
        for (const other of el.children)
          other.setAttribute('aria-pressed', String(other === item));
      });
      el.append(item);
    }
    doc.body.append(el);
    return el;
  };
  // In a right-to-left language the left stack's rail is on the right edge.
  const left = rail('left', rtl ? 1550 : 10);
  const right = rail('right', rtl ? 10 : 1550);
  const remove = installRailEdgeScroll(doc);
  const wheel = (x, deltaY, { deltaMode = 0, target = doc.body } = {}) => {
    // happy-dom leaves clientX off these events, so it is set by hand.
    const at = (event) => Object.defineProperty(event, 'clientX', { value: x });
    target.dispatchEvent(
      at(new window.PointerEvent('pointermove', { bubbles: true })),
    );
    const event = at(
      new window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode,
      }),
    );
    target.dispatchEvent(event);
    return event;
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return { window, doc, left, right, clicks, wheel, advance, remove };
}

test('a wheel in the left strip steps that rail and keeps the globe from zooming', () => {
  const p = page();
  const event = p.wheel(20, 120);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(p.clicks, ['left-1']);
  p.remove();
});

test('a line-based mouse wheel steps one panel per notch', () => {
  const p = page();
  p.wheel(20, 3, { deltaMode: 1 });
  p.advance(600);
  p.wheel(20, 3, { deltaMode: 1 });
  assert.deepEqual(p.clicks, ['left-1', 'left-2']);
  p.remove();
});

test('a rail hidden by clean view or recording leaves the wheel to the globe', () => {
  const p = page();
  p.left.checkVisibility = () => false;
  const event = p.wheel(20, 120);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(p.clicks, []);
  p.remove();
});

test('right to left: the wheel at each screen edge steps the rail on that edge', () => {
  const p = page({ rtl: true });
  p.wheel(1580, 120);
  p.advance(600);
  p.wheel(20, 120);
  assert.deepEqual(p.clicks, ['left-1', 'right-1']);
  p.remove();
});

test('after a step, the wheel goes back to the page once the coasting is over', () => {
  const p = page();
  p.wheel(20, 120);
  // The pointer moves off the strip while the gesture still coasts.
  let event;
  for (let i = 0; i < 20; i++) {
    p.advance(100);
    event = p.wheel(800, 30);
  }
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(p.clicks, ['left-1']);
  p.remove();
});

test('a held step is dropped when the pointer leaves the strip, even if it comes back', () => {
  const p = page();
  p.wheel(20, 120);
  p.advance(250);
  p.wheel(20, -120); // turns round: a second step, held for the gap
  p.wheel(800, 0); // leaves the strip
  p.wheel(20, 0); // and returns before the gap ends
  p.advance(600);
  assert.deepEqual(p.clicks, ['left-1']);
  p.remove();
});

test('removing it stops edge scrolling', () => {
  const p = page();
  p.remove();
  const event = p.wheel(20, 120);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(p.clicks, []);
});

test('a sideways move mid-swipe neither turns the gesture round nor steps again', () => {
  const p = page();
  p.wheel(20, 60);
  p.advance(50);
  const sideways = p.wheel(20, 0);
  p.advance(50);
  p.wheel(20, 40); // the same swipe coasting on
  assert.equal(sideways.defaultPrevented, false);
  assert.deepEqual(p.clicks, ['left-1']);
  p.remove();
});

test('an open dialog near the edge keeps its own wheel', () => {
  const p = page();
  const dialog = p.doc.createElement('dialog');
  p.doc.body.append(dialog);
  const event = p.wheel(20, 120, { target: dialog });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(p.clicks, []);
  p.remove();
});
