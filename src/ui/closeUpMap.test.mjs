// The card's close-up map: how close it looks by kind of item, a vector map
// drawn round the spot with a credit naming its sources on screen, a caption
// naming the place itself, and an icon centred in its circle. Over
// happy-dom; the stylesheet is checked where layout matters.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'vue/compiler-sfc';
import { createApp, h, nextTick, reactive, ref } from 'vue';
import {
  CLOSE_UP_ZOOM,
  cityCaption,
  closeUpPlace,
  closeUpZoom,
  tileBlock,
} from './mapTiles.js';
import {
  ESRI_IMAGERY_CREDIT,
  ESRI_PLACES_TILES,
  ESRI_TILES,
  OPENFREEMAP_CARD_CREDIT,
  OPENFREEMAP_CARD_CREDIT_FULL,
} from '../maps/attribution.js';
import { vesselSprite } from '../data/vesselSprites.js';
import { bindLocale, getLocale, setLocale } from '../i18n/index.js';
import { loadCities } from '../data/wikidataCities.js';
import {
  cardMapTheme,
  setCardMapSource,
  toggleCardMapTheme,
} from './cardMap.js';
import CloseUpMap from './views/panels/CloseUpMap.vue';

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = withoutComments(
  fs.readFileSync(new URL('./styles/entity-card.css', import.meta.url), 'utf8'),
);

test('the zoom table: each kind looks as close as suits it, anything else the default', () => {
  const within = (kind, low, high) => {
    const zoom = CLOSE_UP_ZOOM[kind];
    assert.ok(zoom >= low && zoom <= high, `${kind}: z${zoom}`);
  };
  within('airport', 11, 12);
  for (const kind of [
    'fire',
    'fire perimeter',
    'vessel',
    'earthquake',
    'installation',
  ])
    within(kind, 11, 12);
  within('place', 13, 14);
  within('camera', 15, 16);
  within('plate reader', 15, 16);
  assert.ok(Number.isInteger(CLOSE_UP_ZOOM.default));
  assert.equal(closeUpZoom({ kind: 'airport' }), CLOSE_UP_ZOOM.airport);
  assert.equal(closeUpZoom({ kind: 'camera' }), CLOSE_UP_ZOOM.camera);
  assert.equal(closeUpZoom({ kind: 'storm' }), CLOSE_UP_ZOOM.default);
  assert.equal(closeUpZoom(null), CLOSE_UP_ZOOM.default);
});

test('tiles sit whole pixels apart, one tile step from each other, so no seam shows', () => {
  for (const [lat, lon, zoom] of [
    [30.2672, -97.7431, 14],
    [-33.8688, 151.2093, 12],
    [64.1466, -21.9426, 16],
    [0.0001, 179.9999, 11],
  ]) {
    const tiles = tileBlock(lat, lon, zoom);
    assert.equal(tiles.length, 9);
    for (const tile of tiles) {
      assert.ok(Number.isInteger(tile.left), `${tile.key} left ${tile.left}`);
      assert.ok(Number.isInteger(tile.top), `${tile.key} top ${tile.top}`);
    }
    const lefts = [...new Set(tiles.map((tile) => tile.left))].sort(
      (a, b) => a - b,
    );
    assert.deepEqual(
      lefts.slice(1).map((left, i) => left - lefts[i]),
      [256, 256],
    );
    // The spot is within a pixel of the centre tile.
    const centre = tiles[4];
    assert.ok(centre.left <= 0 && centre.left >= -256);
    assert.ok(centre.top <= 0 && centre.top >= -256);
  }
  // Vector maps draw the block on one canvas, so they have no seams.
  assert.match(css, /\.close-up-map__canvas\s*\{/);
});

test('the same block reads any tile service (the satellite ground view): World Imagery by default, the place names when asked', () => {
  const imagery = tileBlock(30.2672, -97.7431, 12);
  const names = tileBlock(30.2672, -97.7431, 12, ESRI_PLACES_TILES);
  assert.ok(imagery[4].src.startsWith(ESRI_TILES.split('{z}')[0]));
  assert.match(
    names[4].src,
    /^https:\/\/services\.arcgisonline\.com\/ArcGIS\/rest\/services\/Reference\/World_Boundaries_and_Places\/MapServer\/tile\/12\/\d+\/\d+$/,
  );
  assert.deepEqual(
    names.map(({ left, top }) => [left, top]),
    imagery.map(({ left, top }) => [left, top]),
    'the names sit exactly over the imagery',
  );
});

test('the caption names an airport and a place from search by themselves; anything else by the nearest city', () => {
  const airport = {
    name: 'San Francisco International Airport',
    city: 'San Francisco',
    country: 'US',
  };
  assert.equal(
    closeUpPlace({ layerId: 'place', kind: 'airport', place: { airport } }),
    'San Francisco International Airport, San Francisco, United States',
  );
  assert.equal(
    closeUpPlace({
      layerId: 'place',
      kind: 'place',
      title: 'Congress Ave Bridge',
      identity: { label: 'Congress Ave Bridge, Austin, Texas' },
      place: { airport: null },
    }),
    'Congress Ave Bridge, Austin, Texas',
  );
  assert.equal(
    closeUpPlace({ layerId: 'local-firms', kind: 'fire', title: 'Fire' }),
    null,
  );
  assert.equal(closeUpPlace(null), null);
  assert.equal(
    cityCaption({ name: 'Austin', country: 'US' }),
    'Austin, United States',
  );
  assert.equal(cityCaption({ name: 'Nowhere' }), 'Nowhere');
  assert.equal(cityCaption(null), '');
});

// A 2D context that draws nothing, and a tile source that records each ask
// and answers none, so the map asks without the network.
function useSource(t) {
  const asked = [];
  const original = HTMLCanvasElement.prototype.getContext;
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  HTMLCanvasElement.prototype.getContext = () => ctx;
  t.after(() => {
    HTMLCanvasElement.prototype.getContext = original;
  });
  t.after(
    setCardMapSource({
      async fetchBounds(box, { zoom, tiles }) {
        asked.push({ zoom, tiles: tiles.map(({ x, y }) => `${x}/${y}`) });
        throw new Error('no tiles in this test');
      },
    }),
  );
  return asked;
}

// Long enough for a map to compile its style and ask for its tiles.
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function mount(t, props) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({ render: () => h(CloseUpMap, props) });
  app.mount(host);
  t.after(() => app.unmount());
  return (selector) => [...host.querySelectorAll(selector)];
}

