import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGeojsonPins,
  loadMaki,
  pinCss,
  plainPin,
} from './geojsonPins.js';

/** A canvas whose context records what is drawn on it. */
function fakeCanvas(width, height) {
  const calls = [];
  const state = {};
  const context = {
    calls,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    scale: (...a) => calls.push(['scale', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: () => {},
    lineTo: () => {},
    bezierCurveTo: () => {},
    closePath: () => {},
    fill: () => calls.push(['fill', state.fillStyle]),
    stroke: () => calls.push(['stroke', state.strokeStyle, state.lineWidth]),
    fillRect: (...a) =>
      calls.push([
        'fillRect',
        state.globalCompositeOperation,
        state.fillStyle,
        ...a,
      ]),
    drawImage: (image, ...a) =>
      calls.push([
        'drawImage',
        state.globalCompositeOperation,
        image.tag,
        ...a,
      ]),
    fillText: (...a) => calls.push(['fillText', state.font, ...a]),
    measureText: (text) => ({
      width: text.length * 10,
      actualBoundingBoxAscent: 9.4,
      actualBoundingBoxDescent: 0.6,
      actualBoundingBoxLeft: 0,
    }),
  };
  for (const key of [
    'fillStyle',
    'strokeStyle',
    'lineWidth',
    'globalCompositeOperation',
    'font',
    'lineJoin',
    'imageSmoothingEnabled',
  ])
    Object.defineProperty(context, key, {
      get: () => state[key],
      set: (value) => (state[key] = value),
    });
  return { width, height, tag: 'canvas', getContext: () => context, context };
}

test('a pin with no symbol is the plain pin, in the marker colour outlined brighter', () => {
  const pins = createGeojsonPins({ makeCanvas: fakeCanvas });
  const pin = pins.pin({ color: [1, 0, 0, 1], size: 48 });
  assert.deepEqual(pin, plainPin([1, 0, 0, 1], 48));
  assert.match(pin.svg, /width="48" height="48"/);
  assert.match(pin.svg, /fill="rgba\(255,0,0,1\)"/);
  assert.match(pin.svg, /stroke="rgba\(255,153,153,1\)"/);
  assert.equal(pins.pin({ color: [1, 0, 0, 1], size: 48 }), pin, 'shared');
  assert.equal(pinCss([0, 0.5, 1, 0.3]), 'rgba(0,128,255,0.3)');
});

test('a single-character symbol is stamped on the pin as bold upper-case text', async () => {
  const made = [];
  const pins = createGeojsonPins({
    makeCanvas: (w, h) => {
      const canvas = fakeCanvas(w, h);
      made.push(canvas);
      return canvas;
    },
  });
  await pins.load(['a']);
  const pin = pins.pin({ color: [0, 0, 1, 1], size: 48, symbol: 'a' });
  assert.equal(typeof pin.key, 'string');
  assert.match(pin.key, /^geojson-pin:/);
  const [text, canvas] = made;
  assert.equal(pin.canvas, canvas);
  assert.deepEqual([canvas.width, canvas.height], [48, 48]);
  // The text canvas: just big enough for the text.
  assert.deepEqual([text.width, text.height], [10, 10]);
  assert.deepEqual(
    text.context.calls.find((c) => c[0] === 'fillText'),
    ['fillText', 'bold 48px sans-serif', 'A', 0, 9],
  );
  const calls = canvas.context.calls;
  assert.deepEqual(
    calls.find((c) => c[0] === 'scale'),
    ['scale', 2, 2],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'fill'),
    ['fill', 'rgb(0,0,255)'],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'stroke'),
    ['stroke', 'rgb(153,153,255)', 0.846],
  );
  // Stamped white with a black edge, centred on the pin's head: the text
  // is 10 wide in a 19.2 box, so it is drawn square at 19.2.
  const stamps = calls.filter(
    (c) => c[0] === 'drawImage' || c[0] === 'fillRect',
  );
  const x = Math.round((48 - 19.2) / 2);
  const y = Math.round((7 / 24) * 48 - 19.2 / 2);
  assert.deepEqual(stamps, [
    ['drawImage', 'destination-out', 'canvas', x - 1, y, 19.2, 19.2],
    ['drawImage', 'destination-out', 'canvas', x, y - 1, 19.2, 19.2],
    ['drawImage', 'destination-out', 'canvas', x + 1, y, 19.2, 19.2],
    ['drawImage', 'destination-out', 'canvas', x, y + 1, 19.2, 19.2],
    ['fillRect', 'destination-over', 'rgb(0,0,0)', x - 1, y - 1, 21.2, 21.2],
    ['drawImage', 'destination-out', 'canvas', x, y, 19.2, 19.2],
    [
      'fillRect',
      'destination-over',
      'rgb(255,255,255)',
      x - 1,
      y - 2,
      21.2,
      21.2,
    ],
  ]);
  assert.equal(
    pins.pin({ color: [0, 0, 1, 1], size: 48, symbol: 'a' }),
    pin,
    'one image per distinct marker',
  );
});

