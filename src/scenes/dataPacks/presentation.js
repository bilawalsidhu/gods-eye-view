import { packItemId, renderPackGeometry } from './geometry.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame } from '../../render/rendererOf.js';
import { useDataPacksStore } from '../../ui/stores/dataPacks.js';
import { applicationPinia } from '../../ui/vueRuntime.js';

const MEDIA_MARKER_CSS = '#ffff00';

// Key every panel and card on the page, so a new one never reuses an old
// one's DOM.
let panelKeys = 0,
  cardKeys = 0;

// Draw sets, one per pack resource and kind, unique among the renderer's.
let drawSets = 0;

// Label overlay sources, one per pack resource while it shows text, so two
// presentations of one pack never share or clear each other's labels. The host
// keeps a source once made, so a disposed resource returns its id for reuse
// and the count stays at the most labelled resources ever shown at once.
let labelSources = 0;
const freeLabelSources = [];

/**
 * Create rendering adapters; data acquisition and authored placement stay
 * independent. Packs draw through the viewer's draw port (`drawOf`); a
 * feature's pick target is its draw set and item id. Each pack's attribution
 * card is presented to the data packs store, which its view renders inside
 * the viewer's container.
 */
export function createPackPresentations(
  viewer,
  targets = new Map(),
  { store = useDataPacksStore(applicationPinia()), overlayHost = null } = {},
) {
  const owner = {};
  const requestRender = () => findFrame(viewer)?.requestRender('data-pack');
  let key,
    cards = [];
  function present() {
    store.publish(
      owner,
      cards.length ? { key, container: viewer.container, cards } : null,
    );
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
    const sets = [],
      urls = [],
      labels = [];
    const featureKeys = [];
    let labelSource = null;
    let card,
      destroyed = false;
    return {
      feature(id, pickedId) {
        const key = JSON.stringify([id.packId, id.featureId]);
        targets.set(key, pickedId);
        featureKeys.push(key);
      },
      /**
       * Draw `items` as a new set of `kind` (`points`, `lines`, `shapes`)
       * owned by this resource.
       * @returns {string} The set's id.
       */
      draw(kind, items) {
        const set = drawOf(viewer)[kind]({ id: `data-pack:${++drawSets}` });
        sets.push(set);
        set.set(items);
        requestRender();
        return set.id;
      },
      /**
       * World text for this pack, as a label-overlay entry in the pack's own
       * source. The application passes the shared host; there is no text
       * without one, so a pack that needs it fails to load instead.
       */
      label(entry) {
        if (!overlayHost) throw new Error('Pack labels need an overlay host');
        // A late adapter writing after disposal must not take a source again.
        if (destroyed) return;
        labelSource ||=
          freeLabelSources.pop() ?? `data-pack-labels:${++labelSources}`;
        labels.push(entry);
        overlayHost.setEntries(labelSource, labels.slice());
        requestRender();
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
        for (const key of featureKeys.splice(0)) targets.delete(key);
        // The view stops a removed card's player as it goes.
        if (card) removeCard(card);
        for (const set of sets.splice(0)) set.dispose();
        if (labelSource) {
          labels.length = 0;
          overlayHost.clearSource(labelSource);
          freeLabelSources.push(labelSource);
          labelSource = null;
        }
        for (const url of urls.splice(0)) URL.revokeObjectURL(url);
        requestRender();
      },
    };
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
    geojson: guarded(renderPackGeometry),
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
      // The draw port takes images as URLs, SVG or canvases; a canvas
      // keeps the decoded pixels, so nothing loads again.
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const [west, south, east, north] = pack.placement.bounds;
      handle.draw('shapes', [
        {
          id: packItemId(pack.id, 'image'),
          geometry: {
            kind: 'rectangle',
            rect: { west, south, east, north },
            height: pack.placement.height,
          },
          fill: { image: { canvas, key: image.src } },
        },
      ]);
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
      const position = fromDegrees(anchor.lon, anchor.lat, anchor.alt);
      handle.draw('points', [
        {
          id: packItemId(pack.id, 'media'),
          pos: position,
          pixelSize: 16,
          color: MEDIA_MARKER_CSS,
        },
      ]);
      handle.label({
        id: 'media',
        position,
        variant: 'label',
        title: pack.id,
        accent: MEDIA_MARKER_CSS,
        protected: true,
        interactive: false,
        gapPx: 15,
        verticalOnly: true,
        placement: 'above',
      });
      handle.media({
        kind: asset.mimeType.startsWith('video/') ? 'video' : 'audio',
        src: handle.url(new Blob([asset.bytes], { type: asset.mimeType })),
      });
    }),
  };
}
