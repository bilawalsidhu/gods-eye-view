import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';
import { createPickRouter } from './pickRouter.js';

/** The selection installed on a stand-in viewer, with what its clicks reach. */
function harness({ selected = false, services = {}, providers = [] } = {}) {
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
  const groundClicks = [];
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
    clickHandler: null,
    services: { picking: null, input: null, ...services },
    providers: new Map([
      [
        'mapillary',
        {
          def: { id: 'mapillary', pickPrefix: 'mly:' },
          instance: {
            handlePick(id) {
              if (id.startsWith('mly:seq:'))
                sequences.selects.push(id.slice(8));
              else if (id.startsWith('mly:img:')) opened.push(id.slice(8));
              return true;
            },
          },
        },
      ],
      ...providers,
    ]),
  };
  const parts = {
    router: createPickRouter(() => state.providers.values(), {
      positionId: 'sl:pos',
    }),
    hasSelectedSequence: () => sequences.selected,
    openAtGround: (position, picked) => groundClicks.push({ position, picked }),
    clearSequences() {
      sequences.cleared++;
      sequences.selected = false;
    },
  };
  const selection = createSelection({ state, parts });
  selection.install(viewer);
  const action = (type) =>
    state.clickHandler.getInputAction(Cesium.ScreenSpaceEventType[type]);
  return {
    state,
    sequences,
    opened,
    groundClicks,
    scene,
    click: (x = 10) => action('LEFT_CLICK')({ position: { x, y: 10 } }),
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
    // The marker is ours; nothing and another layer's pick go to the ground.
    assert.deepEqual(
      h.groundClicks.map(({ picked }) => picked?.id),
      [undefined, 'cctv:7'],
    );
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

test('a click on the position marker neither selects nor opens at the ground', () => {
  const h = harness();
  try {
    h.scene.under = 'sl:pos';
    h.click();
    assert.deepEqual(h.groundClicks, []);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.sequences.selects, []);
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

test('a click on a provider line hands it the ground under the click, measured only if asked', () => {
  const handled = [];
  const groundPicks = [];
  const h = harness({
    providers: [
      [
        'kartaview',
        {
          def: { id: 'kartaview', pickPrefix: 'kv:' },
          instance: {
            handlePick: (id, click) => handled.push({ id, click }),
          },
        },
      ],
    ],
    services: {
      scenePick: {
        pickGroundPosition: (viewer, position) => {
          groundPicks.push(position);
          return Cesium.Cartesian3.fromDegrees(-83.0458, 42.3314, 190);
        },
      },
    },
  });
  try {
    h.scene.under = 'kv:line:14/1/2/3';
    h.click(40);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].id, 'kv:line:14/1/2/3');
    assert.equal(
      groundPicks.length,
      0,
      'no depth read until the provider asks',
    );
    const point = handled[0].click.groundPoint();
    assert.ok(Math.abs(point.lon + 83.0458) < 1e-9);
    assert.ok(Math.abs(point.lat - 42.3314) < 1e-9);
    assert.deepEqual(groundPicks, [{ x: 40, y: 10 }]);
  } finally {
    h.restore();
  }
});
