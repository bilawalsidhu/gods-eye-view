import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSelection } from './selection.js';
import { createPickRouter } from './pickRouter.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import * as pickRegistry from '../../data/pickRegistry.js';

/** The selection installed on a stand-in viewer, with what its clicks reach. */
function harness({
  selected = false,
  services = {},
  providers = [],
  sceneExtras = {},
} = {}) {
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
    scene: {
      canvas,
      pick: () => scene.under && { id: scene.under },
      ...sceneExtras,
    },
  };
  // The card on top at a click, as the host answers the pick registry.
  pickRegistry.setClickCardHitTest(services.overlayHit ?? null);
  const state = {
    viewer,
    enabled: true,
    clickSubscription: null,
    services: { picking: pickRegistry, input: null, ...services },
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
    openAtGround: (click) => groundClicks.push(click),
    clearSequences() {
      sequences.cleared++;
      sequences.selected = false;
    },
  };
  const input = fakeInput(viewer);
  const selection = createSelection({ state, parts });
  selection.install(viewer);
  return {
    state,
    sequences,
    opened,
    groundClicks,
    scene,
    click: (x = 10) => input.click({ x, y: 10 }),
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
      pickRegistry.setClickCardHitTest(null);
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
      h.groundClicks.map(({ surface }) => surface),
      [true, false],
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

test('a click on nothing of ours goes to the ground handler, told whether it hit the map', () => {
  const h = harness();
  try {
    h.click(5);
    h.scene.under = 'flight:abc';
    h.click(6);
    assert.deepEqual(
      h.groundClicks.map(({ surface }) => surface),
      [true, false],
    );
    assert.equal(h.groundClicks[0].ground(), null, 'no ground in this scene');
  } finally {
    h.restore();
  }
});

test('a click on a part of a drawn line selects the sequence it belongs to', () => {
  const h = harness();
  try {
    h.scene.under = {
      set: 'street-level:mapillary-coverage:1',
      id: 'mly:seq:abc#2',
      meta: { pick: 'mly:seq:abc' },
    };
    h.click();
    assert.deepEqual(h.sequences.selects, ['abc']);
    // Another layer's set is not read for a Street Level pick.
    h.scene.under = {
      set: 'flights:1',
      id: 'flight:1',
      meta: { pick: 'mly:seq:xyz' },
    };
    h.click();
    assert.deepEqual(h.sequences.selects, ['abc']);
    assert.deepEqual(
      h.groundClicks.map(({ surface }) => surface),
      [false],
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
    sceneExtras: {
      pickPositionSupported: true,
      pickPosition: (position) => {
        groundPicks.push(position);
        return Cesium.Cartesian3.fromDegrees(-83.0458, 42.3314, 190);
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
    assert.deepEqual(
      groundPicks.map(({ x, y }) => ({ x, y })),
      [{ x: 40, y: 10 }],
    );
  } finally {
    h.restore();
  }
});

// An image found only through Street Level's own window (not the exact pick)
// under another layer's card or label is that card's click: its layer never
// sees this window.
test('an item found only in our window yields to a card painted over it', () => {
  let top = null;
  const h = harness({
    services: { overlayHit: () => top },
    sceneExtras: {
      pick: (_position, width = 3) =>
        width >= 9 ? { id: 'mly:img:near' } : null,
    },
  });
  try {
    h.click();
    assert.deepEqual(h.opened, ['near'], 'open map: the window finds it');
    top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
    h.click();
    assert.deepEqual(h.opened, ['near'], 'under a card: the card keeps it');
    assert.equal(h.groundClicks.length, 0);
  } finally {
    h.restore();
  }
});

// The map itself under another layer's card or label is that card's click:
// a ground click there must not also open the nearest street image.
test("a click on the map under another layer's card opens no ground image", () => {
  let top = null;
  const h = harness({ services: { overlayHit: () => top } });
  try {
    h.click();
    assert.equal(
      h.groundClicks.length,
      1,
      'open map: the ground handler decides',
    );
    top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
    h.click();
    assert.equal(h.groundClicks.length, 1, 'under a card: the card keeps it');
    assert.deepEqual(h.opened, []);
  } finally {
    h.restore();
  }
});

// A coarse tap's touch contact reaches farther than this window: on open map
// Street Level takes it; under another layer's card the card does.
test('a coarse touch contact beyond our window is ours to open, unless a card is on top', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  let top = { sourceId: 'earthquake-card', entryId: 'q' };
  const h = harness({
    services: { picking: pickRegistry, overlayHit: () => top },
    sceneExtras: {
      pick: () => null,
      drillPick: () => [{ id: 'mly:img:contact' }],
    },
  });
  try {
    h.click();
    assert.deepEqual(h.opened, [], 'under a card: the card keeps it');
    top = null;
    h.click();
    assert.deepEqual(h.opened, ['contact']);
    assert.equal(h.groundClicks.length, 0);
  } finally {
    h.restore();
  }
});

// The exact hit or the touch contact on our line part under another layer's
// card is that card's click; on open map it selects the sequence its part
// picks as.
test('an exact or contact hit on our line part acts only with no card on top', (t) => {
  const part = {
    set: 'street-level:mapillary-coverage:1',
    id: 'mly:seq:abc#2',
    meta: { pick: 'mly:seq:abc' },
  };
  let top = { sourceId: 'earthquake-card', entryId: 'q' };
  const card = () => top;
  const exact = harness({ services: { overlayHit: card } });
  try {
    exact.scene.under = part;
    exact.click();
    assert.deepEqual(exact.sequences.selects, [], 'under a card');
    top = null;
    exact.click();
    assert.deepEqual(exact.sequences.selects, ['abc'], 'mouse, exact part');
  } finally {
    top = { sourceId: 'earthquake-card', entryId: 'q' };
    exact.restore();
  }
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const contact = harness({
    services: { picking: pickRegistry, overlayHit: card },
    sceneExtras: {
      pick: (_position, width = 3) => (width >= 9 ? { id: part } : null),
      drillPick: () => [{ id: part }],
    },
  });
  try {
    contact.click();
    assert.deepEqual(contact.sequences.selects, [], 'coarse, under a card');
    top = null;
    contact.click();
    assert.deepEqual(contact.sequences.selects, ['abc'], 'coarse contact');
  } finally {
    contact.restore();
  }
});

// Our window catching another layer's item says nothing about our own touch
// contact beyond it: that contact is still ours.
test('a contact of ours acts even when our window finds another item', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const h = harness({
    services: { picking: pickRegistry },
    sceneExtras: {
      pick: (_position, width = 3) =>
        width >= 9 ? { id: { set: 'flights:1', id: 'flight:9' } } : null,
      drillPick: () => [{ id: 'mly:img:contact' }],
    },
  });
  try {
    h.click();
    assert.deepEqual(h.opened, ['contact']);
  } finally {
    h.restore();
  }
});

// Under another layer's card nothing of ours opens, whatever our window or the
// tap's touch contact names; on open map our window's item opens.
test('under a card, neither our window item nor our touch contact opens', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  let top = { sourceId: 'earthquake-card', entryId: 'q' };
  const h = harness({
    services: { picking: pickRegistry, overlayHit: () => top },
    sceneExtras: {
      pick: (_position, width = 3) =>
        width >= 9 ? { id: 'mly:img:window' } : null,
      drillPick: () => [{ id: 'mly:img:contact' }],
    },
  });
  try {
    h.click();
    assert.deepEqual(h.opened, []);
    assert.equal(h.groundClicks.length, 0);
    top = null;
    h.click();
    assert.deepEqual(h.opened, ['window']);
  } finally {
    h.restore();
  }
});
