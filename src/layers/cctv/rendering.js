import * as Cesium from 'cesium';
import { isHeadingEstimated } from './headingConfidence.js';
import {
  ACTIVE_CAMERA_COLOR as ACTIVE_CAMERA_RGBA,
  CAMERA_ICON,
  IDLE_CAMERA_COLOR as IDLE_CAMERA_RGBA,
  LIVE_CAMERA_COLOR as LIVE_CAMERA_RGBA,
  ACTIVE_COVERAGE_CENTER as ACTIVE_COVERAGE_CENTER_RGBA,
  IDLE_COVERAGE_CENTER_MUTED as IDLE_COVERAGE_CENTER_MUTED_RGBA,
  ACTIVE_COVERAGE_CENTER_DEPTHFAIL as ACTIVE_COVERAGE_CENTER_DEPTHFAIL_RGBA,
  ACTIVE_COVERAGE_EDGE as ACTIVE_COVERAGE_EDGE_RGBA,
  IDLE_COVERAGE_EDGE_MUTED as IDLE_COVERAGE_EDGE_MUTED_RGBA,
  ACTIVE_COVERAGE_EDGE_DEPTHFAIL as ACTIVE_COVERAGE_EDGE_DEPTHFAIL_RGBA,
  IDLE_COVERAGE_COLOR as IDLE_COVERAGE_RGBA,
  VIEW_CELL_PX,
  VIEW_ICON_MARGIN,
  VIEW_MIN_CELL_M,
} from './policy.js';
import { createIconSet } from '../../data/iconSet.js';
import { writeHoldSegment } from '../../data/iconSegment.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
import { iconAtlas } from '../../data/iconAtlas.js';
import { cctvPicks } from './pickState.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { frustumVolumeGeometryData } from '../../data/cctvViewshed.js';
import { entityRecord } from '../../data/entityRecords.js';
import { toColor } from '../../render/cesium/draw.js';
// Loads the factory a viewer of a caller's own gets its camera port from,
// which the rest of the layer reads the eye through.
import '../../render/cesium/camera.js';
import '../../render/cesium/globe.js';

// The policy's renderer colours as the Cesium colours the icons and lines take.
const ACTIVE_CAMERA_COLOR = toColor(ACTIVE_CAMERA_RGBA);
const IDLE_CAMERA_COLOR = toColor(IDLE_CAMERA_RGBA);
const LIVE_CAMERA_COLOR = toColor(LIVE_CAMERA_RGBA);
const ACTIVE_COVERAGE_CENTER = toColor(ACTIVE_COVERAGE_CENTER_RGBA);
const IDLE_COVERAGE_CENTER_MUTED = toColor(IDLE_COVERAGE_CENTER_MUTED_RGBA);
const ACTIVE_COVERAGE_CENTER_DEPTHFAIL = toColor(
  ACTIVE_COVERAGE_CENTER_DEPTHFAIL_RGBA,
);
const ACTIVE_COVERAGE_EDGE = toColor(ACTIVE_COVERAGE_EDGE_RGBA);
const IDLE_COVERAGE_EDGE_MUTED = toColor(IDLE_COVERAGE_EDGE_MUTED_RGBA);
const IDLE_COVERAGE_COLOR = toColor(IDLE_COVERAGE_RGBA);
const ACTIVE_COVERAGE_EDGE_DEPTHFAIL = toColor(
  ACTIVE_COVERAGE_EDGE_DEPTHFAIL_RGBA,
);

/** The camera icon's drawn size (px). */
const CAMERA_ICON_PX = 24;
/**
 * Its atlas raster: 1.25× near scale on a 2× display draws it at 60 device px,
 * so it is rasterised past the drawn size to stay sharp there.
 */
const CAMERA_RASTER_PX = 48;
const CAMERA_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  350,
  1.25,
  4_000_000,
  0.42,
);

/**
 * Builds the translucent frustum-volume primitive for one camera.
 * Synchronous (6 triangles — cheaper than the async geometry pipeline's
 * bookkeeping), unlit flat color, both faces visible (the viewer is routinely
 * inside or behind a cone), never pickable (clicks fall through to the
 * billboard/wireframe/plane, whose pick semantics are established).
 * @param {Object} positions - frustumCartesians shape (see frustumVolumeGeometryData).
 * @param {Cesium.Color} color - Per-camera fill color (already alpha'd).
 * @returns {Cesium.Primitive}
 */
