import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createNavaraCredits } from './credits.js';
import { createNavaraMaps } from './maps.js';

// Exercise the installed plugin's DOM, sanitizer and credit tracking. Only
// its unused Plugin base is stubbed, to avoid starting the WASM/WebGL engine.
const bundle = await build({
  entryPoints: [
    new URL(
      '../../../node_modules/@navaramap/three/src/plugins/AttributionPlugin/index.ts',
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'plugin-base',
      setup(build) {
        build.onResolve({ filter: /^@navaramap\/core$/ }, () => ({
          path: 'plugin-base',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export class Plugin {}',
        }));
      },
    },
  ],
});
const { AttributionPlugin } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    off(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name, value) {
      for (const listener of listeners.get(name) ?? []) listener(value);
    },
    count(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

async function setup(t, { strip = true } = {}) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const layers = new Map();
  let nextId = 0;
  const view = {
    ...events(),
    canvas,
    camera: { zoom: 10 },
    findLayerById: (id) => layers.get(id),
    forceUpdate() {},
    addSource(description) {
      return { description, delete() {} };
    },
    addLayer(description) {
      const layer = {
        ...events(),
        id: `layer-${nextId++}`,
        description,
        update() {},
        delete() {
          layers.delete(layer.id);
          layer.emit('deleted');
        },
      };
      layers.set(layer.id, layer);
      return layer;
    },
  };
  const attribution = new AttributionPlugin();
  view.attribution = attribution;
  await attribution.init(view, {});
  const originalPopulateList = attribution.populateList;
  const originalRequestRender = attribution.requestRender;
  const adapter = strip ? createNavaraCredits(view) : null;
  t.after(() => {
    adapter?.destroy();
    attribution.dispose();
    host.remove();
  });
  const row = host.querySelector('#cesium-credits');
  return {
    host,
    view,
    attribution,
    layers,
    row,
    inline: () => row.querySelector('.cesium-credit-textContainer'),
    card: document.querySelector('.navara-attr-card'),
    originalPopulateList,
    originalRequestRender,
    ...adapter,
  };
}

test('the native plugin defers closed-card tile updates and has no credit strip', async (t) => {
  const { view, attribution, card, host } = await setup(t, { strip: false });
  const layer = view.addLayer({});
  attribution.add([{ attribution: 'Tiles', creditLayerId: layer.id }]);
  layer.emit('featureCreated', { featureSetId: 1n, credit: 'Tile copyright' });
  assert.equal(card.hidden, true);
  assert.doesNotMatch(card.textContent, /Tile copyright/);
  assert.equal(host.querySelector('#cesium-credits'), null);
  attribution.show();
  assert.match(card.textContent, /Tile copyright/);
});

test('the native plugin deduplicates content without retaining separate holders', async (t) => {
  const { attribution, card } = await setup(t, { strip: false });
  const credit = { attributionHtml: 'Shared credit' };
  attribution.add([credit]);
  attribution.add([credit]);
  assert.equal(card.textContent.match(/Shared credit/g).length, 1);
  attribution.remove([credit]);
  assert.doesNotMatch(card.textContent, /Shared credit/);
});

test('on-screen holders share one strip entry while quiet credits stay in the card', async (t) => {
  const { credits, inline, card } = await setup(t);
  const quiet = credits.addStatic('Shared credit');
  const first = credits.addStatic('Shared credit', { onScreen: true });
  const second = credits.addStatic('Shared credit', { onScreen: true });
  credits.addStatic('Card only');
  assert.equal(card.hidden, true);
  assert.equal(inline().textContent.match(/Shared credit/g).length, 1);
  assert.doesNotMatch(inline().textContent, /Card only/);
  assert.match(card.textContent, /Card only/);
  first();
  first();
  assert.match(inline().textContent, /Shared credit/);
  second();
  assert.doesNotMatch(inline().textContent, /Shared credit/);
  assert.match(card.textContent, /Shared credit/);
  quiet();
  assert.doesNotMatch(card.textContent, /Shared credit/);
});