test('a stationary close-up caption follows the page locale', async (t) => {
  const original = getLocale();
  bindLocale(ref(original));
  t.after(() => setLocale(original));
  setLocale('en');
  await loadCities(async () => ({
    ok: true,
    json: async () => ({
      rows: [['Austin', 30, -97, 1000000, 'US', 'Q16559']],
    }),
  }));
  const all = mount(t, { lat: 30, lon: -97 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const label = all('.close-up-map__label')[0];
  assert.equal(label.title, 'Austin, United States');
  setLocale('de');
  await nextTick();
  assert.equal(label.title, 'Austin, Vereinigte Staaten');
});

test('the map is drawn from vector tiles at the zoom for its kind, crediting its sources on screen', async (t) => {
  const asked = useSource(t);
  const $$ = mount(t, {
    lat: 37.6213,
    lon: -122.379,
    icon: 'flight',
    card: {
      layerId: 'place',
      kind: 'airport',
      place: {
        airport: {
          name: 'San Francisco International Airport',
          city: 'San Francisco',
          country: 'US',
        },
      },
    },
  });
  await settle();
  assert.equal($$('img').length, 0, 'no tile images');
  const [map] = $$('canvas.close-up-map__canvas');
  assert.ok(map, 'one canvas');
  assert.equal(asked.at(-1).zoom, 12, "an airport's zoom");
  const [credit] = $$('.close-up-map__credit');
  assert.equal(credit.textContent, OPENFREEMAP_CARD_CREDIT);
  assert.equal(credit.getAttribute('title'), OPENFREEMAP_CARD_CREDIT_FULL);
  assert.equal(
    credit.getAttribute('tabindex'),
    '0',
    'its long form is a focus away',
  );
  assert.equal(
    credit.closest('[aria-hidden="true"]'),
    null,
    'read out, not hidden',
  );
  assert.doesNotMatch(document.body.innerHTML, /arcgisonline|Esri/i);
  const [label] = $$('.close-up-map__label');
  assert.match(
    label.textContent,
    /^San Francisco International Airport, San Francisco, United States$/,
  );
  assert.equal($$('.close-up-map__icon')[0].textContent, 'flight');
});

test('the close-up switches styles while keeping its attribution visible', async (t) => {
  useSource(t);
  const $$ = mount(t, { lat: 30.2688, lon: -97.7427 });
  const [toggle] = $$('.close-up-map__theme');
  t.after(() => {
    if (cardMapTheme.value !== 'dark') toggleCardMapTheme();
    globalThis.localStorage?.removeItem('gev.cardMapTheme');
  });
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click();
  await settle();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(cardMapTheme.value, 'toner');
  assert.equal(
    $$('.close-up-map__credit')[0].textContent,
    OPENFREEMAP_CARD_CREDIT,
  );
  toggle.click();
  await settle();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(cardMapTheme.value, 'dark');
});

// Include the component styles alongside card and phone rules.
const mobileCss = withoutComments(
  fs.readFileSync(
    new URL('./styles/mobile-shell.css', import.meta.url),
    'utf8',
  ),
);
const componentCss = parse(
  fs.readFileSync(
    new URL('./views/panels/CloseUpMap.vue', import.meta.url),
    'utf8',
  ),
).descriptor.styles.map((style) => withoutComments(style.content));
const rulesFor = (pattern) =>
  [css, mobileCss, ...componentCss].flatMap((sheet) =>
    [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => pattern.test(selector))
      .map(([, selector, body]) => ({ selector: selector.trim(), body })),
  );

test('map credits wrap or allow scrolling across the single imagery credit line', () => {
  const rules = rulesFor(
    /\.map-credit\b|\.close-up-map__credit\b|\.satellite-ground__credit\b/,
  );
  assert.ok(rules.length > 0);
  for (const { selector, body } of rules) {
    assert.doesNotMatch(body, /line-clamp/, `${selector}: no line clamp`);
    assert.doesNotMatch(body, /max-(width|height)/, `${selector}: no cap`);
    assert.doesNotMatch(
      body,
      /overflow:\s*(hidden|clip)/,
      `${selector}: no clip`,
    );
    if (selector.includes('.close-up-map__credit--imagery')) {
      assert.match(body, /white-space:\s*nowrap/);
      assert.match(
        body,
        /overflow-x:\s*auto/,
        'narrow imagery credits remain scrollable',
      );
    } else
      assert.doesNotMatch(
        body,
        /white-space:\s*nowrap/,
        `${selector}: it wraps`,
      );
    assert.doesNotMatch(body, /text-overflow/, `${selector}: no ellipsis`);
    assert.doesNotMatch(body, /display:\s*(-webkit-box|none)/, selector);
    assert.doesNotMatch(
      body,
      /(^|[\s;])(height|width):/,
      `${selector}: no fixed size`,
    );
  }
  assert.equal(
    rules.some(({ selector }) => /:hover/.test(selector)),
    false,
    'nothing is kept for hover',
  );
});

test('a hazard card uses Esri at its normal map scale and keeps its last frame while hidden', async (t) => {
  const asked = useSource(t);
  const props = reactive({
    lat: 60.4,
    lon: -147.9,
    active: false,
    card: { layerId: 'earthquakes', kind: 'earthquake' },
  });
  const all = mount(t, props);
  const tileUrls = () => all('img').map((tile) => tile.src);
  await settle();
  assert.deepEqual(tileUrls(), []);
  assert.deepEqual(asked, []);

  props.active = true;
  for (const [layerId, kind] of [
    ['earthquakes', 'earthquake'],
    ['local-firms', 'fire'],
    ['fire-perimeters', 'fire perimeter'],
    ['weather-cyclones', 'storm'],
  ]) {
    props.card = { layerId, kind };
    await settle();
    assert.deepEqual(
      tileUrls(),
      tileBlock(props.lat, props.lon, closeUpZoom(props.card)).map(
        ({ src }) => src,
      ),
      layerId,
    );
    assert.equal(all('canvas').length, 0);
    assert.equal(all('.close-up-map__theme').length, 0);
    const [credit] = all('.close-up-map__top .map-credit');
    assert.equal(credit.title, ESRI_IMAGERY_CREDIT);
    assert.ok(credit.classList.contains('close-up-map__credit--imagery'));
    assert.equal(credit.tabIndex, 0);
    assert.match(
      credit.textContent,
      /Esri.*Vantor.*Earthstar.*GIS User Community/,
    );
    assert.equal(credit.closest('[aria-hidden="true"]'), null);
  }

  const last = tileUrls();
  props.active = false;
  props.lat = 34;
  await settle();
  assert.deepEqual(tileUrls(), last);
  props.active = true;
  await settle();
  assert.notDeepEqual(tileUrls(), last);
  assert.deepEqual(asked, []);
});

test('the top attribution and theme control stay visible without a place caption', async (t) => {
  const $$ = mount(t, { lat: 10, lon: 20, card: null });
  await nextTick();
  const [bar] = $$('.close-up-map__top');
  assert.equal(bar.closest('[aria-hidden="true"]'), null);
  assert.match(
    bar.querySelector('small').textContent,
    /OpenStreetMap.*OpenMapTiles/,
  );
  assert.ok(bar.querySelector('button[aria-label="Light map"]'));
  assert.equal($$('.close-up-map__label').length, 0);
  assert.equal($$('.close-up-map__foot .map-credit').length, 0);
});

// Every stylesheet, for any rule that would set the marker's display.
const allCss = fs
  .readdirSync(new URL('./styles/', import.meta.url))
  .filter((name) => name.endsWith('.css'))
  .map((name) =>
    withoutComments(
      fs.readFileSync(new URL(`./styles/${name}`, import.meta.url), 'utf8'),
    ),
  )
  .join('\n');

test("a vessel's map shows the sprite the map draws it with, not a glyph", async (t) => {
  const $$ = mount(t, {
    lat: 46.5,
    lon: -84.35,
    icon: 'directions_boat',
    card: { layerId: 'ais-live-vessels', kind: 'vessel', shipType: 'tanker' },
  });
  await nextTick();
  const [ring] = $$('.close-up-map__icon');
  const mark = ring.querySelector('.entity-mark');
  assert.equal(
    mark.style.getPropertyValue('--mark'),
    `url("${vesselSprite('tanker')}")`,
  );
  assert.equal(mark.textContent, '', 'no glyph text');
  assert.equal(ring.getAttribute('aria-hidden'), 'true');
});

test('the marker is centred in its circle whatever the mark', () => {
  const rule = [
    ...css.matchAll(/([^{}]*\.close-up-map__icon[^{}]*)\{([^}]*)\}/g),
  ].find(([, selector]) => !/:is\(/.test(selector));
  assert.ok(rule, 'the marker rule is present');
  const [, selector, body] = rule;
  // The ring is its own element around the mark, so no icon font rule
  // reaches it.
  assert.match(selector.trim(), /^\.close-up-map \.close-up-map__icon$/);
  assert.match(body, /display:\s*grid/);
  assert.match(body, /place-items:\s*center/);
  assert.match(body, /line-height:\s*1;/);
  assert.match(body, /text-align:\s*center/);
  assert.match(body, /border-radius:\s*50%/);
  const width = body.match(/\bwidth:\s*([\d.]+rem)/)?.[1];
  assert.equal(body.match(/\bheight:\s*([\d.]+rem)/)?.[1], width, 'a circle');
  assert.match(body, /transform:\s*translate\(-50%,\s*-50%\)/);
  // No other rule turns the marker into a block or another layout.
  for (const [, other, otherBody] of allCss.matchAll(
    /([^{}]*\.close-up-map__icon[^{}]*)\{([^}]*)\}/g,
  )) {
    if (other === selector) continue;
    assert.doesNotMatch(
      otherBody,
      /display:\s*(block|inline|flex|inline-block)\b/,
      other.trim(),
    );
  }
  // The card's placeholder glyph uses the same pattern.
  const glyph =
    css.match(
      /\.entity-hero__glyph\.material-symbols-outlined\s*\{([^}]*)\}/,
    )?.[1] || '';
  assert.match(glyph, /display:\s*grid/);
  assert.match(glyph, /place-items:\s*center/);
  assert.match(glyph, /line-height:\s*1;/);
});

