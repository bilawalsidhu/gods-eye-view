// The card's maps drawn from OpenFreeMap's vector tiles: the dark style,
// the tile kept through the shared owner, the renderer painting
// land, water and roads from a fixture tile, the close-up map and pins
// drawing with it, its credit, and teardown. Over happy-dom, with a
// recording 2D context and a tile source that reads fixture tiles.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { encodeVectorTile } from '../render/conformance/vectorTileFixture.js';
import {
  CARD_MAP_COLOURS,
  CARD_MAP_LABELS,
  cardMapStyle,
} from './cardMapStyle.js';
import {
  CARD_MAP_EXTENT,
  projectCardMapTile,
} from '../sources/openFreeMapCardMap.js';
import { cardMapLayout, drawCardMap, setCardMapSource } from './cardMap.js';
import {
  collectLabels,
  isRightToLeft,
  labelName,
  nameKeys,
  placeLabels,
} from './cardMapLabels.js';
import { pinMap, legacyPinMap } from './mapTiles.js';
import {
  OPENFREEMAP_CARD_CREDIT,
  OPENFREEMAP_CARD_CREDIT_FULL,
} from '../maps/attribution.js';
import { OPENMAPTILES_CREDIT, OSM_CREDIT } from '../data/dataCredits.js';
import CloseUpMap from './views/panels/CloseUpMap.vue';
import CardMapCanvas from './views/panels/CardMapCanvas.vue';
import PinnedGrid from './views/panels/PinnedGrid.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePinnedStore } from './stores/pinned.js';
import { getLocale, setLocale } from '../i18n/index.js';
import { HERO_AUTOPLAY_MS, HERO_READY_WAIT_MS } from './entityHeroViews.js';
import EntityPreview from './views/panels/EntityPreview.vue';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const luminance = (css) => {
  const [r, g, b] = css.startsWith('#')
    ? css
        .slice(1)
        .match(/../g)
        .map((channel) => parseInt(channel, 16))
    : css.match(/[\d.]+/g).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('dark: near-black land, dark water, bright roads lighter and thicker the more major, muted parks and buildings', () => {
  const c = CARD_MAP_COLOURS;
  assert.ok(luminance(c.land) < 15, 'near-black land');
  assert.ok(
    luminance(c.water) < 40 && luminance(c.water) > luminance(c.land),
    'dark water, set apart from the land',
  );
  for (const muted of [c.green, c.building])
    assert.ok(luminance(muted) < 40, `${muted} muted`);
  const order = [
    'path',
    'service',
    'minor',
    'tertiary',
    'secondary',
    'primary',
    'motorway',
  ];
  const lights = order.map((name) => luminance(c.roads[name]));
  assert.deepEqual(
    [...lights].sort((a, b) => a - b),
    lights,
    'lighter the more major',
  );
  assert.ok(lights.at(-1) > 220, 'major roads bright');
  const layers = cardMapStyle().layers;
  const at14 = (id) => layers.find((l) => l.id === id).width;
  const widths = order.map((name) => at14(`road-${name}`));
  assert.deepEqual(
    [...widths].sort((a, b) => a - b),
    widths,
    'thicker the more major',
  );
  // Major roads carry a soft halo under them; minor ones do not.
  assert.ok(layers.some((l) => l.id === 'road-motorway-glow'));
  assert.ok(!layers.some((l) => l.id === 'road-minor-glow'));
  assert.ok(
    layers.findIndex((l) => l.id === 'road-motorway') >
      layers.findIndex((l) => l.id === 'road-minor'),
    'major roads over minor ones',
  );
});

test('names are not left to the tiles: the style draws the ground, the label table sets names by rank', () => {
  assert.deepEqual(
    new Set(cardMapStyle().layers.map((l) => l.type)),
    new Set([2, 3]),
  );
  const { places, roads, water } = CARD_MAP_LABELS;
  const order = ['city', 'town', 'village', 'suburb'];
  const ranks = order.map((c) => places[c].priority);
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    ranks,
  );
  const sizes = order.map((c) => places[c].size);
  assert.deepEqual(
    [...sizes].sort((a, b) => b - a),
    sizes,
    'larger the higher',
  );
  assert.ok(places.neighbourhood.priority > places.suburb.priority);
  assert.ok(roads.priority > places.neighbourhood.priority);
  assert.deepEqual(roads.classes, [
    'motorway',
    'trunk',
    'primary',
    'secondary',
  ]);
  assert.ok(water.priority > roads.priority);
  // A system font stack covering every script; nothing loaded.
  for (const family of [
    'system-ui',
    'Hiragino Sans',
    'Noto Sans Arabic',
    'Noto Sans Hebrew',
    'Noto Sans Devanagari',
    'Noto Sans Thai',
    'sans-serif',
  ])
    assert.ok(CARD_MAP_LABELS.font.includes(family), family);
  assert.doesNotMatch(CARD_MAP_LABELS.font, /url\(|https?:/);
  // Light names on a dark halo.
  assert.ok(luminance(CARD_MAP_COLOURS.names) > 200);
  assert.ok(luminance(CARD_MAP_COLOURS.nameHalo) < 20);
});

test('sizes are CSS pixels at card zooms whatever the device scale', () => {
  for (const [zoom, width] of [
    [11, 1.6],
    [14, 4],
    [16, 8],
  ]) {
    for (const scale of [1, 2]) {
      const layer = cardMapStyle({ zoom, scale }).layers.find(
        (l) => l.id === 'road-motorway',
      );
      assert.equal(layer.width, width * scale);
    }
  }
});

const square = (x0, y0, x1, y1) => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ],
];
/** A z14 tile: land, a lake, a park, a building, a motorway, a minor road, a place and a footpath it drops nothing of. */
function fixtureBytes() {
  return encodeVectorTile({
    water: [
      {
        type: 'Polygon',
        geometry: square(0, 0, 2048, 1024),
        properties: { class: 'lake', name: 'Lake' },
      },
    ],
    park: [
      {
        type: 'Polygon',
        geometry: square(2200, 2200, 3000, 3000),
        properties: { class: 'park' },
      },
    ],
    building: [
      {
        type: 'Polygon',
        geometry: square(100, 3000, 300, 3200),
        properties: { render_height: 12 },
      },
    ],
    transportation: [
      {
        type: 'LineString',
        geometry: [
          [
            [0, 2048],
            [4096, 2048],
          ],
        ],
        properties: { class: 'motorway' },
      },
      {
        type: 'LineString',
        geometry: [
          [
            [2048, 0],
            [2048, 1],
            [2048, 4096],
          ],
        ],
        properties: { class: 'minor', brunnel: 'bridge', surface: 'paved' },
      },
    ],
    place: [
      {
        type: 'Point',
        geometry: [[[1024, 3000]]],
        properties: {
          class: 'suburb',
          name: 'Midtown',
          'name:fr': 'Centre',
          'name:zh-CN': '市中心',
          rank: 9,
          population: 1000,
        },
      },
    ],
    transportation_name: [
      {
        type: 'LineString',
        geometry: [
          [
            [0, 2048],
            [4096, 2048],
          ],
        ],
        properties: { class: 'motorway', name: 'Ring Road', ref: 'A1' },
      },
    ],
    housenumber: [
      {
        type: 'Point',
        geometry: [[[10, 10]]],
        properties: { housenumber: '1' },
      },
    ],
  });
}
const parse = (bytes) => new VectorTile(new PbfReader(bytes));

