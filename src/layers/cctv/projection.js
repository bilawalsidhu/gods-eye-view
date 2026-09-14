import * as Cesium from 'cesium';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  PLANE_OUTLINE_COLOR,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
} from './policy.js';

export function createProjection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /**
   * Build the protected label associated with one active monitor plane.
   * @param {{cameraId: string, name: string, position: Cesium.Cartesian3|Function}} input
   * @returns {Object} Shared-host presentation entry.
   */

  function createCctvProjectionOverlayEntry({ cameraId, name, position }) {
    return {
      id: String(cameraId),
      position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER - 1,
      title: String(name || cameraId || 'CAMERA'),
      details: [],
      accent: '#6be8ff',
      interactive: false,
      gapPx: 6,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /**
   * Re-derives the monitor plane entity's placement (position, orientation,
   * dimensions) + label from the record's current frustum geometry, so the plane
   * always caps the wireframe exactly (corner rays terminate on its corners).
   * No-op when the record has no plane runtime (idle neighbors have no plane).
   * @param {Object} record - Camera record.
   */

  function updatePlanePlacement(record) {
    const runtime = record?.projection;
    if (!runtime?.planeEntity) return;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    runtime.planeEntity.position = positions.capCenter;
    runtime.planeEntity.orientation = parts.model.planeOrientationFor(
      record.camera,
      positions.capCenter,
    );
    if (runtime.planeEntity.plane) {
      runtime.planeEntity.plane.dimensions = new Cesium.Cartesian2(
        geometry.halfW * 2,
        geometry.halfH * 2,
      );
    }
    if (runtime.labelPosition) {
      Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
    }
  }

  /**
   * Clear the active monitor-plane label source and ownership marker.
   */

  function clearProjectionOverlay() {
    layerState._cctvOverlayHost.clearSource(CCTV_PROJECTION_OVERLAY_SOURCE_ID);
    layerState._cctvOverlayHost.setVisible(
      CCTV_PROJECTION_OVERLAY_SOURCE_ID,
      false,
    );
    layerState._projectionOverlayOwnerId = null;
  }

  /**
   * Shows/hides the monitor plane and its associated shared-host label.
   * @param {Object} runtime - Projection runtime.
   * @param {boolean} visible
   */

  function setPlaneVisible(runtime, visible) {
    if (!runtime) return;
    if (runtime.planeEntity) runtime.planeEntity.show = !!visible;
    if (visible && runtime.overlayEntry && runtime.cameraId) {
      if (layerState._projectionOverlayOwnerId !== runtime.cameraId) {
        layerState._cctvOverlayHost.setEntries(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          [runtime.overlayEntry],
          CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
        );
        layerState._cctvOverlayHost.setVisible(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          true,
        );
        layerState._projectionOverlayOwnerId = runtime.cameraId;
      }
    } else if (layerState._projectionOverlayOwnerId === runtime.cameraId) {
      clearProjectionOverlay();
    }
  }

  /** Create the native monitor plane plus its cached host-label presentation. */

  function createProjectionPlane(record, runtime, geometry, positions) {
    runtime.labelPosition ||= new Cesium.Cartesian3();
    Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
    runtime.cameraId = String(record.camera.id);
    runtime.overlayEntry = createCctvProjectionOverlayEntry({
      cameraId: runtime.cameraId,
      name: record.camera.name,
      position: () => runtime.labelPosition,
    });
    runtime.planeEntity = layerState._viewer.entities.add({
      id: `cctv-${record.camera.id}-plane`,
      properties: { cctvCameraId: record.camera.id },
      show: false,
      position: positions.capCenter,
      orientation: parts.model.planeOrientationFor(
        record.camera,
        positions.capCenter,
      ),
      plane: {
        plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0.0),
        dimensions: new Cesium.Cartesian2(
          geometry.halfW * 2,
          geometry.halfH * 2,
        ),
        material: runtime.planeMaterial,
        outline: true,
        outlineColor: PLANE_OUTLINE_COLOR,
      },
    });
    return runtime.planeEntity;
  }

  /**
   * Creates the projection runtime for a camera record: an offscreen canvas,
   * the monitor plane plus associated host label, and either an
   * <img> or <video> element depending on the feed type.
   *
   * The plane is the only projection representation (v2): the frustum's far cap,
   * perpendicular to the view axis (§2b — never billboarded; a wall primitive
   * can't pitch, the plane can). It is textured with the live frame: video
   * element direct, canvas double-buffer otherwise.
   *
   * @param {Object} record - Camera record.
   * @returns {Object|null} Projection runtime, or null if no viewer.
   */

  function createProjectionRuntime(record) {
    if (!layerState._viewer) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PROJECTION_CANVAS_WIDTH;
    canvas.height = PROJECTION_CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: true });

    const feedType = parts.model.normalizeFeedType(record.camera.feedType);
    const mode = parts.model.isVideoFeedType(feedType) ? 'video' : 'image';
    const runtime = {
      mode,
      canvas,
      ctx,
      image: null,
      video: null,
      planeEntity: null,
      cameraId: String(record.camera.id),
      labelPosition: new Cesium.Cartesian3(),
      overlayEntry: null,
      planeMaterial: null,
      buffers: null,
      bufferIndex: 0,
      lastTextureSwapAt: 0,
      lastImageRefreshAt: 0,
      imageReady: false,
      imageLoading: false,
      imageStamp: 0,
      drawnImageStamp: -1,
      // Signature of the pixels currently ON the canvas, plus the reused 64x36
      // scratch used to compute it. null = "nothing known", which always redraws.
      lastFrameSignature: null,
      signatureCanvas: null,
      signatureCtx: null,
      lastPlaceholderPaintAt: 0,
      // canvasStamp increments on every canvas write (frame blit / placeholder
      // paint); lastSwappedCanvasStamp trails it so refreshProjectionTextures
      // only re-uploads the plane texture when there is genuinely new content.
      canvasStamp: 1,
      lastSwappedCanvasStamp: 0,
    };

    parts.frames.paintProjectionPlaceholder(ctx, record.camera);

    if (mode === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      video.src = parts.frames.mediaUrlFor(record.camera);
      video.addEventListener('canplay', () => {
        video.play().catch(() => {});
      });
      runtime.video = video;
    } else {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        runtime.imageLoading = false;
        runtime.imageReady = true;
        runtime.imageStamp = Date.now();
      };
      img.onerror = () => {
        runtime.imageLoading = false;
        runtime.imageReady = false;
      };
      runtime.image = img;
    }

    // Monitor plane = the frustum's far cap: video feeds bind the video element
    // directly (Cesium updates video-backed entity materials per frame); image
    // feeds start on the placeholder canvas and switch to double-buffer swaps
    // at <=1Hz.
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    runtime.planeMaterial = new Cesium.ImageMaterialProperty({
      image: mode === 'video' && runtime.video ? runtime.video : canvas,
      transparent: true,
      color: Cesium.Color.WHITE.withAlpha(0.95),
    });
    createProjectionPlane(record, runtime, geometry, positions);

    return runtime;
  }

  /**
   * Lazily initializes the projection runtime for a record if it doesn't exist yet.
   * @param {Object} record - Camera record.
   * @returns {Object|null} The record's projection runtime.
   */

  function ensureProjectionRuntime(record) {
    if (!record) return null;
    if (record.projection) return record.projection;
    const runtime = createProjectionRuntime(record);
    record.projection = runtime;
    if (runtime) {
      layerState._projectionEntities.push(runtime);
    }
    return runtime;
  }

  /**
   * Tears down a projection runtime: stops video playback, removes the monitor
   * plane, and clears its host label if it owns the active source.
   * @param {Object} runtime - Projection runtime to destroy.
   */

  function destroyProjectionRuntime(runtime) {
    if (!runtime) return;
    if (runtime.video) {
      runtime.video.pause();
      runtime.video.removeAttribute('src');
      runtime.video.load();
    }
    if (runtime.planeEntity && layerState._viewer) {
      layerState._viewer.entities.remove(runtime.planeEntity);
      runtime.planeEntity = null;
    }
    if (layerState._projectionOverlayOwnerId === runtime.cameraId)
      clearProjectionOverlay();
    runtime.overlayEntry = null;
    runtime.labelPosition = null;
    runtime.planeMaterial = null;
  }

  function startProjectionLoop() {
    if (layerState._projectionRaf) return;
    if (!parts.model.projectionLoopIsNeeded()) return;
    // The armed projection loop uploads video textures / runs focus fades per
    // frame — the scene must render continuously while it runs. Released when
    // the tick self-stops. (perf wave 2)
    holdContinuousRender('cctv-projection');

    const tick = () => {
      if (!layerState._viewer || !parts.model.projectionLoopIsNeeded()) {
        layerState._projectionRaf = 0;
        releaseContinuousRender('cctv-projection');
        return;
      }

      parts.rendering.refreshCctvFocusStyles(performance.now());

      const active = parts.selection.getActiveRecord();
      if (layerState._enabled && layerState._showProjection && active) {
        ensureProjectionRuntime(active);
        if (active.projection?.video) {
          active.projection.video.play().catch(() => {});
        }
        if (active.projection) {
          parts.frames.drawProjectionFrame(active);
          parts.frames.refreshProjectionTextures(active);
        }
      }

      layerState._projectionRaf = requestAnimationFrame(tick);
    };

    layerState._projectionRaf = requestAnimationFrame(tick);
  }

  /** Cancels the projection animation loop. */

  function stopProjectionLoop() {
    if (layerState._projectionRaf) {
      cancelAnimationFrame(layerState._projectionRaf);
      layerState._projectionRaf = 0;
    }
    releaseContinuousRender('cctv-projection');
  }

  /**
   * Pauses video playback on all non-active camera projections and resumes
   * the active one (if projection is enabled).
   * @param {string|null} activeId - ID of the currently active camera.
   */

  function pauseInactiveProjectionFeeds(activeId) {
    for (const record of layerState._records) {
      if (!record.projection?.video) continue;
      if (
        record.camera.id === activeId &&
        layerState._enabled &&
        layerState._showProjection
      ) {
        record.projection.video.play().catch(() => {});
      } else {
        record.projection.video.pause();
      }
    }
  }
  return {
    createCctvProjectionOverlayEntry,
    updatePlanePlacement,
    clearProjectionOverlay,
    setPlaneVisible,
    createProjectionPlane,
    createProjectionRuntime,
    ensureProjectionRuntime,
    destroyProjectionRuntime,
    startProjectionLoop,
    stopProjectionLoop,
    pauseInactiveProjectionFeeds,
  };
}
