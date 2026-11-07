import { createPackRenderer } from './display.js';
import { decodePackGeoJSON } from '../../director/packs/geojson.js';
import { useDataPacksStore } from '../../ui/stores/dataPacks.js';
import { applicationPinia } from '../../ui/vueRuntime.js';

// Key every panel and card on the page, so a new one never reuses an old
// one's DOM.
let panelKeys = 0,
  cardKeys = 0;

/**
 * Create rendering adapters; data acquisition and authored placement stay
 * independent. Each pack's attribution card is presented to the data packs
 * store, which its view renders inside the engine's container.
 */
export function createPackPresentations(
  engine,
  targets = new Map(),
  {
    store = useDataPacksStore(applicationPinia()),
    container = engine?.host?.container,
  } = {},
) {
  let renderer = engine ? createPackRenderer(engine) : null;
  const owner = {};
  const resources = new Set();
  let key,
    cards = [];
  function present() {
    store.publish(owner, cards.length ? { key, container, cards } : null);
  }
  function addCard(pack) {
    if (!cards.length) key = ++panelKeys;
    const card = {
      key: ++cardKeys,
      id: pack.id,
      title: `${pack.id} · ${pack.attribution.text} · ${pack.attribution.license}`,
      url: pack.attribution.url || null,
      media: null,
    };
    cards = [...cards, card];
    present();
    return card.key;
  }
  function updateCard(key, patch) {
    cards = cards.map((card) =>
      card.key === key ? { ...card, ...patch } : card,
    );
    present();
  }
  function removeCard(key) {
    cards = cards.filter((card) => card.key !== key);
    present();
  }
  function resource(pack) {
    const urls = [];
    const featureKeys = [];
    let card,
      draw,
      destroyed = false;
    const removers = [];
    const handle = {
      own(remove) {
        removers.push(remove);
      },
      display(render) {
        draw = render;
        if (renderer) draw(renderer);
      },
      redraw() {
        if (!destroyed && renderer) draw?.(renderer);
      },
      detach() {
        for (const key of featureKeys.splice(0)) targets.delete(key);
        for (const remove of removers.splice(0).reverse()) remove();
        engine?.render?.request('scene-pack');
      },
      feature(id, pickedId) {
        const key = JSON.stringify([id.packId, id.featureId]);
        targets.set(key, pickedId);
        featureKeys.push(key);
      },
      card() {
        card ||= addCard(pack);
      },
      /** @param {{kind: 'video'|'audio', src: string}} media */
      media(media) {
        card ||= addCard(pack);
        updateCard(card, { media });
      },
      url(blob) {
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return url;
      },
      dispose() {
        if (destroyed) return;
        destroyed = true;
        handle.detach();
        resources.delete(handle);
        if (card) removeCard(card);
        for (const url of urls.splice(0)) URL.revokeObjectURL(url);
      },
    };
    resources.add(handle);
    return handle;
  }
  function guarded(render) {
    return async (context) => {
      const handle = resource(context.pack);
      const abort = () => handle.dispose();
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        context.signal.throwIfAborted();
        await render(context, handle);
        context.signal.throwIfAborted();
        handle.card();
        return handle;
      } catch (error) {
        handle.dispose();
        throw error;
      } finally {
        context.signal.removeEventListener('abort', abort);
      }
    };
  }
  return {
    setScene(nextEngine, nextContainer) {
      for (const handle of resources) handle.detach();
      engine = nextEngine;
      renderer = engine ? createPackRenderer(engine) : null;
      if (nextContainer) container = nextContainer;
      for (const handle of resources) handle.redraw();
      if (cards.length) present();
    },
    geojson: guarded(({ asset, pack }, handle) => {
      if (
        !['application/json', 'application/geo+json'].includes(asset.mimeType)
      )
        throw new Error('Expected GeoJSON');
      const features = decodePackGeoJSON(asset.bytes);
      handle.display((renderer) => renderer.geometry(pack, features, handle));
    }),
    image: guarded(async ({ asset, pack, signal }, handle) => {
      if (asset.mimeType !== 'image/png') throw new Error('Expected PNG image');
      const bytes = asset.bytes;
      if (
        bytes.length < 24 ||
        ![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
          (v, i) => bytes[i] === v,
        )
      )
        throw new Error('Invalid PNG header');
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const width = header.getUint32(16),
        height = header.getUint32(20);
      if (!width || !height || width > 4096 || height > 4096)
        throw new Error('Image dimensions exceed limit');
      const image = new Image();
      image.src = handle.url(new Blob([asset.bytes], { type: asset.mimeType }));
      const abort = () => {
        image.src = '';
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await image.decode();
      } finally {
        signal.removeEventListener('abort', abort);
      }
      signal.throwIfAborted();
      if (image.naturalWidth * image.naturalHeight > 16 * 1024 * 1024)
        throw new Error('Image dimensions exceed limit');
      handle.display((renderer) => renderer.image(pack, image, handle));
    }),
    media: guarded(({ asset, pack, anchors }, handle) => {
      if (
        ![
          'video/mp4',
          'video/webm',
          'audio/mpeg',
          'audio/ogg',
          'audio/wav',
          'audio/webm',
        ].includes(asset.mimeType)
      )
        throw new Error('Unsupported media');
      const anchor = anchors.find(
        (item) => item.id === pack.placement.anchorId,
      );
      if (!anchor) throw new Error('Missing media anchor');
      handle.display((renderer) => renderer.media(pack, anchor, handle));
      handle.media({
        kind: asset.mimeType.startsWith('video/') ? 'video' : 'audio',
        src: handle.url(new Blob([asset.bytes], { type: asset.mimeType })),
      });
    }),
  };
}
