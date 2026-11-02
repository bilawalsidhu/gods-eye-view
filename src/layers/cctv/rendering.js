import * as Cesium from 'cesium';
import { isHeadingEstimated } from './headingConfidence.js';
import {
  ACTIVE_CAMERA_COLOR,
  IDLE_CAMERA_COLOR,
  LIVE_CAMERA_COLOR,
  ACTIVE_COVERAGE_CENTER,
  IDLE_COVERAGE_CENTER_MUTED,
  ACTIVE_COVERAGE_CENTER_DEPTHFAIL,
  ACTIVE_COVERAGE_EDGE,
  IDLE_COVERAGE_EDGE_MUTED,
  ACTIVE_COVERAGE_EDGE_DEPTHFAIL,
  VIEW_CELL_PX,
  VIEW_ICON_MARGIN,
  VIEW_MIN_CELL_M,
} from './policy.js';

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
      baseColorFor: cameraColorFor,
    });
    layerState._activeFocusStyleCount = result.activeCount;
  }

  /**
   * Apply the gated CCTV focus pass through the production color path.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyCctvFocusDeemphasis({
    records,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    baseColorFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const record of records || []) {
      const bb = record.billboard;
      if (!bb) continue;
      const position = bb.position;
      // CCTV never publishes a tracked focus target, so every icon is ambient.
      const focus = advanceSpriteFocus(bb, {
        // Keep hidden icons in the state/release pass so the active count cannot
        // drop while a stale dim alpha remains waiting to reappear.
        screenPosition:
          bb.show === false || !position ? null : screenPositionFor(position),
        cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: (bb.width || 24) * (bb.scale || 1) * 0.5,
        spriteHalfHeightPx: (bb.height || 24) * (bb.scale || 1) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      const base = baseColorFor(record);
      const alpha = base.alpha * focus.factor;
      if (focusAlphaNeedsWrite(bb.color?.alpha, alpha, params)) {
        // Order-independent narrow amendment to always-visible icons: CCTV
        // contacts retain a non-zero floor while yielding near the tracked target.
        bb.color = base.withAlpha(alpha);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  /**
   * Updates visual styles (colors, widths, visibility) for all camera billboards,
   * coverage polylines, viewshed volumes, and projection entities based on which
   * camera is active, whether the layer is enabled, and the current
   * coverage-mode/projection toggle states.
   */
  /**
   * Field-test fix (2026-07-06): horizon-culls camera billboards, mirroring the
   * flights layer's EllipsoidalOccluder pass. With the Cesium globe hidden
   * (Google-3D regime) nothing writes far-side depth, and the billboards are now
   * always-on-top (`disableDepthTestDistance: INFINITY` — the far-zoom submerge
   * fix), so without this pass London's cluster would shine through the planet
   * from a US viewpoint.
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
      const position = record.billboard?.position;
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
    for (const record of layerState._records) {
      const bb = record.billboard;
      if (!bb) continue;
      const visible = record.viewPass === pass;
      if (bb.show !== visible) bb.show = visible;
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
      parts.geometry.destroyViewshedVolume,
      layerState._activeCameraId,
    );
    parts.projection.clearProjectionOverlay();
    if (layerState._billboards) layerState._billboards.show = false;
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
    for (const record of layerState._records) {
      const isActive = record.camera.id === activeId;
      if (record.billboard) {
        // Unchanged writes still dirty the collection, which then rewrites
        // every icon's vertices: across a large catalog, write only changes.
        const color = cameraColorFor(record);
        if (!Cesium.Color.equals(record.billboard.color, color))
          record.billboard.color = color;
        const scale = isActive ? 1.25 : 1.0;
        if (record.billboard.scale !== scale) record.billboard.scale = scale;
        // disableDepthTestDistance stays POSITIVE_INFINITY for every billboard
        // (set at creation) — see the field-test far-zoom submerge fix there.
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
        const hue = viewshedOn ? record.viewshedColors : null;
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
          parts.geometry.rebuildViewshedVolume(record, isActive);
        }
      } else if (record.viewshedPrimitive) {
        parts.geometry.destroyViewshedVolume(record);
      }

      if (record.projection) {
        parts.projection.setPlaneVisible(record.projection, planeShowing);
      }
    }

    if (layerState._billboards)
      layerState._billboards.show = !!layerState._enabled;
    parts.projection.pauseInactiveProjectionFeeds(activeId);
  }
  return {
    refreshCctvFocusStyles,
    applyCctvFocusDeemphasis,
    refreshHorizonCulling,
    hideCctvRecordVisuals,
    hideCctvVisuals,
    refreshCoverageStyles,
  };
}