test('card map decode budgets count raw vertices before rounding and preserve complete features', () => {
  const line = (count, name) => ({
    type: 'LineString',
    properties: { class: name },
    // Most points round to the same grid coordinate.
    geometry: [
      Array.from({ length: count }, (_, i) => [
        i === count - 1 ? 16 : i % 2,
        0,
      ]),
    ],
  });
  const features = [
    line(20_000, 'oversize'),
    ...Array.from({ length: 12 }, () => line(10_000, 'street')),
  ];
  const tile = parse(encodeVectorTile({ transportation: features }));
  const layer = tile.layers.transportation;
  const read = layer.feature.bind(layer);
  let decoded = 0;
  layer.feature = (index) => {
    const feature = read(index);
    const load = feature.loadGeometry.bind(feature);
    feature.loadGeometry = () => {
      assert.notEqual(
        index,
        0,
        'the oversized feature is skipped before allocating its geometry',
      );
      decoded++;
      return load();
    };
    return feature;
  };
  const kept = projectCardMapTile(null, 14, 0, 0, tile);
  assert.ok(
    decoded > 0 && decoded < 12,
    'the tile budget limits total raw work',
  );
  assert.equal(kept.layers.transportation.length, decoded);
  assert.deepEqual(kept.layers.transportation[0].parts, [[0, 0, 4, 0]]);
});

test('tile projection bounds localized place names without splitting a character', () => {
  const prefix = 'a'.repeat(127);
  const bytes = encodeVectorTile({
    place: [
      {
        type: 'Point',
        geometry: [[[0, 0]]],
        properties: { name: 'Park', 'name:en': prefix + '🌳 Park' },
      },
    ],
  });
  const kept = projectCardMapTile(null, 14, 0, 0, parse(bytes));
  assert.deepEqual(kept.layers.place[0].properties, {
    name: 'Park',
    'name:en': prefix,
  });
});

test('a tile is kept small and plain: drawn layers and properties, a coarse grid, no repeated points', () => {
  const kept = projectCardMapTile(null, 14, 0, 0, parse(fixtureBytes()));
  assert.equal(kept.extent, CARD_MAP_EXTENT);
  assert.deepEqual(Object.keys(kept.layers).sort(), [
    'building',
    'park',
    'place',
    'transportation',
    'transportation_name',
    'water',
  ]);
  assert.deepEqual(
    kept.layers.place[0].properties,
    {
      class: 'suburb',
      rank: 9,
      name: 'Midtown',
      'name:fr': 'Centre',
      'name:zh-CN': '市中心',
    },
    'the names in every offered language, not what is not drawn',
  );
  assert.equal(
    kept.layers.housenumber,
    undefined,
    'a layer the map does not draw is left out',
  );
  assert.deepEqual(
    kept.layers.water[0].properties,
    { class: 'lake' },
    'only what is drawn',
  );
  assert.deepEqual(kept.layers.transportation[1].properties, {
    class: 'minor',
    brunnel: 'bridge',
  });
  assert.deepEqual(
    kept.layers.water[0].parts[0],
    [0, 0, 512, 0, 512, 256, 0, 256, 0, 0],
  );
  assert.deepEqual(
    kept.layers.transportation[1].parts[0],
    [512, 0, 512, 1024],
    'a point rounding onto the last is dropped',
  );
  assert.deepEqual(
    structuredClone(kept),
    kept,
    'plain data, as the shared owner hands consumers a copy',
  );
});

/** Records every 2D call of every canvas made in the page. */
function recordCanvases(t) {
  const contexts = new WeakMap();
  const all = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext() {
    let ctx = contexts.get(this);
    if (!ctx) {
      const calls = [];
      ctx = new Proxy(
        {
          measureText: (text) => ({ width: text.length * 6 }),
          calls,
          canvas: this,
        },
        {
          get(target, key) {
            if (key in target) return target[key];
            return (...args) => calls.push([key, ...args]);
          },
          set(target, key, value) {
            calls.push([`=${String(key)}`, value]);
            return true;
          },
        },
      );
      contexts.set(this, ctx);
      all.push(ctx);
    }
    return ctx;
  };
  t.after(() => {
    HTMLCanvasElement.prototype.getContext = original;
  });
  return all;
}

/** A tile source over fixture tiles, as the shared OpenFreeMap one answers. */
function fixtureSource(
  t,
  { fail = false, partial = false, hold = false } = {},
) {
  const asked = [];
  const signals = [];
  const source = {
    asked,
    signals,
    async fetchBounds(box, { zoom, tiles, signal, onTile }) {
      asked.push({ box, zoom, tiles });
      signals.push(signal);
      if (hold)
        await new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      if (fail) throw new Error('tiles.openfreemap.org answered 503');
      const loadedTiles = partial ? tiles.slice(0, 1) : tiles;
      for (const tile of loadedTiles) {
        const kept = projectCardMapTile(
          null,
          tile.z,
          tile.x,
          tile.y,
          parse(fixtureBytes()),
        );
        onTile(structuredClone(kept), tile);
      }
      return { tiles: [], loadedTiles, partial };
    },
  };
  t.after(setCardMapSource(source));
  return source;
}

test('the layout: the 3 by 3 block round the spot, or the tiles a frame shows', () => {
  const block = cardMapLayout(48.8584, 2.2945, 14);
  assert.equal(block.tiles.length, 9);
  assert.equal(block.width, 768);
  assert.equal(block.height, 768);
  assert.ok(block.left <= -256 && block.left > -512);
  const framed = cardMapLayout(48.8584, 2.2945, 13, {
    width: 256,
    height: 160,
  });
  assert.deepEqual(
    [framed.left, framed.top, framed.width, framed.height],
    [-128, -80, 256, 160],
  );
  assert.ok(framed.tiles.length >= 1 && framed.tiles.length <= 4);
  for (const tile of framed.tiles) {
    assert.ok(tile.left < 128 && tile.left + 256 > -128);
    assert.ok(tile.top < 80 && tile.top + 256 > -80);
  }
  assert.deepEqual(cardMapLayout(NaN, 0, 12).tiles, []);
});

test('the toner renderer paints the reference palette and keeps the same vector source', async (t) => {
  const contexts = recordCanvases(t);
  fixtureSource(t);
  await drawCardMap(document.createElement('canvas'), {
    lat: 30.2672,
    lon: -97.7431,
    zoom: 14,
    theme: 'toner',
  }).done;
  const [shown, scratch] = contexts;
  assert.deepEqual(shown.calls[0], ['=fillStyle', '#ffffff']);
  assert.ok(
    scratch.calls.some(
      ([key, value]) => key === '=strokeStyle' && value === '#000000',
    ),
  );
});

