import * as Cesium from 'cesium';
import { USGS_WATER_LAYER_ID } from './config.js';

/** A small, static site display; water measurements never determine marker altitude. */
export function createUsgsWaterRenderer({ viewer }) {
  if (!viewer?.dataSources) throw new TypeError('USGS water requires a viewer');
  let destroyed = false;
  let visible = false;
  let current = null;
  let generation = 0;
  const pending = new Set();
  const release = (source) => {
    if (!source) return;
    try {
      if (!viewer.dataSources.isDestroyed?.())
        viewer.dataSources.remove(source, true);
    } catch {
      /* A host removal listener cannot retain this source's entities. */
    } finally {
      source.entities.removeAll();
    }
  };
  return {
    async replace(sites) {
      if (destroyed) return false;
      const token = ++generation;
      const source = new Cesium.CustomDataSource(USGS_WATER_LAYER_ID);
      source.show = false;
      for (const site of sites)
        source.entities.add({
          id: site.id,
          name: site.name,
          position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
          point: {
            pixelSize: 10,
            color: Cesium.Color.fromCssColorString(
              site.numericReadingCount ? '#4fc3f7' : '#b0bec5',
            ),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              350000,
            ),
          },
        });
      pending.add(source);
      try {
        await viewer.dataSources.add(source);
        if (destroyed || token !== generation) {
          release(source);
          return false;
        }
        const previous = current;
        current = source;
        source.show = visible;
        release(previous);
        viewer.scene.requestRender?.();
        return true;
      } catch (error) {
        release(source);
        throw error;
      } finally {
        pending.delete(source);
      }
    },
    setVisible(value) {
      visible = Boolean(value);
      if (current) current.show = visible;
      viewer.scene.requestRender?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      release(current);
      current = null;
      for (const source of pending) release(source);
      viewer.scene.requestRender?.();
    },
  };
}
