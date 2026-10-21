import * as Cesium from 'cesium';
import { horizonOutline } from './model.js';
import { ANTENNA_COLOR } from './policy.js';

const FEET_TO_METERS = 0.3048;
const WALL_ALPHA = 0.2;
const RIM_ALPHA = 0.95;
const RIM_WIDTH = 2;
/** The antenna mast rises through the whole shell. */
const MAST_HEIGHT_FT = 45_000;

function colorAttribute(color, alpha) {
  return Cesium.ColorGeometryInstanceAttribute.fromColor(
    Cesium.Color.fromCssColorString(color).withAlpha(alpha),
  );
}

function arcPositions(arc, antenna, heightM) {
  return Cesium.Cartesian3.fromDegreesArrayHeights(
    horizonOutline(arc, antenna).flatMap((point) => [
      point.lon,
      point.lat,
      heightM,
    ]),
  );
}

function polylineInstance(positions, color, alpha = RIM_ALPHA) {
  return new Cesium.GeometryInstance({
    geometry: new Cesium.PolylineGeometry({
      positions,
      width: RIM_WIDTH,
      arcType: Cesium.ArcType.NONE,
      vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
    }),
    attributes: { color: colorAttribute(color, alpha) },
  });
}

/**
 * Drawn heights for a barometric altitude. `verticalScale` stretches heights
 * for display only; ranges and positions are never scaled.
 * @param {number} feet
 * @param {number} [verticalScale]
 * @returns {number} Metres above the ellipsoid.
 */
export function horizonHeightM(feet, verticalScale = 1) {
  return Math.max(0, feet) * FEET_TO_METERS * verticalScale;
}

/**
 * Geometry for one horizon snapshot, as plain instance lists (testable
 * without a GPU): per band and per outline run, a translucent wall from the
 * band floor to its ceiling and a bright rim along the ceiling; a mast at
 * the antenna; a drop line under the farthest position heard.
 * @param {object} snapshot `createHorizonModel().snapshot()`.
 * @param {{verticalScale?: number}} [options]
 * @returns {{walls: Cesium.GeometryInstance[], lines: Cesium.GeometryInstance[]}}
 */
export function horizonGeometry(snapshot, { verticalScale = 1 } = {}) {
  const walls = [];
  const lines = [];
  const height = (feet) => horizonHeightM(feet, verticalScale);
  for (const band of snapshot.antenna ? snapshot.bands : []) {
    const floorM = height(band.drawFloorFt);
    const ceilingM = height(band.drawCeilingFt);
    for (const arc of band.arcs) {
      const positions = arcPositions(arc, snapshot.antenna, ceilingM);
      walls.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.WallGeometry({
            positions,
            minimumHeights: positions.map(() => floorM),
            maximumHeights: positions.map(() => ceilingM),
            vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: { color: colorAttribute(band.color, WALL_ALPHA) },
        }),
      );
      lines.push(polylineInstance(positions, band.color));
    }
  }
  const { antenna, farthest } = snapshot;
  if (antenna) {
    lines.push(
      polylineInstance(
        Cesium.Cartesian3.fromDegreesArrayHeights([
          antenna.lon,
          antenna.lat,
          0,
          antenna.lon,
          antenna.lat,
          height(MAST_HEIGHT_FT),
        ]),
        ANTENNA_COLOR,
        0.7,
      ),
    );
  }
  if (farthest) {
    const band = snapshot.bands.find((entry) => entry.id === farthest.bandId);
    lines.push(
      polylineInstance(
        Cesium.Cartesian3.fromDegreesArrayHeights([
          farthest.lon,
          farthest.lat,
          0,
          farthest.lon,
          farthest.lat,
          height(farthest.altitudeFt),
        ]),
        band?.color || ANTENNA_COLOR,
      ),
    );
  }
  return { walls, lines };
}

/**
 * Draws horizon snapshots into one primitive collection it owns.
 *
 * Every primitive is built with `allowPicking: false`: the shell surrounds
 * the aircraft it was measured from, and a click must reach them through it.
 * Geometry is built synchronously, at most once per snapshot shape.
 * @param {object} options
 * @param {{add: Function, remove: Function}} options.primitives The scene's
 *   primitive collection.
 * @returns {object} Renderer: draw, setVisible, destroy.
 */
export function createHorizonRenderer({ primitives }) {
  const collection = primitives.add(
    new Cesium.PrimitiveCollection({ show: false }),
  );
  let drawnKey = null;

  return {
    /**
     * Replace the drawn shell when the snapshot's shape, the antenna or the
     * display scale changed.
     * @param {object} snapshot
     * @param {{verticalScale?: number}} [options]
     * @returns {boolean} Whether anything was redrawn.
     */
    draw(snapshot, { verticalScale = 1 } = {}) {
      const key = `${snapshot.shapeVersion}|${snapshot.antenna?.lat},${snapshot.antenna?.lon}|${verticalScale}`;
      if (key === drawnKey) return false;
      drawnKey = key;
      collection.removeAll();
      const { walls, lines } = horizonGeometry(snapshot, { verticalScale });
      if (walls.length)
        collection.add(
          new Cesium.Primitive({
            geometryInstances: walls,
            appearance: new Cesium.PerInstanceColorAppearance({
              flat: true,
              translucent: true,
            }),
            allowPicking: false,
            asynchronous: false,
          }),
        );
      if (lines.length)
        collection.add(
          new Cesium.Primitive({
            geometryInstances: lines,
            appearance: new Cesium.PolylineColorAppearance({
              translucent: true,
            }),
            allowPicking: false,
            asynchronous: false,
          }),
        );
      return true;
    },

    setVisible(visible) {
      collection.show = Boolean(visible);
    },

    destroy() {
      primitives.remove(collection);
      if (!collection.isDestroyed?.()) collection.destroy?.();
    },
  };
}