test('the renderer paints land, water and roads from the tile, each tile once, and asks nothing of the network', async (t) => {
  const contexts = recordCanvases(t);
  const source = fixtureSource(t);
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error('no network in this test');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const canvas = document.createElement('canvas');
  const states = [];
  const map = drawCardMap(canvas, {
    lat: 30.2672,
    lon: -97.7431,
    zoom: 14,
    onState: (s) => states.push(s),
  });
  await map.done;
  assert.deepEqual(states, ['loading', 'ready']);
  assert.deepEqual(fetched, [], 'no request but through the tile source');
  assert.equal(source.asked.length, 1, 'one ask for the block');
  assert.equal(source.asked[0].zoom, 14);
  assert.equal(source.asked[0].tiles.length, 9);
  assert.equal(canvas.width, 768);
  const [shown, scratch] = contexts;
  const c = CARD_MAP_COLOURS;
  // The land first, across the whole canvas, before any tile.
  assert.deepEqual(shown.calls.slice(0, 2), [
    ['=fillStyle', c.land],
    ['fillRect', 0, 0, 768, 768],
  ]);
  assert.equal(
    shown.calls.filter(([k]) => k === 'drawImage').length,
    9,
    'each tile drawn once',
  );
  const fills = scratch.calls
    .filter(([k]) => k === '=fillStyle')
    .map(([, v]) => v);
  const strokes = scratch.calls
    .filter(([k]) => k === '=strokeStyle')
    .map(([, v]) => v);
  assert.ok(fills.includes(c.land), 'land');
  assert.ok(fills.includes(c.water), 'water');
  assert.ok(fills.includes(c.green), 'the park');
  assert.ok(fills.includes(c.building), 'the building');
  assert.ok(strokes.includes(c.roads.motorway), 'the motorway');
  assert.ok(strokes.includes(c.roads.minor), 'the minor road');
  const names = shown.calls
    .filter(([k]) => k === 'fillText')
    .map(([, text]) => text);
  assert.ok(names.includes('Midtown'), 'the place name, over the whole map');
  assert.ok(names.includes('Ring Road'), 'the major road name');
  assert.equal(names.filter((n) => n === 'Midtown').length, 1, 'once');
  assert.equal(
    scratch.calls.filter(([k]) => k === 'fillText').length,
    0,
    'no names drawn per tile',
  );
  assert.equal(
    scratch.canvas.width,
    0,
    'the working canvas is freed once drawn',
  );
});

test('past zoom 14 a tile is drawn from the one over it, read once', async (t) => {
  const contexts = recordCanvases(t);
  const source = fixtureSource(t);
  const map = drawCardMap(document.createElement('canvas'), {
    lat: 30.2672,
    lon: -97.7431,
    zoom: 16,
  });
  await map.done;
  const [{ zoom, tiles }] = source.asked;
  assert.equal(zoom, 14);
  assert.ok(
    tiles.length >= 1 && tiles.length <= 4,
    `${tiles.length} parent tiles`,
  );
  assert.equal(new Set(tiles.map((p) => `${p.x}/${p.y}`)).size, tiles.length);
  const starts = new Set(
    contexts[1].calls
      .filter(([op]) => op === 'moveTo')
      .map(([, x, y]) => `${x},${y}`),
  );
  for (const tile of cardMapLayout(30.2672, -97.7431, 16).tiles) {
    // The lake starts at the parent origin. Each z16 child crops its quadrant.
    assert.ok(starts.has(`${-(tile.x % 4) * 256},${-(tile.y % 4) * 256}`));
  }
});

test('tiles that cannot be read leave the plain land, and say so', async (t) => {
  const contexts = recordCanvases(t);
  fixtureSource(t, { fail: true });
  const states = [];
  const map = drawCardMap(document.createElement('canvas'), {
    lat: 10,
    lon: 20,
    zoom: 12,
    onState: (s) => states.push(s),
  });
  await map.done;
  assert.deepEqual(states, ['loading', 'failed']);
  assert.equal(contexts[0].calls.filter(([k]) => k === 'drawImage').length, 0);
  assert.deepEqual(contexts[0].calls.slice(0, 2), [
    ['=fillStyle', CARD_MAP_COLOURS.land],
    ['fillRect', 0, 0, 768, 768],
  ]);
});

test('without a 2D context nothing is asked for', async (t) => {
  const source = fixtureSource(t);
  const states = [];
  // happy-dom's canvas has no context.
  await drawCardMap(document.createElement('canvas'), {
    lat: 10,
    lon: 20,
    zoom: 12,
    onState: (s) => states.push(s),
  }).done;
  assert.deepEqual(states, ['failed']);
  assert.equal(source.asked.length, 0);
});

function mount(t, component, props, { pinia } = {}) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({ render: () => h(component, props) });
  if (pinia) app.use(pinia);
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) app.unmount();
    mounted = false;
  };
  t.after(unmount);
  return {
    host,
    unmount,
    $$: (selector) => [...host.querySelectorAll(selector)],
  };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test('the close-up map draws with the vector renderer, credits OpenStreetMap and OpenMapTiles, and asks Esri for nothing', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t);
  const { $$ } = mount(t, CloseUpMap, {
    lat: 48.8584,
    lon: 2.2945,
    icon: 'place',
    card: { layerId: 'place', kind: 'place', title: 'Eiffel Tower' },
  });
  await settle();
  const [canvas] = $$('.close-up-map__canvas');
  assert.ok(canvas.classList.contains('card-map'));
  assert.equal(canvas.tagName, 'CANVAS');
  assert.equal(canvas.dataset.state, 'ready');
  assert.deepEqual(canvas.getContext('2d').calls[0], [
    '=fillStyle',
    CARD_MAP_COLOURS.land,
  ]);
  assert.equal(canvas.getAttribute('aria-hidden'), 'true');
  assert.match(
    canvas.getAttribute('style'),
    /width: 768px; height: 768px; transform: translate\(-?\d+px, -?\d+px\)/,
  );
  assert.equal(source.asked[0].zoom, 14, 'a place at its own zoom');
  assert.equal($$('img').length, 0, 'no tile images');
  const markup = document.body.innerHTML;
  assert.doesNotMatch(markup, /arcgisonline|World_Imagery|Esri/i);
  const [credit] = $$('.close-up-map__credit');
  assert.match(credit.textContent, /© OpenStreetMap contributors/);
  assert.match(credit.textContent, /© OpenMapTiles/);
  assert.equal(credit.getAttribute('title'), OPENFREEMAP_CARD_CREDIT_FULL);
  assert.equal(
    credit.querySelector('bdi')?.getAttribute('dir'),
    'ltr',
    'its © stays in front in a right-to-left page',
  );
  assert.equal(credit.closest('[aria-hidden="true"]'), null, 'read out');
  assert.match($$('.close-up-map__label')[0].textContent, /^Eiffel Tower$/);
});

test('the credit shows while the tiles load and when they fail', async (t) => {
  recordCanvases(t);
  fixtureSource(t, { fail: true });
  const { $$ } = mount(t, CloseUpMap, { lat: 10, lon: 20, card: null });
  await settle();
  assert.equal($$('.card-map')[0].dataset.state, 'failed');
  assert.equal(
    $$('.close-up-map__credit')[0].textContent,
    OPENFREEMAP_CARD_CREDIT,
  );
});

test('taken down, a map stops its requests and frees its canvas', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t, { hold: true });
  const { $$, unmount } = mount(t, CardMapCanvas, {
    lat: 30.27,
    lon: -97.74,
    zoom: 12,
  });
  await settle();
  const [canvas] = $$('canvas');
  assert.equal(canvas.dataset.state, 'loading');
  assert.equal(canvas.width, 768);
  const [signal] = source.signals;
  assert.equal(signal.aborted, false);
  unmount();
  assert.equal(signal.aborted, true, 'its requests stopped');
  assert.equal(canvas.width, 0, 'its canvas freed');
  assert.equal(canvas.height, 0);
});

