import * as Cesium from 'cesium';
import {
  LAYER_ID,
  LAYER_NAME,
  BOARD_WIDTH_M,
  BOARD_HEIGHT_M,
  BOARD_MOUNT_M,
  BOARD_TEXT,
  BOARD_BEZEL,
  BOARD_BACK_OFFSET_M,
  BOARD_VISIBLE_M,
  MARKER_VISIBLE_M,
  FOCUS_RANGE_M,
  GLYPH_MIN_PX,
  GLYPH_MAX_PX,
} from './policy.js';
import { currentPageIndex, signSummary, signMessageLines } from './model.js';
import { renderBoardCanvas, renderSignGlyphCanvas } from './board.js';

/**
 * Compass bearing the board's face points.
 *
 * The feed's heading is the direction of TRAVEL ("I-80 EB" is 90°). A sign
 * addresses oncoming traffic, so its face looks back down the roadway — the
 * reverse of travel.
 *
 * @param {number} travelDeg
 * @returns {number} Bearing the face points, in degrees [0..360).
 */
export function faceBearingDeg(travelDeg) {
  return (((Number(travelDeg) + 180) % 360) + 360) % 360;
}

/**
 * Point `distM` from (lat, lon) along a compass bearing, in degrees.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} bearingDeg
 * @param {number} distM
 * @returns {{lat:number, lon:number}}
 */
export function offsetLatLon(lat, lon, bearingDeg, distM) {
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180) || 1;
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    lat: lat + (distM * Math.cos(rad)) / mPerDegLat,
    lon: lon + (distM * Math.sin(rad)) / mPerDegLon,
  };
}

