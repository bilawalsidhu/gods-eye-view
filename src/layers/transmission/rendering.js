import * as Cesium from 'cesium';
import { recordColor } from './model.js';
export const PICK_PREFIX = 'transmission:';

/** Build only the current bounded cohort; area markers are representative points. */
export function createTransmissionDisplay(rows, bbox) {
  const ds = new Cesium.CustomDataSource('transmission');
  const coordinates = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
    [bbox[0], bbox[1]],
  ];
  ds.entities.add({
    id: 'transmission-coverage',
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(coordinates.flat()),
      width: 1.5,
      clampToGround: true,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#8ca4b8'),
      }),
      classificationType: Cesium.ClassificationType.BOTH,
    },
  });
  for (const row of rows) {
    const color = Cesium.Color.fromCssColorString(recordColor(row));
    if (row.kind === 'line') {
      row.geometry.coordinates.forEach((part, index) =>
        ds.entities.add({
          id: `${PICK_PREFIX}${row.id}:${index}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(part.flat()),
            width: 2.5,
            clampToGround: true,
            material: new Cesium.ColorMaterialProperty(color),
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
    } else {
      const unknown = row.voltageState === 'unknown';
      ds.entities.add({
        id: `${PICK_PREFIX}${row.id}:0`,
        position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
        point: {
          pixelSize: unknown ? 7 : 10,
          color: unknown ? Cesium.Color.fromCssColorString('#17212b') : color,
          outlineColor: unknown ? color : Cesium.Color.BLACK,
          outlineWidth: unknown ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Ground markers remain legible above the terrain skin.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
  return ds;
}