test('a moved spot stops the last drawing before the next', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t, { hold: true });
  const props = reactive({ lat: 30.27, lon: -97.74, zoom: 12 });
  mount(t, CardMapCanvas, props);
  await settle();
  props.lat = 31;
  await settle();
  assert.equal(source.signals.length, 2);
  assert.equal(source.signals[0].aborted, true);
  assert.equal(source.signals[1].aborted, false);
});

function fakeIntersections(t) {
  const watched = [];
  const hadOwn = Object.hasOwn(globalThis, 'IntersectionObserver');
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      watched.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  t.after(() => {
    if (hadOwn) globalThis.IntersectionObserver = previous;
    else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  });
  return (isIntersecting) => {
    for (const observer of watched)
      observer.callback([{ target: observer.target, isIntersecting }]);
  };
}

test('a lazy map reads no tiles until it is in view, and stops loading when it leaves', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t, { hold: true });
  const show = fakeIntersections(t);
  const { $$ } = mount(t, CardMapCanvas, {
    lat: 30.27,
    lon: -97.74,
    zoom: 12,
    frame: { width: 160, height: 90 },
    lazy: true,
  });
  await settle();
  assert.equal(source.signals.length, 0, 'out of view: nothing asked for');
  show(true);
  await settle();
  assert.equal(source.signals.length, 1, 'in view: it draws');
  show(false);
  await settle();
  assert.equal(source.signals[0].aborted, true, 'left while loading: stopped');
  show(true);
  await settle();
  assert.equal(source.signals.length, 2, 'back in view: it draws again');
  assert.equal(source.signals[1].aborted, false);
  assert.equal($$('canvas')[0].dataset.state, 'loading');
});

test('a map hidden while it loads stops its requests, and draws again when shown', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t, { hold: true });
  const props = reactive({ lat: 30.27, lon: -97.74, zoom: 12, active: true });
  mount(t, CardMapCanvas, props);
  await settle();
  props.active = false;
  await settle();
  assert.equal(source.signals[0].aborted, true);
  props.active = true;
  await settle();
  assert.equal(source.signals.length, 2);
  assert.equal(source.signals[1].aborted, false);
});

test('pinned map stills draw only once in view', () => {
  const grid = read('./views/panels/PinnedGrid.vue');
  assert.match(grid, /<CardMapCanvas[^>]*\slazy\b/);
});

test('a finished map stays shown while it redraws, then the new one is copied over at once', async (t) => {
  recordCanvases(t);
  fixtureSource(t);
  const props = reactive({ lat: 30.27, lon: -97.74, zoom: 12 });
  const { $$ } = mount(t, CardMapCanvas, props);
  await settle();
  const [canvas] = $$('canvas');
  assert.equal(canvas.dataset.state, 'ready');
  const shown = canvas.getContext('2d');
  const before = shown.calls.length;
  const width = canvas.width;

  const held = fixtureSource(t, { hold: true });
  props.lat = 30.3;
  await settle();
  assert.equal(held.signals.length, 1, 'the redraw has started');
  assert.equal(canvas.width, width, 'the shown map is not cleared');
  assert.equal(shown.calls.length, before, 'nothing is painted on it yet');

  fixtureSource(t);
  props.lat = 30.31;
  await settle();
  assert.equal(canvas.dataset.state, 'ready');
  const copied = shown.calls
    .slice(before)
    .filter(([operation]) => operation === 'drawImage');
  assert.equal(copied.length, 1, 'the finished redraw is copied in one step');
  assert.deepEqual(copied[0].slice(2), [0, 0]);
});

test('a redraw that cannot read its tiles leaves the finished map on screen, and says it failed', async (t) => {
  recordCanvases(t);
  fixtureSource(t);
  const props = reactive({ lat: 30.27, lon: -97.74, zoom: 12 });
  const { $$ } = mount(t, CardMapCanvas, props);
  await settle();
  const [canvas] = $$('canvas');
  assert.equal(canvas.dataset.state, 'ready');
  const shown = canvas.getContext('2d');
  const before = shown.calls.length;
  const width = canvas.width;

  fixtureSource(t, { fail: true });
  props.lat = 30.3;
  await settle();
  assert.equal(canvas.width, width, 'not cleared');
  assert.equal(shown.calls.length, before, 'nothing painted over it');
  assert.equal(canvas.dataset.state, 'failed', 'the redraw says it failed');
});

test('a partial redraw holds the finished map and retries when reopened', async (t) => {
  recordCanvases(t);
  fixtureSource(t);
  const props = reactive({ lat: 30.27, lon: -97.74, zoom: 12, active: true });
  const { $$ } = mount(t, CardMapCanvas, props);
  await settle();
  const [canvas] = $$('canvas');
  assert.equal(canvas.dataset.state, 'ready');
  const shown = canvas.getContext('2d');
  const before = shown.calls.length;

  const partial = fixtureSource(t, { partial: true });
  props.lat = 30.3;
  await settle();
  assert.ok(partial.asked[0].tiles.length > 1);
  assert.equal(canvas.dataset.state, 'failed');
  assert.equal(shown.calls.length, before);
  props.active = false;
  await settle();
  const complete = fixtureSource(t);
  props.active = true;
  await settle();
  assert.equal(complete.asked.length, 1);
  assert.equal(canvas.dataset.state, 'ready');
  assert.ok(shown.calls.length > before);
});

// Names set on any canvas, the shown one or a redraw painted aside.
const namesOn = (contexts) =>
  contexts.flatMap((ctx) =>
    ctx.calls
      .filter(([operation]) => operation === 'fillText')
      .map(([, label]) => label),
  );
const drawnNames = (canvas) =>
  canvas
    .getContext('2d')
    .calls.filter(([operation]) => operation === 'fillText')
    .map(([, label]) => label);

test('a ready vector map gets the normal Play dwell and an unavailable map uses the timeout', async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? 'unavailable map' : 'ready map', async (t) => {
      recordCanvases(t);
      fixtureSource(t, { fail });
      const { $$ } = mount(
        t,
        EntityPreview,
        {
          card: {
            key: 'flights:synthetic',
            layerId: 'flights',
            kind: 'aircraft',
            identity: { layerId: 'flights', id: 'synthetic' },
            title: 'Synthetic flight',
            icon: 'flight',
            lat: 30.27,
            lon: -97.74,
            altitudeM: 11_000,
            photo: { src: '/fixture-plane.png' },
          },
          title: 'Synthetic flight',
        },
        { pinia: createPinia() },
      );
      await settle();
      $$('.entity-card__preview-switch [aria-label="Map"]')[0].click();
      await settle();
      assert.equal($$('.card-map')[0].dataset.state, fail ? 'failed' : 'ready');

      const shown = () =>
        $$('.entity-card__preview-switch button.active').map(
          (button) =>
            button.getAttribute('aria-label') || button.textContent.trim(),
        );
      t.mock.timers.enable({ apis: ['setTimeout'] });
      $$('.entity-card__preview-play')[0].click();
      await nextTick();
      assert.deepEqual(shown(), ['Map']);
      t.mock.timers.tick(HERO_AUTOPLAY_MS);
      await nextTick();
      assert.deepEqual(shown(), fail ? ['Map'] : ['Photos']);
      if (fail) {
        t.mock.timers.tick(HERO_READY_WAIT_MS - HERO_AUTOPLAY_MS);
        await nextTick();
        assert.deepEqual(shown(), ['Photos']);
      }
    });
  }
});