/** Build the per-sign display, owning entities and their canvas textures. */
export function createSignPresentation({ state, services, source }) {
  const { governorRequestRender } = services.render;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;
  const { cachedGroundFloor } = services.groundFloor;

  /**
   * Canvas per (sign, page), rebuilt only when the rendered page's content
   * changes, so a refresh does not churn a GPU texture.
   * @type {Map<string, {key:string, canvas:HTMLCanvasElement}>}
   */
  const faces = new Map();

  /** Shared across signs: at most 3 line counts x 2 states. */
  const glyphs = new Map();
  const glyphFor = (lines, selected) => {
    const key = `${lines}:${selected}`;
    if (!glyphs.has(key)) {
      glyphs.set(key, renderSignGlyphCanvas({ lines, selected }));
    }
    return glyphs.get(key);
  };

  const pageKey = (record, index) => {
    const page = record.pages[index];
    return `${index}:${page.imageUrl || page.textLines.join('')}`;
  };

  const faceFor = (record, index) => {
    const key = pageKey(record, index);
    const cached = faces.get(record.id);
    if (cached?.key === key) return cached.canvas;
    const page = record.pages[index];
    // An image page uses the board's own PNG, already host-validated.
    const canvas = page.imageUrl
      ? page.imageUrl
      : renderBoardCanvas(page.textLines, {
          justification: page.justification,
        });
    if (!canvas) return cached?.canvas || null;
    faces.set(record.id, { key, canvas });
    return canvas;
  };

  function clearRendered() {
    state.dataSource?.entities.removeAll();
    faces.clear();
    glyphs.clear();
    removeEntityContextsForLayer(LAYER_ID);
  }

  /**
   * Sync entities to the current records and the current page of each board.
   *
   * @param {number} [nowMs]
   */
  function render(nowMs = Date.now()) {
    if (!state.dataSource) return;
    const entities = state.dataSource.entities;
    const visibleIds = new Set();

    for (const record of state.records) {
      visibleIds.add(record.id);
      const index = currentPageIndex(record, nowMs);
      const face = faceFor(record, index);
      const lineCount = record.pages[index].textLines.length || 3;
      const travel = Number.isFinite(record.headingDeg) ? record.headingDeg : 0;
      const faceBearing = faceBearingDeg(travel);
      // fromDegrees takes an ELLIPSOIDAL height, so the mount height adds to
      // the resolved ground floor; the bare mount height buries the board.
      const ground = cachedGroundFloor(record.lat, record.lon);
      const grounded = Number.isFinite(ground);
      const position = Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat,
        (grounded ? ground : 0) + BOARD_MOUNT_M + BOARD_HEIGHT_M / 2,
      );
      const orientation = Cesium.Transforms.headingPitchRollQuaternion(
        position,
        new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(faceBearing), 0, 0),
      );

      // Cesium planes are double-sided and render the face mirrored from
      // behind, so an opaque housing panel occludes it from the rear.
      const backAt = offsetLatLon(
        record.lat,
        record.lon,
        faceBearingDeg(faceBearing),
        BOARD_BACK_OFFSET_M,
      );
      const backPosition = Cesium.Cartesian3.fromDegrees(
        backAt.lon,
        backAt.lat,
        (grounded ? ground : 0) + BOARD_MOUNT_M + BOARD_HEIGHT_M / 2,
      );
      const backId = `${record.id}::back`;
      let back = entities.getById(backId);
      if (!back) {
        entities.add({
          id: backId,
          position: backPosition,
          orientation,
          plane: {
            plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Y, 0),
            // Oversized so the face never peeks around its own back.
            dimensions: new Cesium.Cartesian2(
              BOARD_WIDTH_M * 1.02,
              BOARD_HEIGHT_M * 1.02,
            ),
            material: Cesium.Color.fromCssColorString(BOARD_BEZEL),
            show: grounded,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              BOARD_VISIBLE_M,
            ),
          },
        });
      } else {
        back.position = backPosition;
        back.orientation = orientation;
        back.plane.show = grounded;
      }
      visibleIds.add(backId);

      let entity = entities.getById(record.id);
      if (!entity) {
        entity = entities.add({
          id: record.id,
          position,
          orientation,
          // A plane, not a billboard: a billboard turns to the camera, which
          // would let the sign be read from behind.
          plane: {
            plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Y, 0),
            dimensions: new Cesium.Cartesian2(BOARD_WIDTH_M, BOARD_HEIGHT_M),
            material: face
              ? new Cesium.ImageMaterialProperty({
                  image: face,
                  transparent: false,
                })
              : Cesium.Color.BLACK,
            outline: true,
            outlineColor:
              Cesium.Color.fromCssColorString(BOARD_TEXT).withAlpha(0.35),
            // Hidden until the floor resolves, or it hangs at the wrong
            // altitude; the marker carries the sign meanwhile.
            show: grounded,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              BOARD_VISIBLE_M,
            ),
          },
          // The face is edge-on from above and sub-pixel at range, so this
          // glyph is what most views show, and it is the click target.
          billboard: {
            image: glyphFor(lineCount, false),
            width: GLYPH_MAX_PX,
            height: GLYPH_MAX_PX,
            // Shrinks with distance but never below a hittable size.
            scaleByDistance: new Cesium.NearFarScalar(
              200,
              1,
              MARKER_VISIBLE_M,
              GLYPH_MIN_PX / GLYPH_MAX_PX,
            ),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // From 0: the marker stays the visible and clickable anchor at
            // close range, where the board reads as edge-on from above.
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              MARKER_VISIBLE_M,
            ),
          },
        });
      } else {
        entity.position = position;
        entity.orientation = orientation;
        entity.plane.show = grounded;
        entity.billboard.image = glyphFor(
          lineCount,
          record.id === state.selectedId,
        );
        if (face) {
          entity.plane.material = new Cesium.ImageMaterialProperty({
            image: face,
            transparent: false,
          });
        }
      }

      entity.gevNe511Sign = record;
      entity.gevTrackedId = record.id;
      entity.gevLabelModel = {
        title: record.name || LAYER_NAME,
        details: [
          signSummary(record),
          ...signMessageLines(record),
          `Source: ${record.provider || source.attribution?.name || LAYER_NAME}`,
        ].filter(Boolean),
        accent: BOARD_TEXT,
      };
      registerEntityContext(entity, {
        id: record.id,
        layerId: LAYER_ID,
        dataSource: state.dataSource,
        layerName: LAYER_NAME,
        source:
          record.provider ||
          source.attribution?.description ||
          source.label ||
          LAYER_NAME,
        label: 'Message sign',
        latitude: record.lat,
        longitude: record.lon,
        properties: {
          route: record.route,
          mileMarker: record.mileMarker,
          travelDirectionDeg: record.headingDeg,
          faceBearingDeg: faceBearing,
          displayType: record.displayType,
          provider: record.provider,
          license: record.license,
          pages: record.pages.length,
          message: signMessageLines(record).join(' / '),
        },
      });
    }

    // Drop signs that stopped displaying.
    for (const entity of [...entities.values]) {
      if (!visibleIds.has(entity.id)) {
        entities.remove(entity);
        faces.delete(entity.id);
      }
    }
    // Back panels are decoration, not records: they survive the entity sweep
    // but are never selectable contexts.
    removeEntityContextsForLayer(LAYER_ID, {
      retainIds: new Set(
        [...visibleIds].filter((id) => !id.endsWith('::back')),
      ),
    });
    if (state.selectedId && !visibleIds.has(state.selectedId)) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    }
    governorRequestRender?.();
  }

  /**
   * Highlight one sign and publish it as the selected context.
   *
   * @param {string} id
   * @returns {boolean} Whether the sign was selectable.
   */
  function selectSign(id) {
    const entity = state.dataSource?.entities.getById(id);
    if (!entity || !state.recordById.has(id)) return false;
    clearSelection();
    state.selectedId = id;
    const record = state.recordById.get(id);
    const index = currentPageIndex(record, Date.now());
    entity.billboard.image = glyphFor(
      record.pages[index].textLines.length || 3,
      true,
    );
    selectEntityContext(entity);
    governorRequestRender?.('signs-selection');
    return true;
  }

  function clearSelection() {
    const entity = state.selectedId
      ? state.dataSource?.entities.getById(state.selectedId)
      : null;
    const record = state.recordById.get(state.selectedId);
    if (entity?.billboard && record) {
      const index = currentPageIndex(record, Date.now());
      entity.billboard.image = glyphFor(
        record.pages[index].textLines.length || 3,
        false,
      );
    }
    if (state.selectedId) clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  }

  /**
   * Fly to where the board can be read: in front of the face, level with it,
   * looking back along the face bearing. A sign is only legible head-on.
   *
   * @param {string} id
   * @returns {boolean}
   */
  function focusSign(id) {
    const record = state.recordById.get(id);
    const viewer = state.viewer;
    if (!record || !viewer) return false;
    if (!selectSign(id)) return false;

    const ground = cachedGroundFloor(record.lat, record.lon);
    const height =
      (Number.isFinite(ground) ? ground : 0) +
      BOARD_MOUNT_M +
      BOARD_HEIGHT_M / 2;
    const face = faceBearingDeg(
      Number.isFinite(record.headingDeg) ? record.headingDeg : 0,
    );
    // Stand in front of the face, along the direction it points.
    const standAt = offsetLatLon(record.lat, record.lon, face, FOCUS_RANGE_M);
    const view = {
      destination: Cesium.Cartesian3.fromDegrees(
        standAt.lon,
        standAt.lat,
        height,
      ),
      orientation: {
        // Look back at the board.
        heading: Cesium.Math.toRadians((face + 180) % 360),
        pitch: 0,
        roll: 0,
      },
    };
    viewer.camera.flyTo({
      ...view,
      duration: 1.2,
      // Any camera input cancels a flight in progress. Without this the
      // viewer is stranded wherever the arc had reached — often behind the
      // board, which is the one place a sign cannot be read from.
      cancel: () => {
        viewer.camera.setView(view);
        governorRequestRender?.('signs-focus');
      },
    });
    governorRequestRender?.('signs-focus');
    return true;
  }

  /**
   * Left-click selects a sign and flies to read it. The back panel is a
   * separate entity, so a click on it resolves to the sign it belongs to.
   *
   * @param {object} viewer
   */
  function installInteraction(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction((click) => {
      if (!state.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const rawId = typeof picked?.id?.id === 'string' ? picked.id.id : null;
      const id = rawId?.endsWith('::back')
        ? rawId.slice(0, -'::back'.length)
        : rawId;
      if (
        id &&
        state.recordById.has(id) &&
        (id !== state.selectedId || getSelectedEntityContext()?.id !== id)
      ) {
        focusSign(id);
      } else if (state.selectedId) {
        clearSelection();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  return {
    render,
    clearRendered,
    selectSign,
    focusSign,
    clearSelection,
    installInteraction,
  };
}