test('a longer symbol is that icon, loaded first; one that fails leaves the plain pin', async () => {
  const asked = [];
  const pins = createGeojsonPins({
    makeCanvas: fakeCanvas,
    loadIcon: async (id) => {
      asked.push(id);
      if (id === 'rail') return { width: 30, height: 15, tag: 'rail' };
      if (id === 'boom') throw new Error('boom');
      return null;
    },
  });
  await pins.load(['rail', 'nope', 'boom', 'x', 7, null, undefined, 'rail']);
  assert.deepEqual(asked.sort(), ['7', 'boom', 'nope', 'rail']);
  const rail = pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: 'rail' });
  const draws = rail.canvas.context.calls.filter((c) => c[0] === 'drawImage');
  // Wider than high: its height is scaled down.
  assert.deepEqual(draws.at(-1), [
    'drawImage',
    'destination-out',
    'rail',
    7,
    5,
    9.6,
    4.8,
  ]);
  for (const symbol of ['nope', 'boom', 7])
    assert.deepEqual(
      pins.pin({ color: [1, 1, 1, 1], size: 24, symbol }),
      plainPin([1, 1, 1, 1], 24),
    );
  // Loaded again, a known icon is not fetched again.
  await pins.load(['rail']);
  assert.equal(asked.length, 4);
});

test('without a page to draw on, every pin is plain', async () => {
  const pins = createGeojsonPins({ loadIcon: () => assert.fail('no load') });
  await pins.load(['rail']);
  assert.deepEqual(
    pins.pin({ color: [1, 1, 1, 1], size: 8, symbol: 'a' }),
    plainPin([1, 1, 1, 1], 8),
  );
});

test('a number is an icon id and a character is text, each pinned apart; text by its upper case', async () => {
  const loaded = [];
  const pins = createGeojsonPins({
    makeCanvas: fakeCanvas,
    loadIcon: async (id) => (loaded.push(id), { width: 4, height: 4, tag: id }),
  });
  await pins.load([7, '7', 'a', 'A']);
  assert.deepEqual(loaded, ['7']);
  const icon = pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: 7 });
  const text = pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: '7' });
  assert.notEqual(icon, text);
  assert.notEqual(icon.key, text.key);
  assert.equal(
    pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: 'a' }),
    pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: 'A' }),
  );
});

test('an aborted icon load is asked again later; a failing loader leaves the plain pin', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pins = createGeojsonPins({
    makeCanvas: fakeCanvas,
    loadIcon: (id) => {
      calls += 1;
      if (id === 'sync') throw new Error('sync');
      controller.abort();
      return Promise.resolve(null);
    },
  });
  await pins.load(['rail'], { signal: controller.signal });
  await pins.load(['rail']);
  assert.equal(calls, 2);
  await pins.load(['sync']);
  assert.deepEqual(
    pins.pin({ color: [1, 1, 1, 1], size: 24, symbol: 'sync' }),
    plainPin([1, 1, 1, 1], 24),
  );
});

test('icons come from the renderer’s assets: its base global, else its script’s folder', async (t) => {
  const saved = {
    document: globalThis.document,
    base: globalThis.CESIUM_BASE_URL,
    bitmap: globalThis.createImageBitmap,
    fetch: globalThis.fetch,
  };
  t.after(() => {
    for (const [key, name] of [
      ['document', 'document'],
      ['base', 'CESIUM_BASE_URL'],
      ['bitmap', 'createImageBitmap'],
      ['fetch', 'fetch'],
    ])
      if (saved[key] === undefined) delete globalThis[name];
      else globalThis[name] = saved[key];
  });
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, blob: async () => 'png' };
  };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1 });
  const scripts = [];
  globalThis.document = {
    baseURI: 'http://gev.test/app/',
    getElementsByTagName: () =>
      scripts.map((src) => ({ getAttribute: () => src })),
  };
  globalThis.CESIUM_BASE_URL = '/assets/cesium';
  assert.ok(await loadMaki('rail'));
  delete globalThis.CESIUM_BASE_URL;
  scripts.push('/other.js', 'lib/Cesium.js?v=1');
  assert.ok(await loadMaki('a b'));
  scripts.length = 0;
  scripts.push('Cesium.js');
  assert.ok(await loadMaki('dam'));
  scripts.length = 0;
  assert.equal(await loadMaki('rail'), null, 'nothing says where');
  assert.deepEqual(asked, [
    'http://gev.test/assets/cesium/Assets/Textures/maki/rail.png',
    'http://gev.test/app/lib/Assets/Textures/maki/a%20b.png',
    'http://gev.test/app/Assets/Textures/maki/dam.png',
  ]);
});