test('a moving flight keeps its Map deadline while a fresh Map turn waits for its draw', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t);
  const props = reactive({
    title: 'Synthetic moving flight',
    card: {
      key: 'flights:moving',
      layerId: 'flights',
      kind: 'aircraft',
      identity: { layerId: 'flights', id: 'moving' },
      title: 'Synthetic moving flight',
      icon: 'flight',
      lat: 30.27,
      lon: -97.74,
      altitudeM: 11_000,
      photo: { src: '/fixture-plane.png' },
    },
  });
  const { $$ } = mount(t, EntityPreview, props, { pinia: createPinia() });
  const chooseMap = () =>
    $$('.entity-card__preview-switch [aria-label="Map"]')[0].click();
  const play = () => $$('.entity-card__preview-play')[0].click();
  const shown = () =>
    $$('.entity-card__preview-switch button.active')[0]?.getAttribute(
      'aria-label',
    );
  const flush = async () => {
    await nextTick();
    await new Promise(setImmediate);
    await nextTick();
  };
  chooseMap();
  await settle();
  const [canvas] = $$('.card-map');
  assert.equal(canvas.dataset.state, 'ready');
  const initialRequests = source.asked.length;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  play();
  await nextTick();
  t.mock.timers.tick(4000);
  props.card.lon += 0.011;
  await flush();
  assert.equal(source.asked.length, initialRequests + 1);
  assert.equal(canvas.dataset.state, 'ready');
  t.mock.timers.tick(HERO_AUTOPLAY_MS - 4000 - 1);
  await nextTick();
  assert.equal(shown(), 'Map');
  t.mock.timers.tick(1);
  await nextTick();
  assert.equal(shown(), 'Photos', 'the same-turn redraw keeps the deadline');

  chooseMap();
  await flush();
  assert.equal(
    source.asked.length,
    initialRequests + 1,
    'same frame on return',
  );
  play();
  await nextTick();
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await nextTick();
  assert.equal(shown(), 'Photos', 'the held ready frame gets a fresh dwell');

  // A new view of the map is unavailable after the aircraft moves again.
  props.card.lon += 0.011;
  source.fetchBounds = async () => {
    throw new Error('fixture tiles unavailable');
  };
  chooseMap();
  await flush();
  assert.equal(canvas.dataset.state, 'failed');
  play();
  await nextTick();
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await nextTick();
  assert.equal(shown(), 'Map');
  t.mock.timers.tick(HERO_READY_WAIT_MS - HERO_AUTOPLAY_MS);
  await nextTick();
  assert.equal(shown(), 'Photos', 'a failed new turn still uses the timeout');
});

test('a map kept open redraws its labels when the app changes language', async (t) => {
  const previous = getLocale();
  t.after(() => setLocale(previous));
  setLocale('en');
  const contexts = recordCanvases(t);
  const source = fixtureSource(t);
  const { $$, unmount } = mount(t, CardMapCanvas, {
    lat: 0,
    lon: 0,
    zoom: 14,
    measure: () => ({ width: 768, height: 768 }),
  });
  await settle();
  const canvas = $$('canvas')[0];
  const before = drawnNames(canvas);
  assert.ok(before.includes('Midtown'));

  setLocale('fr');
  await settle();
  assert.equal($$('canvas')[0], canvas);
  const redrawn = namesOn(contexts).slice(before.length);
  assert.ok(redrawn.includes('Centre'));
  assert.ok(!redrawn.includes('Midtown'));

  unmount();
  const count = source.asked.length;
  setLocale('en');
  await settle();
  assert.equal(source.asked.length, count);
});

test('a close-up map repeats label placement when its viewport and caption resize', async (t) => {
  const contexts = recordCanvases(t);
  const source = fixtureSource(t);
  let width = 768;
  let height = 768;
  let foot = 20;
  let onResize = () => {};
  let disconnected = false;
  const observed = [];
  const oldObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'ResizeObserver',
  );
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(draw) {
        onResize = draw;
      }
      observe(node) {
        observed.push(node);
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  t.after(() => {
    if (oldObserver)
      Object.defineProperty(globalThis, 'ResizeObserver', oldObserver);
    else delete globalThis.ResizeObserver;
  });
  const measureElement = HTMLElement.prototype.getBoundingClientRect;
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function () {
    if (this.matches('.close-up-map'))
      return { width, height, top: 0, bottom: height };
    if (this.matches('.close-up-map__foot')) return { top: height - foot };
    return measureElement.call(this);
  });

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Past the 200 ms a resize waits to settle.
  const resized = async () => {
    await pause(260);
    await settle();
  };
  const { $$, unmount } = mount(t, CloseUpMap, {
    lat: 0,
    lon: 0,
    card: { layerId: 'place', kind: 'place', title: 'Fixture outskirts' },
  });
  await settle();
  const canvas = $$('canvas')[0];
  const before = drawnNames(canvas);
  assert.ok(before.includes('Midtown'));
  const count = source.asked.length;

  width = 120;
  height = 70;
  foot = 38;
  // An animated resize: a size every frame for a while.
  for (let step = 0; step < 8; step += 1) {
    onResize();
    await pause(16);
  }
  assert.equal(source.asked.length, count, 'no redraw while it is resizing');
  await resized();
  assert.equal(source.asked.length, count + 1, 'one redraw once it settles');

  width = 120.4;
  height = 69.8;
  onResize();
  await resized();
  assert.equal(
    source.asked.length,
    count + 1,
    'a sub-pixel change keeps the map',
  );
  assert.deepEqual(namesOn(contexts).slice(before.length), []);
  assert.equal(observed[0], $$('.close-up-map')[0]);
  assert.equal(observed[1], $$('.close-up-map__foot')[0]);
  assert.equal(observed[2], $$('.close-up-map__top')[0]);

  unmount();
  assert.equal(disconnected, true);
  onResize();
  await resized();
  assert.equal(source.asked.length, count + 1);
});

