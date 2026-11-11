// src/scenes/dataPacks/presentationView.test.mjs — loaded packs' attribution
// cards render in the viewer's container from what the data-pack
// presentations present, and a removed card's player stops.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useDataPacksStore } from '../../ui/stores/dataPacks.js';
import DataPacks from '../../ui/views/panels/DataPacks.vue';
import { createPackPresentations } from './presentation.js';

const ANCHOR = { id: 'here', lat: 30, lon: -97, alt: 10 };
const pack = (id, url) => ({
  id,
  attribution: { text: 'Synthetic', license: 'CC0-1.0', url },
  placement: { anchorId: 'here' },
});

function fixture(t) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(DataPacks).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const viewer = {
    container,
    scene: { requestRender() {} },
    entities: { add: (spec) => spec, remove() {} },
  };
  const store = useDataPacksStore(pinia);
  const presentations = createPackPresentations(viewer, new Map(), { store });
  t.after(() => app.unmount());
  const settle = async () => {
    for (let flush = 0; flush < 4; flush += 1) await nextTick();
  };
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  return { presentations, viewer, store, settle, $, $$ };
}

const media = (presentations, id, mimeType = 'audio/mpeg') =>
  presentations.media({
    pack: pack(id),
    asset: { bytes: new Uint8Array([1, 2, 3]), mimeType },
    anchors: [ANCHOR],
    signal: new AbortController().signal,
  });

test('a loaded pack shows its attribution card in the viewer container', async (t) => {
  const { presentations, settle, $, $$ } = fixture(t);
  assert.equal($('[data-director-packs]'), null);
  const handle = await media(presentations, 'clip', 'video/webm');
  await settle();
  const panel = $('[data-director-packs]');
  assert.equal(panel.tagName, 'DIV');
  assert.equal(panel.style.position, 'absolute');
  assert.equal(panel.style.right, '10px');
  assert.equal(panel.style.bottom, '70px');
  assert.equal(panel.style.zIndex, '30');
  const [card] = $$('[data-director-pack]');
  assert.equal(card.tagName, 'SECTION');
  assert.equal(card.dataset.directorPack, 'clip');
  assert.equal(card.style.maxWidth, '260px');
  assert.equal(
    card.querySelector('div').textContent,
    'clip · Synthetic · CC0-1.0',
  );
  assert.equal(card.querySelector('a'), null, 'no link without a source URL');
  const video = card.querySelector('video');
  assert.equal(video.controls, true);
  assert.equal(video.preload, 'none');
  assert.equal(video.style.width, '240px');
  assert.match(video.getAttribute('src'), /^blob:/);
  handle.dispose();
  await settle();
  assert.equal($('[data-director-packs]'), null);
});

test('a card links its source, and a removed card stops its player', async (t) => {
  const { presentations, settle, $, $$ } = fixture(t);
  const first = await media(presentations, 'one');
  const second = await presentations.media({
    pack: pack('two', 'https://example.org/two'),
    asset: { bytes: new Uint8Array([1]), mimeType: 'audio/ogg' },
    anchors: [ANCHOR],
    signal: new AbortController().signal,
  });
  await settle();
  assert.deepEqual(
    $$('[data-director-pack]').map((card) => card.dataset.directorPack),
    ['one', 'two'],
  );
  const link = $('[data-director-pack="two"] a');
  assert.equal(link.textContent, 'Source');
  assert.equal(link.getAttribute('href'), 'https://example.org/two');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  const audio = $('[data-director-pack="one"] audio');
  const calls = [];
  audio.pause = () => calls.push('pause');
  audio.load = () => calls.push('load');
  first.dispose();
  await settle();
  assert.deepEqual(calls, ['pause', 'load']);
  assert.equal(audio.getAttribute('src'), null);
  assert.equal(audio.isConnected, false);
  assert.deepEqual(
    $$('[data-director-pack]').map((card) => card.dataset.directorPack),
    ['two'],
  );
  second.dispose();
  await settle();
  assert.equal($('[data-director-packs]'), null);
});

test('each set of presentations keeps its own panel', async (t) => {
  const { presentations, viewer, store, settle, $$ } = fixture(t);
  const one = await media(presentations, 'one');
  await media(presentations, 'two');
  const later = createPackPresentations(viewer, new Map(), { store });
  const three = await media(later, 'three');
  await settle();
  const cards = () =>
    $$('[data-director-packs]').map((panel) =>
      [...panel.querySelectorAll('[data-director-pack]')].map(
        (card) => card.dataset.directorPack,
      ),
    );
  assert.deepEqual(cards(), [['one', 'two'], ['three']]);
  one.dispose();
  await settle();
  assert.deepEqual(cards(), [['two'], ['three']]);
  three.dispose();
  await settle();
  assert.deepEqual(cards(), [['two']]);
});