test('a map kept behind another view asks for no new tiles as its item moves, and catches up when shown again', async (t) => {
  const asked = useSource(t);
  const props = reactive({
    lat: 37.6213,
    lon: -122.379,
    icon: 'flight',
    active: true,
    card: { kind: 'airport', place: { airport: { name: 'SFO' } } },
  });
  mount(t, props);
  await settle();
  assert.equal(asked.length, 1, 'one ask for the block');
  const first = asked[0];

  // Behind the photo or the model, the item crosses several tiles.
  props.active = false;
  await settle();
  for (const step of [1, 2, 3]) {
    props.lat = 37.6213 + step * 0.2;
    props.lon = -122.379 + step * 0.2;
    await settle();
    assert.equal(asked.length, 1, `no new ask at step ${step}`);
  }

  // Shown again: the map is drawn where the item is now.
  props.active = true;
  await settle();
  assert.equal(asked.length, 2);
  assert.notDeepEqual(asked[1], first, 'it caught up');
  const block = tileBlock(props.lat, props.lon, 12).map((tile) =>
    tile.key.split('/').slice(1).join('/'),
  );
  assert.deepEqual(asked[1].tiles, block);

  props.lon = 179.999;
  await settle();
  const dateline = asked.length;
  props.lon = -179.999;
  await settle();
  assert.equal(
    asked.length,
    dateline,
    'a 0.002° crossing keeps the held tiles',
  );
  props.lon = -179.98;
  await settle();
  assert.ok(asked.length > dateline, 'a move beyond 0.01° retakes them');
});

test('a map used without the prop is shown and follows its item as before', async (t) => {
  const asked = useSource(t);
  const props = reactive({
    lat: 30.27,
    lon: -97.74,
    icon: 'place',
    card: { kind: 'airport', place: { airport: { name: 'AUS' } } },
  });
  mount(t, props);
  await settle();
  props.lat += 0.5;
  await settle();
  assert.equal(asked.length, 2);
  assert.notDeepEqual(asked[1].tiles, asked[0].tiles);
});
