import * as Cesium from 'cesium';
import { renderPackGeometry } from './geometry.js';
import { useDataPacksStore } from '../../ui/stores/dataPacks.js';
import { applicationPinia } from '../../ui/vueRuntime.js';

const xyz = (p) => Cesium.Cartesian3.fromDegrees(...p);

// Key every panel and card on the page, so a new one never reuses an old
// one's DOM.
let panelKeys = 0,
  cardKeys = 0;

/**
 * Create rendering adapters; data acquisition and authored placement stay
 * independent. Each pack's attribution card is presented to the data packs
 * store, which its view renders inside the viewer's container.
 */
export function createPackPresentations(
  viewer,
  targets = new Map(),
  { store = useDataPacksStore(applicationPinia()) } = {},
) {
  const owner = {};
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
    const entities = [],
      primitives = [],
      materials = [],
      urls = [];
    const featureKeys = [];
    let card,
      destroyed = false;
    return {
      feature(id, pickedId) {
        const key = JSON.stringify([id.packId, id.featureId]);
        targets.set(key, pickedId);
        featureKeys.push(key);
      },
      add(spec) {
        const entity = viewer.entities.add(spec);
        entities.push(entity);
        viewer.scene.requestRender();
        return entity;
      },
      primitive(value) {
        primitives.push(viewer.scene.primitives.add(value));
        if (value.appearance?.material)
          materials.push(value.appearance.material);
        viewer.scene.requestRender();
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
        for (const entity of entities.splice(0)) viewer.entities.remove(entity);
        for (const primitive of primitives.splice(0))
          viewer.scene.primitives.remove(primitive);
        for (const material of materials.splice(0)) {
          if (!material.isDestroyed()) material.destroy();
        }
        for (const url of urls.splice(0)) URL.revokeObjectURL(url);
        viewer.scene.requestRender();
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
      handle.primitive(
        new Cesium.Primitive({
          asynchronous: false,
          geometryInstances: new Cesium.GeometryInstance({
            id: { packId: pack.id },
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(...pack.placement.bounds),
              height: pack.placement.height,
              vertexFormat:
                Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            }),
          }),
          appearance: new Cesium.MaterialAppearance({
            material: Cesium.Material.fromType('Image', { image }),
            materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
            flat: true,
            faceForward: true,
            translucent: true,
          }),
        }),
      );
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
      handle.add({
        name: pack.id,
        position: xyz([anchor.lon, anchor.lat, anchor.alt]),
        point: { pixelSize: 16, color: Cesium.Color.YELLOW },
        label: {
          text: pack.id,
          font: '14px sans-serif',
          pixelOffset: new Cesium.Cartesian2(0, -24),
        },
      });
      handle.media({
        kind: asset.mimeType.startsWith('video/') ? 'video' : 'audio',
        src: handle.url(new Blob([asset.bytes], { type: asset.mimeType })),
      });
    }),
  };
}
