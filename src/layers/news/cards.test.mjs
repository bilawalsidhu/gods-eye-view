import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CARDS, eventCard } from './cards.js';

const look = { severity: 3, category: 'strike', rim: 'confirmed', size: 20 };
const view = (extra = {}) => ({
  title: 'Strike on Kharkiv',
  meta: '10 min · 6 sources · UA, RU',
  image: 'https://a.test/p.jpg',
  credit: 'A',
  ...extra,
});

// Node has no canvas: a 2D context that accepts every call, and an Image that
// records what was asked for.
function fakeBrowser(t) {
  const saved = {
    document: globalThis.document,
    Path2D: globalThis.Path2D,
    Image: globalThis.Image,
  };
  const images = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'measureText'
          ? (text) => ({ width: String(text).length * 5 })
          : name === 'createLinearGradient'
            ? () => ({ addColorStop() {} })
            : () => {},
      set: () => true,
    },
  );
  let canvases = 0;
  globalThis.document = {
    createElement: () => {
      canvases++;
      return { getContext: () => ctx };
    },
  };
  globalThis.Path2D = class {};
  globalThis.Image = class {
    constructor() {
      images.push(this);
    }
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  return { images, canvases: () => canvases };
}

test('a card keeps one canvas per event while its age ticks', (t) => {
  const browser = fakeBrowser(t);
  const first = eventCard('ev-a', view(), look);
  assert.ok(first);
  // The meta line's minute-level age changes: the same canvas, repainted.
  const later = eventCard('ev-a', view({ meta: '11 min · 6 sources' }), look);
  assert.equal(later, first);
  assert.equal(browser.canvases(), 1);
  // One picture request for the event, however often it is drawn.
  assert.equal(browser.images.length, 1);
  // Its picture arriving repaints and asks for a frame once; a card with no
  // picture never does.
  let frames = 0;
  const pictured = eventCard(
    'ev-b',
    view({ image: 'https://b.test/p.jpg' }),
    look,
    () => frames++,
  );
  assert.ok(pictured);
  browser.images.at(-1).onload();
  assert.equal(frames, 1);
  assert.ok(eventCard('ev-c', view({ image: null }), look));
});

test('the card cache is bounded and evicts pictures with their cards', (t) => {
  const browser = fakeBrowser(t);
  const kept = eventCard('keep', view({ image: 'https://k.test/0.jpg' }), look);
  for (let i = 0; i < MAX_CARDS * 3; i++) {
    eventCard(`ev-${i}`, view({ image: `https://p.test/${i}.jpg` }), look);
    // A card drawn every frame stays: the least recently drawn goes first.
    assert.equal(
      eventCard('keep', view({ image: 'https://k.test/0.jpg' }), look),
      kept,
    );
  }
  const requested = browser.images.length;
  // The first event was evicted with its picture: drawing it again paints a
  // new canvas and asks for the picture anew.
  const again = eventCard(
    'ev-0',
    view({ image: 'https://p.test/0.jpg' }),
    look,
  );
  assert.ok(again);
  assert.equal(browser.images.length, requested + 1);
  // Evicted pictures are let go: their load handlers are cleared.
  assert.equal(browser.images[1].onload, null);
  // The recent ones are still cached.
  const recent = MAX_CARDS * 3 - 1;
  eventCard(
    `ev-${recent}`,
    view({ image: `https://p.test/${recent}.jpg` }),
    look,
  );
  assert.equal(browser.images.length, requested + 1);
});

test('without a canvas no card is made and nothing is cached', (t) => {
  fakeBrowser(t);
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  assert.equal(eventCard('none', view(), look), null);
  globalThis.document = undefined;
  assert.equal(eventCard('none', view(), look), null);
});
