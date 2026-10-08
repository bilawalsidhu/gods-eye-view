import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';

/**
 * The selection installed on a stand-in viewer. Animation frames queue until
 * `frame()` runs them.
 */
function harness({ selected = false } = {}) {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const frames = [];
  globalThis.requestAnimationFrame = (task) => frames.push(task);
  globalThis.document = new EventTarget();
  // The document's keydown listeners, so a test can hand them any target.
  const keyListeners = new Set();
  const addListener = globalThis.document.addEventListener.bind(
    globalThis.document,
  );
  const removeListener = globalThis.document.removeEventListener.bind(
    globalThis.document,
  );
  globalThis.document.addEventListener = (type, listener, options) => {
    if (type === 'keydown') keyListeners.add(listener);
    addListener(type, listener, options);
  };
  globalThis.document.removeEventListener = (type, listener, options) => {
    if (type === 'keydown') keyListeners.delete(listener);
    removeListener(type, listener, options);
  };
  const sequences = { selected, cleared: 0 };
  const picks = [];
  /** What the pointer is over: a line this layer owns, or nothing. */
  const scene = { under: null };
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  const camera = { moveEnd: new Cesium.Event() };
  const viewer = {
    camera,
    scene: {
      canvas,
      pick(position) {
        picks.push(position);
        return scene.under && { id: scene.under };
      },
    },
  };
  const state = {
    viewer,
    enabled: true,
    providerOn: true,
    clickHandler: null,
    services: { picking: null, input: null },
    sequence: {
      get selectedId() {
        return sequences.selected ? 'seq-1' : null;
      },
    },
  };
  const selection = createSelection({
    state,
    parts: {
      sequences: {
        clearSelection() {
          sequences.cleared++;
          sequences.selected = false;
        },
      },
    },
  });
  selection.install(viewer);
  const action = (type) =>
    state.clickHandler.getInputAction(Cesium.ScreenSpaceEventType[type]);
  const onMove = action('MOUSE_MOVE');
  return {
    state,
    sequences,
    /** A keydown reaching the document from `target`; the event as handled. */
    key(key, target, { defaultPrevented = false } = {}) {
      const event = {
        key,
        target,
        defaultPrevented,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of [...keyListeners]) listener(event);
      return event;
    },
    scene,
    canvas,
    picks,
    move: (x) => onMove({ endPosition: { x, y: 10 } }),
    camera,
    /** A pointer event on the canvas with `buttons` held. */
    buttons(type, buttons) {
      const event = new Event(type);
      Object.defineProperty(event, 'buttons', { value: buttons });
      canvas.dispatchEvent(event);
    },
    frame() {
      for (const task of frames.splice(0)) task();
    },
    restore() {
      selection.uninstall();
      Object.assign(globalThis, saved);
    },
  };
}

test('hover picks once a frame, at the latest position, and shows a pointer over a line', () => {
  const h = harness();
  try {
    h.scene.under = 'mly:seq:1';
    for (let x = 0; x < 5; x++) h.move(x);
    h.frame();
    assert.deepEqual(
      h.picks.map(({ x }) => x),
      [4],
      'one pick for the burst',
    );
    assert.equal(h.canvas.style.cursor, 'pointer');
    h.scene.under = null;
    h.move(6);
    h.frame();
    assert.equal(h.canvas.style.cursor, '', 'off the line');
    h.frame();
    assert.equal(h.picks.length, 2, 'a still pointer costs nothing');
  } finally {
    h.restore();
  }
});

test('a drag with any button picks nothing, and a release with a modifier held does not stick', () => {
  const h = harness();
  try {
    for (const held of [1, 2, 4]) {
      h.buttons('pointerdown', held);
      h.move(held);
      h.frame();
    }
    assert.equal(h.picks.length, 0, 'left, right and middle drags');
    // Released with Shift held: Cesium's plain LEFT_UP never fires.
    h.buttons('pointerup', 0);
    h.move(5);
    h.frame();
    assert.equal(h.picks.length, 1, 'hover picks again');
  } finally {
    h.restore();
  }
});

test('when the camera rests, a still pointer is picked again so the cursor cannot stick', () => {
  const h = harness();
  try {
    h.scene.under = 'mly:seq:1';
    h.move(5);
    h.frame();
    assert.equal(h.canvas.style.cursor, 'pointer');
    // The camera moves the line out from under a still pointer.
    h.scene.under = null;
    h.camera.moveEnd.raiseEvent();
    h.frame();
    assert.equal(h.picks.length, 2);
    assert.equal(h.canvas.style.cursor, '');
  } finally {
    h.restore();
  }
});

test('a hover frame queued before the layer went off does not pick', () => {
  const h = harness();
  try {
    h.move(2);
    h.state.enabled = false;
    h.frame();
    assert.equal(h.picks.length, 0, 'the layer went off');
  } finally {
    h.restore();
  }
});

/**
 * An element as Esc sees it: `closest` matches tag names in a selector list;
 * `isContentEditable` is inherited from an editing host, as in a browser.
 */
function element(tag, { isContentEditable = false } = {}) {
  return {
    tagName: tag.toUpperCase(),
    isContentEditable,
    closest(selector) {
      const names = selector.split(',').map((part) => part.trim());
      return names.includes(tag) ? this : null;
    },
  };
}

test('Esc on the globe clears the selected sequence', () => {
  const h = harness({ selected: true });
  try {
    const event = h.key('Escape', element('canvas'));
    assert.equal(h.sequences.cleared, 1);
    assert.equal(event.defaultPrevented, true, 'and claims the key');
    h.key('Escape', element('canvas'));
    assert.equal(h.sequences.cleared, 1, 'nothing left to clear');
  } finally {
    h.restore();
  }
});

test('an Esc something else already handled keeps the selection (M60)', () => {
  const h = harness({ selected: true });
  try {
    h.key('Escape', element('canvas'), { defaultPrevented: true });
    assert.equal(h.sequences.cleared, 0);
  } finally {
    h.restore();
  }
});

test('Esc in a text field or rich-text editor keeps the selection (M61)', () => {
  const h = harness({ selected: true });
  try {
    for (const tag of ['input', 'textarea', 'select']) {
      const event = h.key('Escape', element(tag));
      assert.equal(h.sequences.cleared, 0, `typing in a <${tag}>`);
      assert.equal(event.defaultPrevented, false, `<${tag}> keeps its Esc`);
    }
    // A <div contenteditable> (or anything inside one) is a text field too.
    h.key('Escape', element('div', { isContentEditable: true }));
    assert.equal(h.sequences.cleared, 0, 'typing in a contenteditable');
  } finally {
    h.restore();
  }
});