function createFrustumVolumePrimitive(positions, color) {
  const { positions: flat, indices } = frustumVolumeGeometryData(positions);
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: flat,
      }),
    },
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(flat)),
  });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      renderState: {
        cull: { enabled: false },
      },
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

/**
 * A record's viewshed colours as Cesium colours, made once per palette
 * object: a record gets a new palette rather than having one changed in place.
 */
const viewshedCesium = new WeakMap();
function viewshedCesiumColors(record) {
  const colors = record.viewshedColors;
  if (!colors) return null;
  let cesium = viewshedCesium.get(colors);
  if (!cesium) {
    cesium = {
      fill: toColor(colors.fill),
      fillActive: toColor(colors.fillActive),
      line: toColor(colors.line),
      lineActive: toColor(colors.lineActive),
    };
    viewshedCesium.set(colors, cesium);
  }
  return cesium;
}

/** FNV-1a over a camera id: a stable, well-spread order for crowded cells. */
function idHash(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** The scene the icon primitive was added to. */
  let iconScene = null;

  /**
   * The catalog's icon set and the primitive that draws it. Cameras hold still,
   * so each row is a hold segment and the primitive's clock only keeps segment
   * times small. Rows draw depth-test-free (field-test fix 2026-07-06: the old
   * finite depth-test distance re-engaged at far zoom, where the COARSE
   * far-LOD Google-3D mesh sits above the true ground and swallowed
   * ground-anchored icons); the GPU culls the far side of the globe and
   * refreshHorizonCulling thins the rest.
   * @param {Cesium.Viewer} viewer
   */
  function createCameraIcons(viewer) {
    // A re-init against a new viewer replaces the icons; the old ones go.
    destroyCameraIcons();
    const epoch = Cesium.JulianDate.now();
    layerState._icons = createIconSet({ epoch });
    layerState._iconPrimitive = new IconSetPrimitive({
      set: layerState._icons,
      renderTime: () => epoch,
      requestRender: () => layerState._viewer?.scene?.requestRender?.(),
    });
    viewer.scene.primitives.add(layerState._iconPrimitive);
    iconScene = viewer.scene;
    return layerState._iconPrimitive;
  }

  /**
   * Take the icons out of the scene they were added to, whichever viewer the
   * caller tears down, and free them: a destroyed primitive left in a live
   * scene throws on its next frame.
   */
  function destroyCameraIcons() {
    const primitive = layerState._iconPrimitive;
    if (primitive && iconScene && !iconScene.isDestroyed?.())
      iconScene.primitives.remove(primitive);
    if (primitive && !primitive.isDestroyed()) primitive.destroy();
    iconScene = null;
    layerState._iconPrimitive = null;
    layerState._icons = null;
  }

  /** Add a camera record's icon row, idle and shown, at its position. */
  function addCameraIcon(record) {
    const set = layerState._icons;
    const id = record.camera.id;
    const row = set.add(id, { layer: 'cctv', id });
    const slot = iconAtlas.slot(CAMERA_ICON, CAMERA_RASTER_PX);
    set.setImage(row, slot, slot);
    set.setSize(row, CAMERA_ICON_PX, CAMERA_ICON_PX);
    set.setScaleByDistance(row, CAMERA_SCALE_BY_DISTANCE);
    set.setColor(row, cameraColorFor(record));
    set.setShown(row, true);
    moveCameraIcon(record);
  }

  /** Hold a camera's row at its record's current position. */
  function moveCameraIcon(record) {
    const set = layerState._icons;
    const row = set?.row(record.camera.id) ?? -1;
    if (row < 0 || !record.position) return;
    writeHoldSegment(set.segments, row, record.position, 0);
    set.segmentWritten(row);
  }

  /** Icon color: active wins, then live-capable video feeds, then idle stills. */
  function cameraColorFor(record) {
    if (record.camera.id === layerState._activeCameraId)
      return ACTIVE_CAMERA_COLOR;
    if (parts.model.isVideoFeedType(record.camera.feedType))
      return LIVE_CAMERA_COLOR;
    return IDLE_CAMERA_COLOR;
  }

  const {
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
  } = services.focus;

  /**
   * Focus modulation rides the layer's existing animation loop; no additional
   * scene listener is installed. Only camera-icon alpha changes here — coverage
   * geometry and monitor-plane styling retain their established cadence.
   */

  function refreshCctvFocusStyles(nowMs) {
    nowMs = focusNowMs(nowMs);
    const target = getFocusTarget();
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      !focusPassIsNeeded(target, layerState._activeFocusStyleCount)
    )
      return;
    if (nowMs - layerState._lastFocusStyleAt < 80) return;
    layerState._lastFocusStyleAt = nowMs;
    const scene = layerState._viewer.scene;
    const camera = layerState._viewer.camera;
    const result = applyCctvFocusDeemphasis({
      records: layerState._records,
      target,
      previousActiveCount: layerState._activeFocusStyleCount,
      nowMs,
      screenPositionFor: (position) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          position,
          layerState._scratchFocusScreen,
        ),
      cameraDistanceFor: (position) =>
        Cesium.Cartesian3.distance(camera.positionWC, position),
    });
    layerState._activeFocusStyleCount = result.activeCount;
  }

  /**
   * Apply the gated CCTV focus pass through the set's focus column (the shader
   * multiplies it into the base color's alpha).
   * @param {object} input
   * @param {object} [input.icons] The icon set (defaults to the layer's).
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyCctvFocusDeemphasis({
    records,
    icons = layerState._icons,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const record of records || []) {
      const row = icons?.row(record.camera?.id) ?? -1;
      if (row < 0) continue;
      const position = record.position;
      // CCTV never publishes a tracked focus target, so every icon is ambient.
      const focus = advanceSpriteFocus(icons.metaAt(row), {
        // Keep hidden icons in the state/release pass so the active count cannot
        // drop while a stale dim alpha remains waiting to reappear.
        screenPosition:
          !icons.shown(row) || !position ? null : screenPositionFor(position),
        cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: icons.width(row) * icons.scale(row) * 0.5,
        spriteHalfHeightPx: icons.height(row) * icons.scale(row) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      // Order-independent narrow amendment to always-visible icons: CCTV
      // contacts retain a non-zero floor while yielding near the tracked target.
      if (focusAlphaNeedsWrite(icons.focus(row), focus.factor, params)) {
        icons.setFocus(row, focus.factor);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  /**
   * Updates visual styles (colors, widths, visibility) for all camera icons,
   * coverage polylines, viewshed volumes, and projection entities based on which
   * camera is active, whether the layer is enabled, and the current
   * coverage-mode/projection toggle states.
   */
  /**
   * Field-test fix (2026-07-06): horizon-culls camera icons on the CPU as the
   * icon shader does on the GPU. With the Cesium globe hidden (Google-3D
   * regime) nothing writes far-side depth and the icons are always-on-top, so
   * the shown set (cards, geometry, the picker) must not include London's
   * cluster from a US viewpoint.
   *
   * The same pass thins the view so a large catalog stays readable and cheap:
   * icons well off screen hide, and each camera competes for a world-anchored
   * cell sized to VIEW_CELL_PX at its distance (healthiest first, then a stable
   * id order). The active camera shows whenever it is above the horizon
   * and near the screen, even in a crowded cell. The shown records become
   * `_viewRecords`, the working set for geometry, cards and the camera picker;
   * the array keeps its identity while the shown set is unchanged.
   *
   * Runs on camera settle, throttled during motion, on resize, enable and
   * activation changes — never per frame.
   * @returns {boolean} Whether the shown set changed.
   */

  function refreshHorizonCulling() {
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      layerState._viewer.isDestroyed() ||
      !layerState._records.length
    )
      return false;
    const { camera, scene } = layerState._viewer;
    const width = scene.canvas.clientWidth || scene.canvas.width || 0;
    const height = scene.canvas.clientHeight || scene.canvas.height || 0;
    const minX = -width * VIEW_ICON_MARGIN;
    const maxX = width * (1 + VIEW_ICON_MARGIN);
    const minY = -height * VIEW_ICON_MARGIN;
    const maxY = height * (1 + VIEW_ICON_MARGIN);
    // Ground metres one pixel covers per metre of distance from the viewer.
    const fovy = Number.isFinite(camera.frustum?.fovy)
      ? camera.frustum.fovy
      : Math.PI / 3;
    const metresPerPixelPerMetre =
      (2 * Math.tan(fovy / 2)) / Math.max(1, height);
    const viewer = camera.positionWC;
    // The horizon test of Cesium's EllipsoidalOccluder, inlined: this loop
    // visits every camera in the catalog.
    const inverseRadii = Cesium.Ellipsoid.WGS84.oneOverRadii;
    const cx = viewer.x * inverseRadii.x;
    const cy = viewer.y * inverseRadii.y;
    const cz = viewer.z * inverseRadii.z;
    const limbSquared = cx * cx + cy * cy + cz * cz - 1;
    const activeId = layerState._activeCameraId;
    const project = screenProjector(scene, camera, width, height);
    const pass = (layerState._viewPassId = (layerState._viewPassId || 0) + 1);
    const shown = [];
    const cells = new Map();
    for (const record of layerState._records) {
      const position = record.position;
      if (!position) continue;
      const vx = position.x * inverseRadii.x - cx;
      const vy = position.y * inverseRadii.y - cy;
      const vz = position.z * inverseRadii.z - cz;
      const vtDotVc = -(vx * cx + vy * cy + vz * cz);
      if (
        limbSquared < 0
          ? vtDotVc > 0
          : vtDotVc > limbSquared &&
            (vtDotVc * vtDotVc) / (vx * vx + vy * vy + vz * vz) > limbSquared
      )
        continue;
      const screen = project(position);
      if (
        !screen ||
        !(screen.x >= minX && screen.x <= maxX) ||
        !(screen.y >= minY && screen.y <= maxY)
      )
        continue;
      const dx = position.x - viewer.x;
      const dy = position.y - viewer.y;
      const dz = position.z - viewer.z;
      const cellM =
        VIEW_CELL_PX *
        metresPerPixelPerMetre *
        Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (record.camera.id === activeId || !(cellM >= VIEW_MIN_CELL_M)) {
        record.viewPass = pass;
        shown.push(record);
        continue;
      }
      const key = worldCellKey(record, cellM);
      const rank = viewRank(record);
      const holder = cells.get(key);
      if (!holder || rank < holder.rank) cells.set(key, { record, rank });
    }
    for (const { record } of cells.values()) {
      record.viewPass = pass;
      shown.push(record);
    }
    const icons = layerState._icons;
    for (const record of layerState._records) {
      const row = icons?.row(record.camera.id) ?? -1;
      if (row >= 0) icons.setShown(row, record.viewPass === pass);
    }
    const previous = layerState._viewRecords;
    const changed =
      previous.length !== shown.length ||
      previous.some((record) => record.viewPass !== pass);
    if (changed) layerState._viewRecords = shown;
    return changed;
  }

  /**
   * Canvas coordinates for world positions. In 3D the pass multiplies by one
   * view-projection matrix per call instead of Cesium's per-point
   * cartesianToCanvasCoordinates, which dominated the pass on a large
   * catalog; other scene modes keep Cesium's projection.
   * @returns {(position: Cesium.Cartesian3) => ({x: number, y: number}|null)}
   */
  function screenProjector(scene, camera, width, height) {
    const out = layerState._scratchViewScreen;
    const projection = camera.frustum?.projectionMatrix;
    if (
      scene.mode !== Cesium.SceneMode.SCENE3D ||
      !projection ||
      !camera.viewMatrix
    )
      return (position) => scene.cartesianToCanvasCoordinates(position, out);
    const m = Cesium.Matrix4.multiply(
      projection,
      camera.viewMatrix,
      layerState._scratchViewProjection,
    );
    return (p) => {
      const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
      // Behind the eye or before the near plane: Cesium does not draw it.
      if (!(w > 0) || z < 0) return null;
      out.x =
        ((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w + 1) * 0.5 * width;
      out.y =
        (1 - (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w) * 0.5 * height;
      return out;
    };
  }

  /**
   * A grid cell fixed to the ground: `cellM` rounded up to a power of two
   * metres, so the cell (and its winner) only changes when the camera's
   * distance crosses a doubling: a level pan keeps it, a tilted pan or a zoom
   * can move cameras near the edge of a step to the next one.
   */
  function worldCellKey(record, cellM) {
    const level = Math.ceil(Math.log2(cellM));
    const { lat, lon } = record.camera;
    // A camera's key changes only with the level (or an edited position), so
    // it is kept per level.
    if (
      record.viewCellLevel === level &&
      record.viewCellLat === lat &&
      record.viewCellLon === lon
    )
      return record.viewCellKey;
    const latStep = 2 ** level / 111_320;
    const row = Math.floor(lat / latStep);
    const rowLat = Cesium.Math.toRadians((row + 0.5) * latStep);
    const lonStep = latStep / Math.max(0.05, Math.cos(rowLat));
    record.viewCellLevel = level;
    record.viewCellLat = lat;
    record.viewCellLon = lon;
    record.viewCellKey = `${level}:${row}:${Math.floor(lon / lonStep)}`;
    return record.viewCellKey;
  }

  /** Lower ranks win a crowded cell: healthy feeds first, then a stable id order. */
  function viewRank(record) {
    const status = layerState._healthById.get(record.camera.id)?.status;
    const tier =
      status === 'ok'
        ? 0
        : status === 'degraded'
          ? 1
          : status === 'offline'
            ? 3
            : 2;
    record.viewHash ??= idHash(record.camera.id);
    return tier * 2 ** 32 + record.viewHash;
  }

  /**
   * Hides every per-record CCTV visual without recomputing coverage membership or
   * styles. Disabling makes every visibility branch false, so a direct sweep is
   * sufficient; live viewshed primitives still require explicit destruction.
   *
   * @param {Object[]} records CCTV runtime records.
   * @param {(record: Object) => void} destroyVolume Viewshed teardown callback.
   * @param {string|null} [activeCameraId=null] Active camera whose activation probe must be re-armed.
   */

  function hideCctvRecordVisuals(
    records,
    destroyVolume,
    activeCameraId = null,
  ) {
    for (const record of Array.isArray(records) ? records : []) {
      if (record) {
        record.probeClampRangeM = null;
        if (record.camera?.id === activeCameraId) record.activationDone = false;
      }
      for (const entity of record?.coverageEntities || []) entity.show = false;
      if (record?.viewshedPrimitive) destroyVolume?.(record);
      if (record?.projection?.planeEntity)
        record.projection.planeEntity.show = false;
    }
  }

  function hideCctvVisuals() {
    hideCctvRecordVisuals(
      layerState._records,
      destroyViewshedVolume,
      layerState._activeCameraId,
    );
    parts.projection.clearProjectionOverlay();
    if (layerState._icons) layerState._icons.show = false;
    parts.projection.pauseInactiveProjectionFeeds(null);
  }

  /** Applies coverage visibility/style state and lazily builds eligible sets. */

  function refreshCoverageStyles() {
    const activeRecord = parts.selection.getActiveRecord();
    parts.geometry.ensureActiveCoverageEntities(activeRecord);
    const activeId = activeRecord?.camera.id || null;
    const coverageVisible =
      parts.geometry.buildCoverageVisibleSet(activeRecord);
    // Drawn coverage needs geometry too (geometryQueue's working set).
    layerState._coverageVisibleIds = coverageVisible;
    const coverageOn = layerState._coverageMode !== 'off';
    const viewshedOn = layerState._coverageMode === 'viewshed';
    if (coverageOn) {
      parts.geometry.ensureVisibleCoverageEntities(
        layerState._records,
        coverageVisible,
      );
    }
    const icons = layerState._icons;
    for (const record of layerState._records) {
      const isActive = record.camera.id === activeId;
      const row = icons?.row(record.camera.id) ?? -1;
      if (row >= 0) {
        // The set skips unchanged writes, so across a large catalog only the
        // changed rows upload.
        icons.setColor(row, cameraColorFor(record));
        icons.setScale(row, isActive ? 1.25 : 1.0);
      }

      if (
        layerState._enabled &&
        isActive &&
        (layerState._showProjection ||
          parts.model.isVideoFeedType(record.camera.feedType))
      ) {
        parts.projection.ensureProjectionRuntime(record);
      }
      // One live plane in the world at a time (§2c): only the active camera's
      // far cap carries the monitor plane; idle neighbors get the faint
      // wireframe only.
      const planeShowing = !!(
        layerState._enabled &&
        layerState._showProjection &&
        isActive
      );

      const inVisibleSet = coverageVisible.has(record.camera.id);
      // A synthetic bearing (headingConfidence 'low', no human calibration)
      // draws its wireframe dashed so a guessed facing is visibly provisional
      // rather than rendering identically to a surveyed one (#639). Colors,
      // widths, and the active/idle emphasis are unchanged.
      const bearingEstimated = isHeadingEstimated(record.camera);
      const lineMaterial = (color) =>
        bearingEstimated
          ? new Cesium.PolylineDashMaterialProperty({ color })
          : color;
      for (const entity of record.coverageEntities || []) {
        // The frustum wireframe is part of the projection representation —
        // force it on for the active camera and let it read through geometry
        // via depthFailMaterial (polylines have no disableDepthTestDistance).
        entity.show = !!(
          layerState._enabled &&
          ((coverageOn && inVisibleSet) || planeShowing)
        );
        if (!entity.polyline) continue;
        // Viewshed mode swaps the cyan/green scheme for the camera's own hue so
        // adjacent cones read as distinct coverage claims (design §3b); the
        // active camera keeps its width/alpha emphasis in both schemes.
        const hue = viewshedOn ? viewshedCesiumColors(record) : null;
        if (entity._coverageRole === 'cap') {
          entity.polyline.material = lineMaterial(
            hue
              ? isActive
                ? hue.lineActive
                : hue.line
              : isActive
                ? ACTIVE_COVERAGE_CENTER
                : IDLE_COVERAGE_CENTER_MUTED,
          );
          entity.polyline.width = isActive ? 2.2 : 1.0;
          entity.polyline.depthFailMaterial = planeShowing
            ? hue
              ? hue.line.withAlpha(0.26)
              : ACTIVE_COVERAGE_CENTER_DEPTHFAIL
            : undefined;
        } else {
          entity.polyline.material = lineMaterial(
            hue
              ? isActive
                ? hue.lineActive
                : hue.line.withAlpha(0.6)
              : isActive
                ? ACTIVE_COVERAGE_EDGE
                : IDLE_COVERAGE_EDGE_MUTED,
          );
          entity.polyline.width = isActive ? 1.8 : 0.9;
          entity.polyline.depthFailMaterial = planeShowing
            ? hue
              ? hue.line.withAlpha(0.18)
              : ACTIVE_COVERAGE_EDGE_DEPTHFAIL
            : undefined;
        }
      }

      // Viewshed volume lifecycle: exists iff enabled + viewshed mode + in the
      // visible set. Rebuild on active-tint flips (rare); otherwise leave the
      // primitive alone so idle refreshes never churn geometry.
      const wantVolume = !!(
        layerState._enabled &&
        viewshedOn &&
        inVisibleSet &&
        record.frustumPositions
      );
      if (wantVolume) {
        if (
          !record.viewshedPrimitive ||
          record.viewshedActiveTint !== isActive
        ) {
          rebuildViewshedVolume(record, isActive);
        }
      } else if (record.viewshedPrimitive) {
        destroyViewshedVolume(record);
      }

      if (record.projection) {
        parts.projection.setPlaneVisible(record.projection, planeShowing);
      }
    }

    if (layerState._icons) layerState._icons.show = !!layerState._enabled;
    parts.projection.pauseInactiveProjectionFeeds(activeId);
  }

  /**
   * Reports whether the active Google Photorealistic 3D Tileset (if any) has
   * finished loading the tiles in view. Shared mesh-floor sampling is gated on
   * this so a one-shot cell never bakes in a miss from still-streaming tiles.
   * Discovers + caches the tileset lazily from scene
   * primitives (the CCTV module holds only a `_viewer` reference). When no
   * tileset is present (OSM fallback) this returns true so ground sampling is
   * not permanently blocked.
   *
   * Task 5 (review correction, spec §2): a HIDDEN tileset (`show === false`,
   * i.e. a globe stack is active) must NOT report ready — Cesium 1.138's
   * the shared sampler can only inspect *visible* 3D tilesets, so a sample taken
   * against the hidden Google tileset would silently miss.
   *
   * @returns {boolean} True when tiles are loaded AND visible (or no tileset
   *   exists to wait on).
   */

  function projectionTilesReady() {
    if (
      !layerState._activeTileset ||
      layerState._activeTileset.isDestroyed?.()
    ) {
      layerState._activeTileset = null;
      const primitives = layerState._viewer?.scene?.primitives;
      if (primitives && typeof primitives.get === 'function') {
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives.get(i);
          if (p instanceof Cesium.Cesium3DTileset && !p.isDestroyed?.()) {
            layerState._activeTileset = p;
            break;
          }
        }
      }
    }
    if (!layerState._activeTileset) return true;
    if (layerState._activeTileset.show === false) return false;
    return layerState._activeTileset.tilesLoaded === true;
  }

  /**
   * Converts a computeFrustumGeometry result into the Cartesian3 positions the
   * entities consume. Fresh objects per call (geometry updates are rare —
   * slider/save/activation — and entities must never share scratch objects).
   * @param {Object} geometry - Result of computeFrustumGeometry.
   * @returns {{ mount: Cesium.Cartesian3, capCenter: Cesium.Cartesian3,
   *   tl: Cesium.Cartesian3, tr: Cesium.Cartesian3, br: Cesium.Cartesian3,
   *   bl: Cesium.Cartesian3, label: Cesium.Cartesian3 }}
   */

  function frustumCartesians(geometry) {
    const at = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
    return {
      mount: at(geometry.mount),
      capCenter: at(geometry.capCenter),
      tl: at(geometry.corners.tl),
      tr: at(geometry.corners.tr),
      br: at(geometry.corners.br),
      bl: at(geometry.corners.bl),
      label: Cesium.Cartesian3.fromDegrees(
        geometry.topCenter.lon,
        geometry.topCenter.lat,
        geometry.topCenter.alt + 1.2,
      ),
    };
  }

  /**
   * Creates the five Cesium polyline entities that visualize a camera's pitched
   * frustum: 4 corner rays (mount → far-plane corner) + the closed far-plane
   * rectangle. Entity ids stay in the `cctv-<id>-<role>` scheme (pick-owner
   * regex depends on it): roles ray-tl / ray-tr / ray-br / ray-bl / cap.
   * @param {Object} record - Camera record.
   * @returns {Cesium.Entity[]} Array of five coverage entities.
   */

  function buildCoverageEntities(record) {
    const { camera } = record;
    // Prefer the record's already-refined geometry. Lazy creation commonly
    // happens after the staggered ground pass; recomputing from the catalog
    // prior here would regress the camera to its pre-sampled datum.
    let geometry = record.frustumGeometry;
    let positions = record.frustumPositions;
    if (!geometry || !positions) {
      geometry = parts.geometry.computeFrustumGeometry(
        camera,
        parts.ground.groundPriorAltFor(record),
        record.probeClampRangeM,
      );
      positions = frustumCartesians(geometry);
      record.frustumGeometry = geometry;
      record.frustumPositions = positions;
      record.position = positions.mount;
      moveCameraIcon(record);
    }

    const addPolyline = (role, linePositions) => {
      const entity = layerState._viewer.entities.add({
        id: `cctv-${camera.id}-${role}`,
        polyline: {
          positions: linePositions,
          width: 1.2,
          material: IDLE_COVERAGE_COLOR,
        },
      });
      cctvPicks.write(entity).cameraId = camera.id;
      return entity;
    };

    const entities = [
      addPolyline('ray-tl', [positions.mount, positions.tl]),
      addPolyline('ray-tr', [positions.mount, positions.tr]),
      addPolyline('ray-br', [positions.mount, positions.br]),
      addPolyline('ray-bl', [positions.mount, positions.bl]),
      addPolyline('cap', [
        positions.tl,
        positions.tr,
        positions.br,
        positions.bl,
        positions.tl,
      ]),
    ];

    entities[0]._coverageRole = 'edge';
    entities[1]._coverageRole = 'edge';
    entities[2]._coverageRole = 'edge';
    entities[3]._coverageRole = 'edge';
    entities[4]._coverageRole = 'cap';
    return entities;
  }

  /**
   * The activation obstruction probe's one ray pick against the scene: the
   * first thing along the ray from `origin`, seeing through `exclude` (the
   * layer's own entities).
   * @param {{x: number, y: number, z: number}} origin - ECEF ray origin.
   * @param {{x: number, y: number, z: number}} direction - Unit ECEF direction.
   * @returns {{position?: object}|undefined} Undefined as well when the
   *   scene cannot pick along a ray.
   */

  function obstructionHit(origin, direction) {
    const scene = layerState._viewer?.scene;
    if (!scene || typeof scene.pickFromRay !== 'function') return undefined;
    // Exclude everything the layer itself draws so the probe can only hit the
    // world (3D tiles), not our own polylines/planes. Icons never draw into
    // ray picks.
    const exclude = [...layerState._coverageEntities];
    for (const runtime of layerState._projectionEntities) {
      if (runtime?.planeEntity) exclude.push(runtime.planeEntity);
    }
    return scene.pickFromRay(new Cesium.Ray(origin, direction), exclude);
  }

  /** Whether the scene can pick along a ray (the activation probe needs it). */
  function canPickFromRay() {
    return typeof layerState._viewer?.scene?.pickFromRay === 'function';
  }

  /** Removes the layer's coverage entities from the scene. */
  function removeCoverageEntities() {
    const viewer = layerState._viewer;
    if (!viewer) return;
    for (const entity of layerState._coverageEntities) {
      viewer.entities.remove(entity);
    }
  }

  /**
   * Extracts a camera ID from a scene pick result by checking icon row IDs,
   * primitive IDs, and the camera ids the layer keeps for its coverage entities.
   * @param {Object|null} picked - Result from scene.pick().
   * @returns {string|null} Camera ID, or null if the pick is not a CCTV entity.
   */

  function extractPickedCameraId(picked) {
    if (!picked) return null;

    const entity = cctvPicks.read(picked.id)
      ? picked.id
      : cctvPicks.read(picked.primitive?.id)
        ? picked.primitive.id
        : null;
    const value = cctvPicks.read(entity)?.cameraId;
    if (value !== undefined) {
      const record =
        typeof value === 'string' ? layerState._recordById.get(value) : null;
      const ownsCoverageEntity = Boolean(
        record?.coverageEntities?.includes(entity),
      );
      const ownsProjectionEntity =
        record?.projection?.planeEntity === entity ||
        layerState._projectionEntities.some(
          (runtime) =>
            runtime?.cameraId === value && runtime.planeEntity === entity,
        );
      if (record && (ownsCoverageEntity || ownsProjectionEntity)) return value;
    }

    // Camera icon row IDs are intentionally the upstream camera ID, so a
    // sibling may legitimately use the same string. A bare ID match is not
    // ownership proof: require that this layer's icon set drew the pick.
    const directId =
      typeof picked.id === 'string'
        ? picked.id
        : typeof picked.primitive?.id === 'string'
          ? picked.primitive.id
          : null;
    const record =
      directId === null ? null : layerState._recordById.get(directId);
    if (!record) return null;
    return layerState._icons && picked.iconSet === layerState._icons
      ? directId
      : null;
  }

  /**
   * The camera whose icon or coverage is under a screen position (CSS px),
   * from one scene pick; null when none is, or the pick throws.
   * @param {{x: number, y: number}} position
   * @returns {string|null}
   */
  function pickCameraIdAt(position) {
    let picked = null;
    try {
      picked = layerState._viewer.scene.pick(position);
    } catch {
      picked = null;
    }
    return extractPickedCameraId(picked);
  }

  /**
   * Where the ambient cards can go this pass: the canvas size, and the
   * canvas position of a world point on the near side of the horizon (null
   * behind it or off the projection).
   * @returns {{width: number, height: number,
   *   screenOf: (position: object) => ({x: number, y: number}|undefined|null)}}
   */
  function cardView() {
    const { camera, scene } = layerState._viewer;
    const occluder = horizonOccluder(camera);
    return {
      width: scene.canvas.clientWidth || scene.canvas.width || 0,
      height: scene.canvas.clientHeight || scene.canvas.height || 0,
      screenOf: (position) =>
        occluder.isPointVisible(position)
          ? scene.cartesianToCanvasCoordinates(position)
          : null,
    };
  }

  /**
   * Removes (and destroys) a record's viewshed volume primitive, if any.
   * @param {Object} record - Camera record.
   */

  function destroyViewshedVolume(record) {
    if (!record) return;
    if (record.viewshedPrimitive && layerState._viewer) {
      layerState._viewer.scene.primitives.remove(record.viewshedPrimitive);
    }
    record.viewshedPrimitive = null;
  }

  /**
   * (Re)builds a record's translucent viewshed volume from its CURRENT
   * frustumPositions — the same 5 Cartesians the wireframe draws, so the volume
   * is welded to the cone by construction. Called only where the wireframe
   * already rewrites (style refresh on mode/visible-set/active changes,
   * applyFrustumGeometry on pose edits) — no new update cadence, zero scene
   * queries (viewshed design §3b).
   * @param {Object} record - Camera record.
   * @param {boolean} isActive - Active camera gets the brighter fill.
   */

  function rebuildViewshedVolume(record, isActive) {
    destroyViewshedVolume(record);
    if (
      !layerState._viewer ||
      !record?.frustumPositions ||
      !record.viewshedColors
    )
      return;
    const colors = viewshedCesiumColors(record);
    const color = isActive ? colors.fillActive : colors.fill;
    const primitive = createFrustumVolumePrimitive(
      record.frustumPositions,
      color,
    );
    // QA tag: the harness counts viewshed volumes by this record field.
    entityRecord(primitive).viewshedCameraId = record.camera.id;
    record.viewshedPrimitive =
      layerState._viewer.scene.primitives.add(primitive);
    record.viewshedActiveTint = !!isActive;
  }

  return {
    projectionTilesReady,
    frustumCartesians,
    buildCoverageEntities,
    obstructionHit,
    canPickFromRay,
    removeCoverageEntities,
    extractPickedCameraId,
    pickCameraIdAt,
    cardView,
    destroyViewshedVolume,
    rebuildViewshedVolume,
    createCameraIcons,
    destroyCameraIcons,
    addCameraIcon,
    moveCameraIcon,
    refreshCctvFocusStyles,
    applyCctvFocusDeemphasis,
    refreshHorizonCulling,
    hideCctvRecordVisuals,
    hideCctvVisuals,
    refreshCoverageStyles,
  };
}
