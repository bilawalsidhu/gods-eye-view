import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESRI_TILE_URL,
  drawThumb,
  thumbLevel,
  tilePosition,
} from './thumbs.js';

/** Tiles as Esri would answer them, each request recorded. */
function fakeTiles(images = true) {
  const asked = [];
  return {
    asked,
    loadTile(url, tile) {
      asked.push({ url, ...tile });
      return Promise.resolve(images ? {} : null);
    },
  };
}

function fakeCanvas(t) {
  const drawn = [];
  const original = document.createElement.bind(document);
  t.mock.method(document, 'createElement', (name) => {
    const el = original(name);
    if (name === 'canvas') {
      el.getContext = () => ({
        fillRect() {},
        drawImage: (...args) => drawn.push(args),
      });
      el.toDataURL = () => 'data:image/jpeg;base64,AAAA';
    }
    return el;
  });
  return drawn;
}

test('a story’s range picks a zoom level within the imagery’s', () => {
  assert.equal(thumbLevel(1.6e7, { maxLevel: 10 }), 1);
  assert.equal(thumbLevel(160000, { maxLevel: 10 }), 8);
  assert.equal(thumbLevel(500, { maxLevel: 10 }), 10);
  assert.equal(thumbLevel(1), 19, 'Esri’s deepest level by default');
});

test('a place sits in the Web Mercator tile grid as the map draws it', () => {
  assert.deepEqual(tilePosition(0, 0, 1), { x: 1, y: 1 });
  const { x, y } = tilePosition(-180, 85.05112878, 3);
  assert.equal(x, 0);
  assert.ok(Math.abs(y) < 1e-6);
  const nepal = tilePosition(85.6, 28.05, 8);
  assert.equal(Math.floor(nepal.x), 188);
  assert.equal(Math.floor(nepal.y), 107);
});

test('a card is drawn from the 2 × 2 Esri tiles around the place', async (t) => {
  const drawn = fakeCanvas(t);
  const tiles = fakeTiles();
  const url = await drawThumb(
    { lat: 28.05, lon: 85.6, range: 160000 },
    { loadTile: tiles.loadTile },
  );
  assert.equal(url, 'data:image/jpeg;base64,AAAA');
  assert.equal(tiles.asked.length, 4);
  assert.ok(tiles.asked.every(({ level }) => level === 8));
  // Only Esri World Imagery's own tiles, as GEV's Esri map asks for them.
  for (const { url, x, y } of tiles.asked)
    assert.equal(
      url,
      ESRI_TILE_URL.replace('{z}', '8')
        .replace('{y}', String(y))
        .replace('{x}', String(x)),
    );
  assert.match(ESRI_TILE_URL, /^https:\/\/services\.arcgisonline\.com\//);
  assert.equal(drawn.length, 4);
});

test('no imagery, no card: the placeholder stays', async (t) => {
  fakeCanvas(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tiles = fakeTiles(false);
  const pending = drawThumb(
    { lat: 0, lon: 0, range: 1.6e7 },
    { loadTile: tiles.loadTile },
  );
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    t.mock.timers.tick(1000);
  }
  assert.equal(await pending, '');
  assert.equal(await drawThumb({}), '');
});
