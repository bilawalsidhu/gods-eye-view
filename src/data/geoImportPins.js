import * as Cesium from 'cesium';

const STYLE = [
  'image',
  'scale',
  'rotation',
  'alignedAxis',
  'horizontalOrigin',
  'verticalOrigin',
  'color',
  'eyeOffset',
  'pixelOffset',
  'width',
  'height',
  'scaleByDistance',
  'translucencyByDistance',
  'pixelOffsetScaleByDistance',
  'distanceDisplayCondition',
  'sizeInMeters',
  'disableDepthTestDistance',
  'imageSubRegion',
];

class ImportedBillboards extends Cesium.BillboardCollection {
  update(frameState) {
    // Height queries should find the map, never another imported marker.
    // Ordinary click picks and rendered screenshots still include the pins.
    if (frameState.passes.pick && frameState.passes.offscreen) return;
    super.update(frameState);
  }
}

/** Own static imported pins without a per-frame Entity visualizer walk. */
export function createImportedPins(dataSource, viewer) {
  const all = dataSource.entities.values.slice();
  const now = Cesium.JulianDate.now();
  const pins = all.filter((entity) => entity.billboard && entity.position);
  if (!pins.length) return { mount() {}, sync() {}, destroy() {} };
  const collection = new ImportedBillboards({ scene: viewer.scene });
  const billboards = [];
  try {
    for (const entity of pins) {
      const position = entity.position.getValue(now);
      if (
        !position ||
        ![position.x, position.y, position.z].every(Number.isFinite)
      )
        throw new Error('Invalid imported point position.');
      const options = {
        id: entity,
        position,
        show:
          entity.isShowing && entity.billboard.show?.getValue(now) !== false,
        heightReference: Cesium.HeightReference.NONE,
      };
      for (const key of STYLE) {
        const value = entity.billboard[key]?.getValue(now);
        if (value !== undefined) options[key] = value;
      }
      billboards.push(collection.add(options));
    }
  } catch (error) {
    collection.destroy();
    throw error;
  }
  // Rebuild once before the source is added to DataSourceDisplay. Removing
  // one entity at a time would itself make this transition quadratic.
  dataSource.entities.suspendEvents();
  try {
    dataSource.entities.removeAll();
    for (const entity of all)
      if (!entity.billboard || !entity.position)
        dataSource.entities.add(entity);
  } finally {
    dataSource.entities.resumeEvents();
  }
  Object.defineProperty(dataSource, 'importedEntities', {
    value: all,
    configurable: true,
  });
  Object.defineProperty(dataSource, 'importedBillboards', {
    value: collection,
    configurable: true,
  });
  let show = dataSource.show,
    mounted = false,
    destroyed = false;
  Object.defineProperty(dataSource, 'show', {
    configurable: true,
    get: () => show,
    set(value) {
      show = Boolean(value);
      dataSource.entities.show = show;
      collection.show = show;
    },
  });
  collection.show = show;
  return {
    mount() {
      if (destroyed || mounted) return;
      viewer.scene.primitives?.add(collection);
      mounted = true;
    },
    sync() {
      if (destroyed) return;
      for (let i = 0; i < pins.length; i++) {
        billboards[i].position = pins[i].position.getValue(now);
        billboards[i].show =
          pins[i].isShowing && pins[i].billboard.show?.getValue(now) !== false;
      }
      viewer.scene.requestRender?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (viewer.trackedEntity && pins.includes(viewer.trackedEntity))
        viewer.trackedEntity = undefined;
      if (viewer.selectedEntity && pins.includes(viewer.selectedEntity))
        viewer.selectedEntity = undefined;
      if (mounted && !viewer.scene.primitives?.isDestroyed?.())
        viewer.scene.primitives?.remove(collection);
      if (!collection.isDestroyed()) collection.destroy();
      all.length = 0;
      pins.length = 0;
      billboards.length = 0;
    },
  };
}
