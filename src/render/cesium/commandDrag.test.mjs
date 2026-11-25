import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { installCommandDrag, isMacPlatform } from './commandDrag.js';

/** A page with a canvas, and the modifiers a listener behind it heard. */
function page({ mac = true } = {}) {
  const window = new Window();
  const { document } = window;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  const outside = document.createElement('div');
  container.appendChild(canvas);
  document.body.append(container, outside);
  const heard = [];
  // Cesium's own listeners: on the canvas for presses, on the document for
  // the mouse model's moves and releases, all in the bubble phase.
  const hear = (event) =>
    heard.push({ type: event.type, ctrl: event.ctrlKey, meta: event.metaKey });
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown'])
    canvas.addEventListener(type, hear);
  for (const type of ['mousemove', 'mouseup', 'wheel'])
    document.addEventListener(type, hear);
  canvas.addEventListener('wheel', hear);
  const dispose = installCommandDrag({ canvas, container }, { mac });
  const fire = (target, type, init = {}) => {
    // A wheel as a MouseEvent: happy-dom's WheelEvent drops the modifiers.
    const Type = type.startsWith('pointer')
      ? window.PointerEvent
      : window.MouseEvent;
    target.dispatchEvent(new Type(type, { bubbles: true, ...init }));
  };
  return { canvas, outside, document, heard, fire, dispose };
}

test('on macOS Command+drag on the canvas reports Ctrl, start to end', () => {
  const p = page();
  p.fire(p.canvas, 'pointerdown', { metaKey: true, buttons: 1 });
  p.fire(p.canvas, 'pointermove', { metaKey: true, buttons: 1 });
  p.fire(p.canvas, 'pointerup', { metaKey: true, buttons: 0 });
  assert.deepEqual(
    p.heard.map((h) => [h.type, h.ctrl, h.meta]),
    [
      ['pointerdown', true, true],
      ['pointermove', true, true],
      ['pointerup', true, true],
    ],
  );
});

test('the mouse model’s moves and releases off the canvas follow the press', () => {
  const p = page();
  p.fire(p.canvas, 'mousedown', { metaKey: true, buttons: 1 });
  p.fire(p.outside, 'mousemove', { metaKey: true, buttons: 1 });
  p.fire(p.outside, 'mouseup', { metaKey: true, buttons: 0 });
  // After the release, Command off the canvas is left alone.
  p.fire(p.outside, 'mousemove', { metaKey: true });
  assert.deepEqual(
    p.heard.map((h) => h.ctrl),
    [true, true, true, false],
  );
});

test('Ctrl+drag, plain drags and the wheel are left as they are', () => {
  const p = page();
  p.fire(p.canvas, 'pointerdown', { ctrlKey: true, buttons: 1 });
  p.fire(p.canvas, 'pointerup', { ctrlKey: true });
  p.fire(p.canvas, 'pointerdown', { buttons: 1 });
  p.fire(p.canvas, 'pointerup', {});
  p.fire(p.canvas, 'wheel', { metaKey: true, deltaY: -40 });
  p.fire(p.canvas, 'wheel', { ctrlKey: true, deltaY: -4 });
  assert.deepEqual(
    p.heard.map((h) => [h.type, h.ctrl]),
    [
      ['pointerdown', true],
      ['pointerup', true],
      ['pointerdown', false],
      ['pointerup', false],
      ['wheel', false],
      ['wheel', false],
      ['wheel', true],
      ['wheel', true],
    ],
  );
});

test('off macOS, and once disposed, Command is not Ctrl', () => {
  const other = page({ mac: false });
  other.fire(other.canvas, 'pointerdown', { metaKey: true, buttons: 1 });
  assert.equal(other.heard[0].ctrl, false);
  const p = page();
  p.dispose();
  p.dispose();
  p.fire(p.canvas, 'pointerdown', { metaKey: true, buttons: 1 });
  assert.equal(p.heard[0].ctrl, false);
});

test('isMacPlatform reads the browser’s platform', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isMacPlatform({ platform: 'iPad' }), true);
  assert.equal(isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'Linux' } }), false);
  assert.equal(isMacPlatform(undefined), false);
});