test('map credits, Google logos and tile copyrights follow source and visibility changes', async (t) => {
  const { view, row, inline, card, layers } = await setup(t);
  const { maps, destroy } = createNavaraMaps(view, {
    setInterval: () => 1,
    clearInterval() {},
  });
  t.after(destroy);
  await maps.setBaseImagery({ kind: 'osm' });
  assert.match(inline().textContent, /OpenStreetMap/);
  await maps.setPhotorealTiles({ googleApiKey: 'test-key' });
  assert.equal(card.hidden, true);
  assert.doesNotMatch(inline().textContent, /OpenStreetMap/);
  const logo = row.querySelector('.cesium-credit-logoContainer img');
  assert.equal(logo.alt, 'Google');
  assert.equal(logo.src, 'https://assets.ion.cesium.com/google-credit.png');
  const tiles = [...layers.values()].find(
    (layer) => layer.description.type === '3d-tiles',
  );
  tiles.emit('featureCreated', { featureSetId: 1n, credit: '© A; © Shared' });
  tiles.emit('featureCreated', { featureSetId: 2n, credit: '© B; © Shared' });
  assert.match(inline().textContent, /© A.*© B/);
  assert.equal(inline().textContent.match(/© Shared/g).length, 1);
  tiles.emit('featureVisibilityChanged', { featureSetId: 1n, visible: false });
  assert.doesNotMatch(inline().textContent, /© A/);
  assert.match(inline().textContent, /© B/);
  tiles.emit('featureVisibilityChanged', { featureSetId: 1n, visible: true });
  tiles.emit('featureRemoved', { featureSetId: 2n });
  assert.match(inline().textContent, /© A/);
  assert.doesNotMatch(inline().textContent, /© B/);
  await maps.setPhotorealTiles({ googleApiKey: 'replacement-key' });
  assert.doesNotMatch(inline().textContent, /© A|© Shared/);
  assert.equal(tiles.count('featureCreated'), 0);
  tiles.emit('featureCreated', { featureSetId: 3n, credit: 'Late credit' });
  assert.doesNotMatch(inline().textContent, /Late credit/);
  assert.equal(
    row.querySelectorAll('.cesium-credit-logoContainer img').length,
    1,
  );
  await maps.setPhotorealTiles(null);
  assert.match(inline().textContent, /OpenStreetMap/);
  assert.equal(
    row.querySelectorAll('.cesium-credit-logoContainer img').length,
    0,
  );
  assert.equal(card.hidden, true);
});

test('native clear removes strip entries', async (t) => {
  const { attribution, inline, card } = await setup(t);
  attribution.add([{ attribution: 'Additional source' }]);
  assert.match(inline().textContent, /Additional source/);
  attribution.clear();
  assert.equal(inline().textContent, 'Navara');
  assert.equal(card.hidden, true);
});

test('closed-card credits follow zoom bands without churning an unchanged frame', async (t) => {
  const { view, attribution, inline, card } = await setup(t);
  attribution.add([
    {
      attribution: 'Imagery',
      children: [
        { attribution: 'Overview', maxZoom: 10 },
        { attribution: 'Detailed', minZoom: 11 },
      ],
    },
  ]);
  assert.match(inline().textContent, /Overview/);
  assert.doesNotMatch(inline().textContent, /Detailed/);
  const content = inline().firstChild;
  view.emit('preRender');
  assert.equal(inline().firstChild, content);
  view.camera.zoom = 12;
  view.emit('preRender');
  assert.match(inline().textContent, /Detailed/);
  assert.doesNotMatch(inline().textContent, /Overview/);
  assert.equal(card.hidden, true);
});

test('the strip preserves sanitized links from static and tile credits', async (t) => {
  const { view, attribution, credits, inline } = await setup(t);
  const markup =
    '<a href="https://example.test/credit?a=1;b=2">Publisher</a><img src=x onerror="alert(1)"><a href="javascript:alert(1)">Unsafe</a>';
  credits.addStatic(markup, { onScreen: true });
  const layer = view.addLayer({});
  attribution.add([{ attribution: 'Tiles', creditLayerId: layer.id }]);
  layer.emit('featureCreated', { featureSetId: 1n, credit: markup });
  const links = inline().querySelectorAll('a[href*="example.test"]');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(
    inline().querySelectorAll('img, [onerror], [href^="javascript:"]').length,
    0,
  );
  assert.match(inline().textContent, /Unsafe/);
});

test('the native button, close button and Escape still control only the card', async (t) => {
  const { credits, row, inline, card, view } = await setup(t);
  credits.addStatic('On screen', { onScreen: true });
  const toggle = row.querySelector('.navara-attr-toggle');
  toggle.click();
  assert.equal(card.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  row.querySelector('.navara-attr-close').click();
  assert.equal(card.hidden, true);
  toggle.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(card.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  view.emit('preRender');
  credits.addStatic('Another on screen', { onScreen: true });
  assert.equal(card.hidden, true);
  assert.match(inline().textContent, /On screen.*Another on screen/);
});

test('parking hides the complete credit UI; destroy restores the plugin and releases the strip', async (t) => {
  const {
    host,
    view,
    attribution,
    credits,
    row,
    destroy,
    originalPopulateList,
    originalRequestRender,
  } = await setup(t);
  const remove = credits.addStatic('Owned', { onScreen: true });
  host.remove();
  assert.equal(document.querySelector('.navara-attr-dock'), null);
  assert.equal(document.querySelector('.navara-attr-logoframe'), null);
  assert.equal(document.querySelector('#cesium-credits'), null);
  document.body.appendChild(host);
  assert.equal(document.querySelector('#cesium-credits'), row);
  assert.equal(view.count('preRender'), 2);
  destroy();
  destroy();
  remove();
  credits.addStatic('After destroy', { onScreen: true });
  assert.equal(view.count('preRender'), 1);
  assert.equal(attribution.populateList, originalPopulateList);
  assert.equal(attribution.requestRender, originalRequestRender);
  assert.equal(host.querySelector('#cesium-credits'), null);
  assert.doesNotMatch(
    document.querySelector('.navara-attr-list').textContent,
    /Owned|After destroy/,
  );
});