test('a map still is a spot and a zoom, drawn on a pin with the vector renderer and credited', async (t) => {
  assert.deepEqual(pinMap(48.8584, 2.2945), {
    lat: 48.8584,
    lon: 2.2945,
    zoom: 13,
  });
  assert.equal(pinMap(NaN, 0), null);
  for (const other of [
    '/still/1.jpg',
    'data:image/png;base64,AA',
    'card-map:13/91/0',
    '',
  ])
    assert.equal(legacyPinMap(other), null, other);

  recordCanvases(t);
  const show = fakeIntersections(t);
  const source = fixtureSource(t);
  const pinia = createPinia();
  setActivePinia(pinia);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'place:48.8584,2.2945',
    kind: 'place',
    title: 'Eiffel Tower',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'eiffel' },
    still: 'card-map:13/48.85840/2.29450',
  });
  pinned.pin({
    key: 'flights:a',
    kind: 'item',
    title: 'A',
    icon: 'flight',
    still: '/still/a.png',
    identity: { layerId: 'flights', id: 'a' },
  });
  pinned.pin({
    key: 'place:polar',
    kind: 'place',
    title: 'Polar place',
    icon: 'location_on',
    still: 'card-map:13/89.00000/10.00000',
  });
  const { $$ } = mount(t, PinnedGrid, {}, { pinia });
  await settle();
  show(true);
  await settle();
  const maps = $$('canvas.pinned-grid__frame');
  assert.equal(maps.length, 1, 'the place draws its map');
  assert.equal(maps[0].dataset.state, 'ready');
  assert.deepEqual(maps[0].getContext('2d').calls[0], [
    '=fillStyle',
    CARD_MAP_COLOURS.land,
  ]);
  assert.equal(maps[0].width, 256);
  assert.equal(maps[0].height, 160);
  assert.equal(maps[0].getAttribute('style'), null, 'sized by the tile');
  assert.equal(source.asked[0].zoom, 13);
  assert.ok(source.asked[0].tiles.length <= 4);
  assert.deepEqual(
    $$('img.pinned-grid__frame').map((img) => img.getAttribute('src')),
    ['/still/a.png'],
    'a picture is still a picture',
  );
  const [polar] = $$('[data-pin-key="place:polar"]');
  assert.equal(polar.querySelector('.pinned-grid__frame'), null);
  assert.ok(
    polar.querySelector(
      '.pinned-grid__icon--place:not(.pinned-grid__icon--over)',
    ),
  );
  const [credit] = $$('.pinned-grid__credit');
  assert.equal($$('.pinned-grid__credit').length, 1);
  assert.match(credit.textContent, /© OpenStreetMap contributors/);
  assert.match(credit.textContent, /© OpenMapTiles/);
  assert.equal(credit.getAttribute('title'), OPENFREEMAP_CARD_CREDIT_FULL);
  assert.equal(
    credit.querySelector('bdi')?.getAttribute('dir'),
    'ltr',
    'its © stays in front in a right-to-left page',
  );
});

test('private receiver pins cannot request map tiles while their source is off or absent', async (t) => {
  recordCanvases(t);
  const show = fakeIntersections(t);
  const source = fixtureSource(t);
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const layerId = 'local-adsb';
  const manager = { layers: new Map([[layerId, {}]]), isEnabled: () => false };
  cards.connect({ dataManager: () => manager });
  t.after(() => cards.connect(null));
  const pinned = usePinnedStore(pinia);
  for (const [id, saved] of [
    ['new', { map: pinMap(1, 2) }],
    ['legacy', { still: 'card-map:13/1.00000/2.00000' }],
  ]) {
    pinned.pin({
      key: layerId + ':' + id,
      kind: 'item',
      title: id,
      identity: { layerId, id },
      ...saved,
    });
  }
  const { $$ } = mount(t, PinnedGrid, {}, { pinia });
  show(true);
  await settle();
  assert.equal($$('canvas.pinned-grid__frame').length, 0);
  assert.deepEqual(source.asked, []);
  cards.card = { key: 'receiver', layerId, lat: 1, lon: 2 };
  assert.equal(cards.locationWithheld, true);
  manager.layers.delete(layerId);
  cards.layerRevision++;
  await nextTick();
  assert.equal(cards.locationWithheld, true);
  assert.equal($$('canvas.pinned-grid__frame').length, 0);
});

test('removing the last vector map pin leaves the camera photo credited', async (t) => {
  recordCanvases(t);
  const show = fakeIntersections(t);
  fixtureSource(t);
  const pinia = createPinia();
  const pinned = usePinnedStore(pinia);
  t.after(() => pinned.clearNotice());
  const cameraStill = '/api/cctv/frame/river';
  pinned.pin({
    key: 'place:current',
    kind: 'place',
    title: 'Vector map',
    icon: 'location_on',
    map: pinMap(48.8584, 2.2945),
  });
  pinned.pin({
    key: 'camera:river',
    kind: 'camera',
    title: 'River camera',
    icon: 'videocam',
    identity: { layerId: 'cctv', id: 'river' },
    still: cameraStill,
    source: { provider: 'River cameras' },
  });
  const { $$ } = mount(t, PinnedGrid, {}, { pinia });
  await settle();
  show(true);
  await settle();
  assert.equal($$('canvas.pinned-grid__frame')[0]?.dataset.state, 'ready');
  assert.deepEqual(
    $$('.pinned-grid__credit').map((credit) => credit.textContent),
    [OPENFREEMAP_CARD_CREDIT],
  );

  pinned.unpin('place:current');
  await nextTick();
  assert.equal($$('.pinned-grid__credits').length, 0);
  assert.equal(
    $$('img.pinned-grid__frame')[0]?.getAttribute('src'),
    cameraStill,
  );
  assert.equal(
    $$('.pinned-grid__photo-credit')[0]?.textContent,
    'River cameras',
  );
  pinned.undo();
  assert.deepEqual(pinned.pinFor('place:current').map, {
    lat: 48.8584,
    lon: 2.2945,
    zoom: 13,
  });
});

test("the credit's wording is the Data attribution entries'", () => {
  const text = (html) => html.replace(/<[^>]+>/g, '');
  assert.ok(text(OSM_CREDIT.html).includes('© OpenStreetMap contributors'));
  assert.ok(text(OPENMAPTILES_CREDIT.html).includes('OpenFreeMap'));
  for (const part of [
    '© OpenStreetMap contributors',
    'ODbL',
    'OpenFreeMap',
    '© OpenMapTiles',
  ])
    assert.ok(OPENFREEMAP_CARD_CREDIT_FULL.includes(part), part);
  assert.doesNotMatch(OPENFREEMAP_CARD_CREDIT_FULL, /tile\.openstreetmap\.org/);
});

