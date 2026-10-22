/**
 * Geofence renderer: Cesium entities for boundary + interior fill.
 *
 * Owns a dedicated CustomDataSource `gev-geofence` so the geofence survives
 * independently of the whiteboard annotations. Renders:
 * - interior fill: polygon draped on terrain + 3D tiles (ClassificationType.BOTH)
 * - boundary: glowing polyline, closed ring, clamped to ground
 * - draft preview: dashed line + vertex points while drawing
 * - edit handles: point entities for each vertex while editing
 */
import * as Cesium from 'cesium';

const DATA_SOURCE_NAME = 'gev-geofence';
const FILL_COLOR = '#3fd8ff';
const BOUNDARY_COLOR = '#8be9ff';

export function createGeofenceRenderer(viewer) {
  const dataSource = new Cesium.CustomDataSource(DATA_SOURCE_NAME);
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );

  let fillEntity = null;
  let boundaryEntity = null;
  let previewLine = null;
  const previewPoints = [];
  const editHandles = [];

  const toCartesian = (lonLat) =>
    Cesium.Cartesian3.fromDegrees(lonLat[0], lonLat[1], 0);

  const closedPositions = (ring) => {
    const closed =
      ring.length >= 3 &&
      (ring[0][0] !== ring[ring.length - 1][0] ||
        ring[0][1] !== ring[ring.length - 1][1])
        ? [...ring, ring[0]]
        : ring;
    return closed.map(toCartesian);
  };

  function ensurePreviewLine() {
    if (previewLine) return previewLine;
    previewLine = dataSource.entities.add({
      show: false,
      polyline: {
        positions: [],
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(BOUNDARY_COLOR).withAlpha(0.9),
          dashLength: 12,
        }),
        clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    return previewLine;
  }

  function clearPreview() {
    if (previewLine) previewLine.show = false;
    for (const e of previewPoints.splice(0)) {
      try {
        dataSource.entities.remove(e);
      } catch {}
    }
  }

  function clearHandles() {
    for (const e of editHandles.splice(0)) {
      try {
        dataSource.entities.remove(e);
      } catch {}
    }
  }

  function setDraft(vertices, cursorCartesian = null) {
    clearHandles();
    // Hide finished geofence while drafting a new one
    setGeofenceVisible(false);
    const line = ensurePreviewLine();
    if (!vertices?.length) {
      line.show = false;
      clearPreviewPointsOnly();
      viewer.scene.requestRender();
      return;
    }
    const pts = vertices.map((v) =>
      Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
    );
    if (cursorCartesian) pts.push(cursorCartesian);
    // show closing edge when enough points
    if (vertices.length >= 3) {
      const first = Cesium.Cartesian3.fromDegrees(
        vertices[0].lon,
        vertices[0].lat,
        0,
      );
      // only close preview when not following cursor, else rubber band already shows it
      if (!cursorCartesian) pts.push(first);
    }
    line.polyline.positions = pts;
    line.show = vertices.length >= 1;

    clearPreviewPointsOnly();
    const stroke = Cesium.Color.fromCssColorString(BOUNDARY_COLOR);
    for (const v of vertices) {
      previewPoints.push(
        dataSource.entities.add({
          position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
          point: {
            pixelSize: 8,
            color: stroke,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    viewer.scene.requestRender();
  }

  function clearPreviewPointsOnly() {
    for (const e of previewPoints.splice(0)) {
      try {
        dataSource.entities.remove(e);
      } catch {}
    }
  }

  function setGeofence(ring) {
    clearPreview();
    clearHandles();
    // remove old
    if (fillEntity) {
      try {
        dataSource.entities.remove(fillEntity);
      } catch {}
      fillEntity = null;
    }
    if (boundaryEntity) {
      try {
        dataSource.entities.remove(boundaryEntity);
      } catch {}
      boundaryEntity = null;
    }
    if (!ring || ring.length < 3) {
      viewer.scene.requestRender();
      return;
    }
    const positions = closedPositions(ring);
    const fillColor =
      Cesium.Color.fromCssColorString(FILL_COLOR).withAlpha(0.22);
    const lineColor = Cesium.Color.fromCssColorString(BOUNDARY_COLOR);

    fillEntity = dataSource.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: new Cesium.ColorMaterialProperty(fillColor),
        classificationType: Cesium.ClassificationType.BOTH,
        stRotation: 0,
      },
    });
    boundaryEntity = dataSource.entities.add({
      polyline: {
        positions,
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.3,
          color: lineColor.withAlpha(0.95),
        }),
        clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    viewer.scene.requestRender();
  }

  function setGeofenceVisible(visible) {
    if (fillEntity) fillEntity.show = visible;
    if (boundaryEntity) boundaryEntity.show = visible;
  }

  function setEditHandles(vertices) {
    clearHandles();
    if (!vertices?.length) {
      viewer.scene.requestRender();
      return;
    }
    const stroke = Cesium.Color.fromCssColorString('#ffd166');
    vertices.forEach((v, idx) => {
      const e = dataSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
        point: {
          pixelSize: 12,
          color: stroke,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      e._geofenceVertexIndex = idx;
      editHandles.push(e);
    });
    viewer.scene.requestRender();
  }

  function clear() {
    if (fillEntity) {
      try {
        dataSource.entities.remove(fillEntity);
      } catch {}
      fillEntity = null;
    }
    if (boundaryEntity) {
      try {
        dataSource.entities.remove(boundaryEntity);
      } catch {}
      boundaryEntity = null;
    }
    clearPreview();
    clearHandles();
    viewer.scene.requestRender();
  }

  function destroy() {
    clear();
    if (previewLine) {
      try {
        dataSource.entities.remove(previewLine);
      } catch {}
      previewLine = null;
    }
    attaching = attaching.then(() => {
      try {
        viewer.dataSources.remove(dataSource, true);
      } catch {}
    });
    return attaching;
  }

  return {
    setDraft,
    setGeofence,
    setEditHandles,
    clear,
    destroy,
    whenSettled: () => attaching,
    diagnostics() {
      return {
        hasFill: Boolean(fillEntity),
        hasBoundary: Boolean(boundaryEntity),
        previewPoints: previewPoints.length,
        editHandles: editHandles.length,
        dataSources: (() => {
          let n = 0;
          const ds = viewer?.dataSources;
          if (!ds) return 0;
          for (let i = 0; i < ds.length; i += 1)
            if (ds.get(i)?.name === DATA_SOURCE_NAME) n += 1;
          return n;
        })(),
      };
    },
  };
}

export const GEOFENCE_DATA_SOURCE_NAME = DATA_SOURCE_NAME;
