import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';

/**
 * The selection installed on a stand-in viewer. Animation frames queue until
 * `frame()` runs them; timers and Date.now() are mocked so a burst of moves
 * has a known timeline.
 */
function harness({ selected = false } = {}) {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
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
  const groundClicks = [];
  const picks = [];
  /** What the pointer is over: a line this layer owns, or nothing. */
  const scene = { under: null };
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  const camera = { moveStart: new Cesium.Event(), moveEnd: new Cesium.Event() };
  const viewer = {
    scene: {
      canvas,
      pick(position) {
        picks.push(position);
        return scene.under && { id: scene.under };
      },
    },
    camera,
    isDestroyed: () => false,
  };
  const state = {
    viewer,
    enabled: true,
    clickHandler: null,
    services: { picking: null, input: null },
  };
  const selection = createSelection({
    state,
    parts: {
      router: { ownsPick: (id) => id === 'mly:seq:1', resolve: () => null },
      hasSelectedSequence: () => sequences.selected,
      openAtGround: (position, picked) =>
        groundClicks.push({ position, picked }),
      clearSequences() {
        sequences.cleared++;
        sequences.selected = false;
      },
    },
  });
  selection.install(viewer);
  const onMove = state.clickHandler.getInputAction(
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  );
  const onClick = state.clickHandler.getInputAction(
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );
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
    camera,
    picks,
    move: (x) => onMove({ endPosition: { x, y: 10 } }),
    click: (x) => onClick({ position: { x, y: 10 } }),
    groundClicks,
    frame() {
      for (const task of frames.splice(0)) task();
    },
    /** Let `ms` pass, running the frames that come due on the way. */
    wait(ms) {
      this.frame();
      mock.timers.tick(ms);
      this.frame();
    },
    buttons(type, buttons) {
      const event = new Event(type);
      Object.defineProperty(event, 'buttons', { value: buttons });
      canvas.dispatchEvent(event);
    },
    restore() {
      selection.uninstall();
      mock.timers.reset();
      Object.assign(globalThis, saved);
    },
  };
}

test('hover picks at most every 120 ms through a burst of moves, ending on the last one', () => {
  const h = harness();
  try {
    // One second of a pointer moving at 60 Hz.
    for (let i = 0; i < 60; i++) {
      h.move(i);
      h.wait(16);
    }
    assert.ok(h.picks.length <= 9, `${h.picks.length} picks in ~1 s`);
    assert.ok(h.picks.length >= 7, `${h.picks.length} picks in ~1 s`);
    h.wait(200);
    assert.deepEqual(h.picks.at(-1), { x: 59, y: 10 }, 'the resting position');
    const settled = h.picks.length;
    h.wait(1000);
    assert.equal(h.picks.length, settled, 'a still pointer costs nothing');
  } finally {
    h.restore();
  }
});

test('hover does not pick while a mouse button is held', () => {
  const h = harness();
  try {
    h.buttons('pointerdown', 1);
    h.move(1);
    h.wait(200);
    assert.equal(h.picks.length, 0, 'a drag in progress');
    h.buttons('pointerup', 0);
    h.move(2);
    h.wait(200);
    assert.equal(h.picks.length, 1);
  } finally {
    h.restore();
  }
});

test('a camera that never stops (orbit, tracking) keeps hover throttled, not off', () => {
  const h = harness();
  try {
    // An orbiting or tracking camera raises moveStart and never moveEnd.
    h.camera.moveStart.raiseEvent();
    for (let i = 0; i < 60; i++) {
      h.move(i);
      h.wait(16);
    }
    assert.ok(h.picks.length >= 7, `${h.picks.length} picks in ~1 s`);
    assert.ok(h.picks.length <= 9, `${h.picks.length} picks in ~1 s`);
  } finally {
    h.restore();
  }
});

test('when the camera stops, the pointer is picked again so the cursor cannot stick', () => {
  const h = harness();
  try {
    h.scene.under = 'mly:seq:1';
    h.move(5);
    h.wait(200);
    assert.equal(h.canvas.style.cursor, 'pointer', 'over a line');
    // The camera moves the line out from under a still pointer.
    h.camera.moveStart.raiseEvent();
    h.scene.under = null;
    h.camera.moveEnd.raiseEvent();
    h.wait(200);
    assert.equal(h.picks.length, 2, 'one pick when the camera rests');
    assert.deepEqual(h.picks.at(-1), { x: 5, y: 10 });
    assert.equal(h.canvas.style.cursor, '', 'the pointer cursor is gone');
  } finally {
    h.restore();
  }
});

test('a hover frame queued before the layer went off does not pick', () => {
  const h = harness();
  try {
    h.move(1);
    h.state.enabled = false;
    h.wait(200);
    assert.equal(h.picks.length, 0);
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

test('a click on nothing of ours goes to the ground handler with the pick, which decides', () => {
  const h = harness();
  try {
    h.click(5);
    h.scene.under = 'flight:abc';
    h.click(6);
    assert.deepEqual(
      h.groundClicks.map(({ position, picked }) => [position.x, picked?.id]),
      [
        [5, undefined],
        [6, 'flight:abc'],
      ],
    );
  } finally {
    h.restore();
  }
});