test('the map is never mirrored, its foot follows the reading direction, and its marker glows in the accent', () => {
  const css = read('./styles/entity-card.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) =>
    css.match(
      new RegExp(`(?:^|\\}|,)\\s*${selector}\\s*(?:,[^{}]+)?\\{([^}]*)\\}`),
    )?.[1] || '';
  const canvas = rule('\\.close-up-map__canvas');
  assert.match(canvas, /\bleft:\s*0/);
  assert.doesNotMatch(canvas, /inset-inline|right:/);
  assert.match(rule('\\.close-up-map__map'), /\bleft:\s*50%/);
  assert.match(rule('\\.map-foot'), /inset-inline:\s*0/);
  assert.match(rule('\\.map-credit'), /text-align:\s*start/);
  const marker = rule('\\.close-up-map \\.close-up-map__icon');
  assert.match(marker, /color:\s*var\(--accent/);
  assert.match(marker, /border:\s*1px solid var\(--accent/);
  assert.match(marker, /box-shadow:[^;]*var\(--accent-glow/);
  assert.match(
    rule('\\.card-map'),
    /background:\s*#06080b/,
    'plain dark until drawn, or if it cannot be',
  );
});

test('the satellite ground view keeps its imagery and does not use the card map', () => {
  const view = read('./views/panels/SatelliteGroundView.vue');
  assert.doesNotMatch(view, /CardMapCanvas|cardMap/);
  assert.match(view, /ESRI_IMAGERY_PLACES_CARD_CREDIT/);
  assert.match(view, /ESRI_PLACES_TILES/);
});

test("a name is read in the app's language, then the local name, then its Latin form", () => {
  const paris = {
    name: 'Paris',
    'name:latin': 'Paris',
    'name:ja': 'パリ',
    'name:ar': 'باريس',
  };
  assert.equal(labelName(paris, 'ja'), 'パリ');
  assert.equal(labelName(paris, 'ar'), 'باريس');
  assert.equal(
    labelName(paris, 'de'),
    'Paris',
    'no German name: the local one',
  );
  assert.equal(
    labelName({ name: '  ', 'name:latin': 'Qahira' }, 'de'),
    'Qahira',
  );
  assert.equal(labelName({ 'name:fr': '' }, 'fr'), '', 'nothing, never a key');
  assert.equal(labelName({}, 'en'), '');
  assert.equal(
    labelName({ name: 'Zürich', 'name:en': 'Zurich' }, 'sv'),
    'Zürich',
    'accents kept',
  );
  assert.deepEqual(nameKeys('zh-Hant'), [
    'name:zh-Hant',
    'name:zh',
    'name',
    'name:latin',
  ]);
  assert.deepEqual(nameKeys('zh-CN'), [
    'name:zh-CN',
    'name:zh-Hans',
    'name:zh',
    'name',
    'name:latin',
  ]);
  assert.deepEqual(nameKeys('pt-BR'), [
    'name:pt-BR',
    'name:pt',
    'name',
    'name:latin',
  ]);
  assert.equal(
    labelName({ name: '北京', 'name:zh-Hant': '北京市' }, 'zh-Hant'),
    '北京市',
  );
});

test('right-to-left names are told by their first strong letter', () => {
  for (const text of ['תל אביב-יפו', 'القاهرة', '(القاهرة)', '12 شارع'])
    assert.equal(isRightToLeft(text), true, text);
  for (const text of [
    'Paris',
    '東京',
    'Москва',
    'दिल्ली',
    'กรุงเทพมหานคร',
    'Αθήνα',
    '42',
  ])
    assert.equal(isRightToLeft(text), false, text);
});

/** A 2D context that records calls and measures 6 px a character. */
function labelCtx() {
  const calls = [];
  const ctx = new Proxy(
    {
      measureText(text) {
        calls.push(['measureText', text]);
        return { width: [...text].length * 6 };
      },
    },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => calls.push([key, ...args]);
      },
      set(target, key, value) {
        calls.push([`=${String(key)}`, value]);
        return true;
      },
    },
  );
  return { ctx, calls };
}
const place = (text, x, y, extra = {}) => ({
  kind: 'place',
  text,
  priority: 0,
  size: 12,
  weight: 700,
  rank: 1,
  anchor: [x, y],
  ...extra,
});

test('only visible label anchors use the canvas measurement budget', () => {
  const { ctx, calls } = labelCtx();
  const candidates = [
    place('Outside', -10, 50),
    ...Array.from({ length: 129 }, (_, i) => place(`Park ${i}`, 50, 50)),
  ];
  const placed = placeLabels(ctx, candidates, { bounds: [0, 0, 100, 100] });
  const measured = calls.filter(([method]) => method === 'measureText');
  assert.equal(measured.length, 128);
  assert.equal(measured[0][1], 'Park 0');
  assert.deepEqual(
    placed.map((label) => label.text),
    ['Park 0'],
  );
});

test('a right-to-left name is set right to left, and each name has a halo under it', () => {
  const { ctx, calls } = labelCtx();
  const placed = placeLabels(
    ctx,
    [place('תל אביב', 100, 50), place('Jaffa', 100, 150)],
    { bounds: [0, 0, 300, 300], scale: 2 },
  );
  assert.deepEqual(
    placed.map((p) => [p.text, p.rtl]),
    [
      ['תל אביב', true],
      ['Jaffa', false],
    ],
  );
  const directions = calls
    .filter(([k]) => k === '=direction')
    .map(([, v]) => v);
  assert.deepEqual(directions, ['rtl', 'ltr']);
  assert.deepEqual(
    calls.find(([k]) => k === 'setTransform'),
    ['setTransform', 2, 0, 0, 2, 0, 0],
    'drawn at the device scale',
  );
  const order = calls
    .filter(([k]) => k === 'strokeText' || k === 'fillText')
    .map(([k]) => k);
  assert.deepEqual(order, ['strokeText', 'fillText', 'strokeText', 'fillText']);
  assert.ok(
    calls.some(
      ([k, v]) => k === '=strokeStyle' && v === CARD_MAP_COLOURS.nameHalo,
    ),
  );
});

test('names never overlap: the later of two that would is left out', () => {
  const { ctx } = labelCtx();
  const placed = placeLabels(
    ctx,
    [
      place('Springfield', 100, 100),
      place('Shelbyville', 104, 102),
      place('Ogdenville', 100, 200),
    ],
    { bounds: [0, 0, 300, 300] },
  );
  assert.deepEqual(
    placed.map((p) => p.text),
    ['Springfield', 'Ogdenville'],
  );
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = [placed[i].box, placed[j].box];
      assert.ok(!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]));
    }
});

test("names keep off the item's marker and the foot, and lie wholly inside what shows", async (t) => {
  const { ctx } = labelCtx();
  const placed = placeLabels(
    ctx,
    [
      place('OnTheMarker', 150, 150),
      place('InTheFoot', 150, 285),
      place('CutAtTheEdge', 10, 100),
      place('Clear', 150, 60),
    ],
    {
      bounds: [0, 0, 300, 300],
      clear: [
        [120, 120, 180, 180],
        [0, 260, 300, 300],
      ],
    },
  );
  assert.deepEqual(
    placed.map((p) => p.text),
    ['Clear'],
  );

  // The renderer keeps the marker on the spot clear, whatever the tile says.
  recordCanvases(t);
  const source = {
    async fetchBounds(box, { tiles, onTile }) {
      for (const tile of tiles)
        onTile(
          {
            extent: 1024,
            layers: {
              place: [
                {
                  type: 1,
                  properties: { class: 'city', name: 'Spot' },
                  // Every tile names the point under the spot.
                  parts: [[512, 512]],
                },
              ],
            },
          },
          tile,
        );
    },
  };
  t.after(setCardMapSource(source));
  const canvas = document.createElement('canvas');
  // The spot exactly at a tile's centre.
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * 100.5) / 2 ** 8))) * 180) /
    Math.PI;
  const lon = (200.5 / 2 ** 8) * 360 - 180;
  await drawCardMap(canvas, { lat, lon, zoom: 8 }).done;
  const ctxShown = canvas.getContext('2d');
  const texts = ctxShown.calls.filter(([k]) => k === 'fillText');
  assert.ok(texts.length >= 1, 'a neighbouring copy is placed');
  const at = ctxShown.calls
    .filter(([k]) => k === 'translate')
    .map(([, x, y]) => [x, y]);
  const spot = [
    -cardMapLayout(lat, lon, 8).left,
    -cardMapLayout(lat, lon, 8).top,
  ];
  for (const [x, y] of at)
    assert.ok(
      Math.abs(x - spot[0]) > CARD_MAP_LABELS.marker ||
        Math.abs(y - spot[1]) > CARD_MAP_LABELS.marker,
      `${x},${y} is off the marker`,
    );
});

