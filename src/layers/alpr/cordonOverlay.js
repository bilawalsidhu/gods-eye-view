/**
 * @file Cordon rendering: the town boundary as a translucent ground line and
 * one gate dot per road entry — cyan when a mapped reader covers the entry,
 * coral (with the road name) when it is a gap. Owns its own data source so
 * the camera markers' render path stays untouched.
 */

import * as Cesium from 'cesium';
import { ALPR_COLOR, ALPR_SELECTED_COLOR } from './policy.js';

export function createCordonOverlay() {
  let viewer = null;
  let dataSource = null;
  return {
    init(hostViewer) {
      viewer = hostViewer;
      dataSource = new Cesium.CustomDataSource('alpr-cordon');
      viewer.dataSources.add(dataSource);
    },
    render({ ring, gates }) {
      if (!dataSource) return;
      dataSource.entities.removeAll();
      const covered = Cesium.Color.fromCssColorString(ALPR_COLOR);
      const gap = Cesium.Color.fromCssColorString(ALPR_SELECTED_COLOR);
      if (Array.isArray(ring) && ring.length >= 3) {
        const closed = [...ring, ring[0]];
        dataSource.entities.add({
          id: 'cordon:boundary',
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(closed.flat()),
            width: 2,
            material: covered.withAlpha(0.45),
            clampToGround: true,
          },
        });
      }
      gates.forEach((gate, index) => {
        dataSource.entities.add({
          id: `cordon:gate:${index}`,
          position: Cesium.Cartesian3.fromDegrees(gate.lon, gate.lat),
          point: {
            pixelSize: gate.covered ? 9 : 12,
            color: gate.covered ? covered : gap,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          // Only gaps carry a label: they are the finding, and labeling
          // every covered gate would wallpaper a well-cordoned town.
          label: gate.covered
            ? undefined
            : {
                text: (gate.name || gate.ref || gate.baseCls).toUpperCase(),
                font: '12px system-ui',
                fillColor: gap,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -16),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
        });
      });
    },
    clear() {
      dataSource?.entities.removeAll();
    },
    destroy() {
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },
  };
}
