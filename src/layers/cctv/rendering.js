import * as geo from '../../geo/index.js';
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
    if (parts.model.isVideoFeedCamera(record.camera)) return LIVE_CAMERA_COLOR;
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
      !parts.renderer?.ready ||
      !focusPassIsNeeded(target, layerState._activeFocusStyleCount)
    )
      return;
    if (nowMs - layerState._lastFocusStyleAt < 80) return;
    layerState._lastFocusStyleAt = nowMs;
    const result = applyCctvFocusDeemphasis({
      records: layerState._records,
      target,
      previousActiveCount: layerState._activeFocusStyleCount,
      nowMs,
      // prettier-ignore
      screenPositionFor: (position) =>
        parts.renderer.project(
          position,
          layerState._scratchFocusScreen,
        ),
      // prettier-ignore
      cameraDistanceFor: (position) =>
        parts.renderer.distance(position),
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
      !parts.renderer?.ready ||
      !layerState._records.length
    )
      return false;
    const { width, height } = parts.renderer.viewport();
    const minX = -width * VIEW_ICON_MARGIN;
    const maxX = width * (1 + VIEW_ICON_MARGIN);
    const minY = -height * VIEW_ICON_MARGIN;
    const maxY = height * (1 + VIEW_ICON_MARGIN);
    // Ground metres one pixel covers per metre of distance from the viewer.
    const fovy = parts.renderer.cameraPose()?.fovy || Math.PI / 3;
    const metresPerPixelPerMetre =
      (2 * Math.tan(fovy / 2)) / Math.max(1, height);
    const activeId = layerState._activeCameraId;
    const horizonVisible = parts.renderer.horizonTest();
    const pass = (layerState._viewPassId = (layerState._viewPassId || 0) + 1);
    const shown = [];
    const cells = new Map();
    for (const record of layerState._records) {
      const position = record.billboard?.position;
      if (!position) continue;
      if (!horizonVisible(position)) continue;
      const screen = parts.renderer.project(
        position,
        layerState._scratchViewScreen,
      );
      if (
        !screen ||
        !(screen.x >= minX && screen.x <= maxX) ||
        !(screen.y >= minY && screen.y <= maxY)
      )
        continue;
      const cellM =
        VIEW_CELL_PX *
        metresPerPixelPerMetre *
        parts.renderer.distance(position);
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
    const rowLat = geo.math.toRadians((row + 0.5) * latStep);
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
      if (record?.projection?.planeEntity) {
        record.projection.planeEntity.show = false;
        record.projection.planeVisible = false;
      }
    }
  }

  function hideCctvVisuals() {
    hideCctvRecordVisuals(
      layerState._records,
      parts.geometry.destroyViewshedVolume,
      layerState._activeCameraId,
    );
    parts.projection.clearProjectionOverlay();
    parts.renderer?.setMarkersVisible(false);
    parts.projection.pauseInactiveProjectionFeeds(null);
  }

  /** Applies coverage visibility/style state and lazily builds eligible sets. */

  function refreshCoverageStyles() {
    if (!parts.renderer?.ready) return;
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
        if (!color.equals(record.billboard.color))
          record.billboard.color = color;
        const scale = isActive ? 1.25 : 1.0;
        if (record.billboard.scale !== scale) record.billboard.scale = scale;
        // Every marker draws over the scene (the marker set's depth test is
        // 'always') — see the field-test far-zoom submerge fix there.
      }

      if (
        layerState._enabled &&
        isActive &&
        !parts.model.isBrowserOverlayCamera(record.camera) &&
        (layerState._showProjection ||
          parts.model.isVideoFeedCamera(record.camera))
      ) {
        parts.projection.ensureProjectionRuntime(record);
      }
      // One live plane in the world at a time (§2c): only the active camera's
      // far cap carries the monitor plane; idle neighbors get the faint
      // wireframe only.
      const planeShowing = !!(
        layerState._enabled &&
        layerState._showProjection &&
        isActive &&
        !parts.model.isBrowserOverlayCamera(record.camera)
      );

      const inVisibleSet = coverageVisible.has(record.camera.id);
      // A synthetic bearing (headingConfidence 'low', no human calibration)
      // draws its wireframe dashed so a guessed facing is visibly provisional
      // rather than rendering identically to a surveyed one (#639). Colors,
      // widths, and the active/idle emphasis are unchanged.
      const bearingEstimated = isHeadingEstimated(record.camera);
      for (const entity of record.coverageEntities || []) {
        const visible = !!(
          layerState._enabled &&
          ((coverageOn && inVisibleSet) || planeShowing)
        );
        const hue = viewshedOn ? record.viewshedColors : null;
        const cap = entity._coverageRole === 'cap';
        const tint = hue
          ? isActive
            ? hue.lineActive
            : cap
              ? hue.line
              : hue.line.withAlpha(0.6)
          : cap
            ? isActive
              ? ACTIVE_COVERAGE_CENTER
              : IDLE_COVERAGE_CENTER_MUTED
            : isActive
              ? ACTIVE_COVERAGE_EDGE
              : IDLE_COVERAGE_EDGE_MUTED;
        const depthFail = !planeShowing
          ? undefined
          : hue
            ? hue.line.withAlpha(cap ? 0.26 : 0.18)
            : cap
              ? ACTIVE_COVERAGE_CENTER_DEPTHFAIL
              : ACTIVE_COVERAGE_EDGE_DEPTHFAIL;
        parts.renderer.styleLine(entity, {
          visible,
          width: cap ? (isActive ? 2.2 : 1.0) : isActive ? 1.8 : 0.9,
          tint,
          dashed: bearingEstimated,
          depthFail,
        });
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

    parts.renderer?.setMarkersVisible(!!layerState._enabled);
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
