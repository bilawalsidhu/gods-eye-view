import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';

/** The selection installed on a stand-in viewer, with what its clicks reach. */
function harness({ selected = false } = {}) {
  const saved = globalThis.document;
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
  const sequences = { selected, cleared: 0, selects: [] };
  const opened = [];
  /** What the pointer is over: a pick id, or nothing. */
  const scene = { under: null };
  const canvas = Object.assign(new EventTarget(), {
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  const viewer = {
    scene: { canvas, pick: () => scene.under && { id: scene.under } },
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
        select: (id) => sequences.selects.push(id),
        clearSelection() {
          sequences.cleared++;
          sequences.selected = false;
        },
      },
      openImage: (id) => opened.push(id),
    },
  });
  selection.install(viewer);
  const action = (type) =>
    state.clickHandler.getInputAction(Cesium.ScreenSpaceEventType[type]);
  return {
    state,
    sequences,
    opened,
    scene,
    click: () => action('LEFT_CLICK')({ position: { x: 10, y: 10 } }),
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
    restore() {
      selection.uninstall();
      globalThis.document = saved;
    },
  };
}

test('a click on a line selects its sequence, on a cone opens its image, elsewhere does nothing', () => {
  const h = harness();
  try {
    h.scene.under = 'mly:seq:abc';
    h.click();
    assert.deepEqual(h.sequences.selects, ['abc']);
    h.scene.under = 'mly:img:42';
    h.click();
    assert.deepEqual(h.opened, ['42']);
    for (const under of [null, 'cctv:7', 'sl:pos']) {
      h.scene.under = under;
      h.click();
    }
    assert.deepEqual([h.sequences.selects, h.opened], [['abc'], ['42']]);
    // Mapillary switched off under a layer that is on: lines are not drawn.
    h.state.providerOn = false;
    h.scene.under = 'mly:seq:abc';
    h.click();
    assert.deepEqual(h.sequences.selects, ['abc']);
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