test('a road is named along its line where the name fits, level at its middle where it does not, once per road', () => {
  const road = (text, line) => ({
    kind: 'road',
    text,
    priority: 5,
    size: 10,
    weight: 500,
    rank: 0,
    line,
    length: 0,
  });
  const { ctx } = labelCtx();
  const placed = placeLabels(
    ctx,
    [
      road('Diagonal Avenue', [
        [20, 20],
        [220, 220],
      ]),
      road('Diagonal Avenue', [
        [20, 260],
        [200, 270],
      ]),
      road('Long Name Boulevard', [
        [200, 40],
        [230, 40],
        [260, 60],
      ]),
    ],
    { bounds: [0, 0, 300, 300] },
  );
  assert.equal(placed.length, 2);
  assert.equal(placed[0].text, 'Diagonal Avenue');
  assert.ok(Math.abs(placed[0].angle - Math.PI / 4) < 1e-9, 'along the line');
  assert.equal(placed[1].text, 'Long Name Boulevard');
  assert.equal(placed[1].angle, 0, 'level where it does not fit along');
  // Never upside down.
  const back = placeLabels(
    labelCtx().ctx,
    [
      road('Back', [
        [220, 220],
        [20, 20],
      ]),
    ],
    { bounds: [0, 0, 300, 300] },
  );
  assert.ok(Math.abs(back[0].angle) <= Math.PI / 2);
});

test('a water name uses the first copy that fits inside the visible map', () => {
  const kept = {
    layers: {
      water_name: [
        {
          type: 2,
          properties: { class: 'river', name: 'Colorado' },
          parts: [[0, 100, 40, 100]],
        },
      ],
    },
  };
  const tiles = [-100, 50, 200].map((offset) => ({
    kept,
    at: (x, y) => [x + offset, y],
  }));
  const labels = placeLabels(labelCtx().ctx, collectLabels(tiles), {
    bounds: [0, 0, 300, 300],
  });
  assert.deepEqual(
    labels.map((label) => label.text),
    ['Colorado'],
  );
  assert.equal((labels[0].box[0] + labels[0].box[2]) / 2, 70);
});

test('the candidates: places by rank before roads, major roads only, no points of interest', () => {
  const kept = {
    extent: 1024,
    layers: {
      place: [
        {
          type: 1,
          properties: { class: 'suburb', name: 'Le Marais', rank: 10 },
          parts: [[10, 10]],
        },
        {
          type: 1,
          properties: { class: 'city', name: 'Paris', rank: 1 },
          parts: [[20, 20]],
        },
        {
          type: 1,
          properties: { class: 'city', name: 'Paris', rank: 1 },
          parts: [[1030, 20]],
        },
        {
          type: 1,
          properties: { class: 'hamlet', name: 'Nowhere' },
          parts: [[30, 30]],
        },
        { type: 1, properties: { class: 'town' }, parts: [[40, 40]] },
      ],
      transportation_name: [
        {
          type: 2,
          properties: { class: 'minor', name: 'Rue Petite' },
          parts: [[0, 0, 100, 0]],
        },
        {
          type: 2,
          properties: { class: 'primary', name: 'Boulevard Saint-Germain' },
          parts: [[0, 0, 100, 0]],
        },
      ],
      poi: [
        {
          type: 1,
          properties: { class: 'cafe', name: 'Café' },
          parts: [[5, 5]],
        },
      ],
    },
  };
  const labels = collectLabels([{ kept, at: (x, y) => [x, y] }], {
    locale: 'en',
  });
  assert.deepEqual(
    labels.map((l) => l.text),
    ['Paris', 'Paris', 'Le Marais', 'Boulevard Saint-Germain'],
  );
  assert.ok(labels[0].size > labels[2].size);
});

test('a held map redraw keeps the finished frame aligned to its marker', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t);
  const props = reactive({ lat: 0.25, lon: -0.006, card: null });
  const { $$ } = mount(t, CloseUpMap, props);
  await settle();
  const [canvas] = $$('.close-up-map__canvas');
  assert.equal(canvas.dataset.state, 'ready');
  const alignment = canvas.style.transform;
  const ctx = canvas.getContext('2d');
  const paintCalls = ctx.calls.length;
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  source.fetchBounds = async () => {
    await held.promise;
    throw new Error('fixture redraw failed');
  };

  props.lon = 0.006;
  await settle();
  assert.equal(canvas.dataset.state, 'loading');
  assert.equal(ctx.calls.length, paintCalls, 'the old pixels are still shown');
  assert.equal(
    canvas.style.transform,
    alignment,
    'a retained frame does not shift under its marker',
  );
  held.resolve();
  await settle();
  assert.equal(canvas.dataset.state, 'failed');
  assert.equal(ctx.calls.length, paintCalls, 'failure retains the old pixels');
  assert.equal(
    canvas.style.transform,
    alignment,
    'a failed repaint keeps the frame where its pixels belong',
  );
});

test('a published redraw moves the frame with its new pixels', async (t) => {
  recordCanvases(t);
  fixtureSource(t);
  const props = reactive({ lat: 0.25, lon: -0.006, card: null });
  const { $$ } = mount(t, CloseUpMap, props);
  await settle();
  const [canvas] = $$('.close-up-map__canvas');
  const alignment = canvas.style.transform;
  props.lon = 0.006;
  await settle();
  assert.equal(canvas.dataset.state, 'ready');
  assert.notEqual(canvas.style.transform, alignment, 'placed for the new spot');
});

test('a framed pin is drawn at its fixed frame, so resizing never fetches again', async (t) => {
  recordCanvases(t);
  const source = fixtureSource(t);
  const observers = [];
  const oldObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'ResizeObserver',
  );
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  });
  t.after(() => {
    if (oldObserver)
      Object.defineProperty(globalThis, 'ResizeObserver', oldObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  const { $$ } = mount(t, CardMapCanvas, {
    lat: 30.27,
    lon: -97.74,
    zoom: 13,
    frame: { width: 256, height: 160 },
  });
  await settle();
  const [canvas] = $$('canvas');
  assert.equal(canvas.dataset.state, 'ready');
  const count = source.asked.length;
  assert.equal(
    canvas.width / canvas.height,
    256 / 160,
    'its frame, at any scale',
  );

  // A panel drag: the tile's laid-out size changes every frame.
  let laidOut = 180;
  Object.defineProperty(canvas, 'clientWidth', { get: () => laidOut });
  Object.defineProperty(canvas, 'clientHeight', {
    get: () => Math.round(laidOut / 1.6),
  });
  for (let step = 0; step < 12; step += 1) {
    laidOut += 7;
    for (const callback of observers) callback([]);
    globalThis.window?.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await new Promise((resolve) => setTimeout(resolve, 260));
  await settle();
  assert.equal(source.asked.length, count, 'no tile is asked for again');
  assert.equal(canvas.dataset.state, 'ready');
});

test("the stills' credits stay at the foot of the scrolling Pinned list", () => {
  const grid = read('./views/panels/PinnedGrid.vue');
  assert.match(
    grid,
    /<div v-if="mapShown\(\)" class="pinned-grid__credits">[\s\S]*?OPENFREEMAP_CARD_CREDIT[\s\S]*?<\/div>/,
  );
  const css = read('./styles/entity-card.css');
  const rule = css.match(/\.pinned-grid__credits \{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /position: sticky;/);
  assert.match(rule, /bottom: 0;/);
});
