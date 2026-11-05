import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { pointerOwner } from '../data/inputOwnership.js';
import { initNavaraImageryBoxTool } from './imageryBoxNavara.js';

test('blur and destruction during a Navara box drag return input and pointer ownership', () => {
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    };
  };
  const windowRef = target(),
    documentRef = {
      ...target(),
      defaultView: windowRef,
      body: { classList: { add() {}, remove() {} } },
    };
  const canvas = {
    ...target(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    hasPointerCapture: () => true,
    releasePointerCapture() {},
  };
  let suspended = 0,
    preview = null;
  const engine = {
    host: { canvas },
    picker: { pickPosition: () => geo.cartesian3.fromDegrees(10, 20, 0) },
    input: {
      suspendCameraInputs() {
        suspended++;
        return () => suspended--;
      },
    },
  };
  const tool = initNavaraImageryBoxTool({
    engine,
    documentRef,
    onBox() {},
    onPreview: (b) => (preview = b),
  });
  const down = () =>
    canvas.listeners.get('pointerdown')({
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 20,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  try {
    assert.equal(tool.start(), true);
    down();
    assert.equal(suspended, 1);
    assert.ok(preview);
    windowRef.listeners.get('blur')();
    assert.equal(suspended, 0);
    assert.equal(preview, null);
    assert.equal(pointerOwner(), null);
    assert.equal(tool.isActive(), false);
    tool.start();
    down();
    tool.destroy();
    tool.destroy();
    assert.equal(suspended, 0);
    assert.equal(pointerOwner(), null);
    assert.equal(canvas.listeners.size, 0);
    assert.equal(documentRef.listeners.size, 0);
    assert.equal(windowRef.listeners.size, 0);
  } finally {
    tool.destroy();
  }
});
