import * as Cesium from 'cesium';
import { renderPackGeometry } from './geometry.js';

function caption(viewer, pack) {
  const card = document.createElement('section');
  card.dataset.directorPack = pack.id;
  Object.assign(card.style, {
    color: '#e3faff',
    background: '#08141eed',
    border: '1px solid #2491a8',
    padding: '8px',
    margin: '4px',
    maxWidth: '260px',
    font: '12px sans-serif',
  });
  const title = document.createElement('div');
  title.textContent = `${pack.id} · ${pack.attribution.text} · ${pack.attribution.license}`;
  card.append(title);
  if (pack.attribution.url) {
    const link = document.createElement('a');
    link.textContent = 'Source';
    link.href = pack.attribution.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.color = '#6eeaff';
    card.append(link);
  }
  return card;
}
const xyz = (p) => Cesium.Cartesian3.fromDegrees(...p);

/** Create rendering adapters; data acquisition and authored placement stay independent. */
export function createPackPresentations(viewer, targets = new Map()) {
  let panel;
  function addCard(pack) {
    if (!panel) {
      panel = document.createElement('div');
      panel.dataset.directorPacks = '';
      Object.assign(panel.style, {
        position: 'absolute',
        right: '10px',
        bottom: '70px',
        maxHeight: '40vh',
        overflowY: 'auto',
        zIndex: '30',
      });
      viewer.container.append(panel);
    }
    const card = caption(viewer, pack);
    panel.append(card);
    return card;
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
        return (card ||= addCard(pack));
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
        for (const media of card?.querySelectorAll('video,audio') || []) {
          media.pause();
          media.removeAttribute('src');
          media.load();
        }
        card?.remove();
        if (panel && !panel.childElementCount) {
          panel.remove();
          panel = null;
        }
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
      const media = document.createElement(
        asset.mimeType.startsWith('video/') ? 'video' : 'audio',
      );
      media.controls = true;
      media.preload = 'none';
      media.style.width = '240px';
      media.src = handle.url(new Blob([asset.bytes], { type: asset.mimeType }));
      handle.card().append(media);
    }),
  };
}
