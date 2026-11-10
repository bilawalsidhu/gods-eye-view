import { attachCctvVideo } from './videoPlayback.js';
import * as geo from '../../geo/index.js';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
  PROJECTION_TEXTURE_SWAP_MS,
} from './policy.js';

export function createProjection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    holdContinuousRender,
    releaseContinuousRender,
    governorRequestRender,
  } = services.render;
  let loopRevision = 0;

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
    parts.renderer.updatePlane(
      runtime,
      geometry,
      positions,
      parts.model.planeOrientationFor(record.camera, positions.capCenter),
    );
    if (runtime.labelPosition) {
      geo.cartesian3.clone(positions.label, runtime.labelPosition);
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
    runtime.planeVisible = !!visible;
    if (runtime.planeEntity)
      parts.renderer?.setPlaneVisible(runtime, !!visible);
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
    runtime.labelPosition ||= geo.cartesian3.create();
    geo.cartesian3.clone(positions.label, runtime.labelPosition);
    runtime.cameraId = String(record.camera.id);
    runtime.overlayEntry = createCctvProjectionOverlayEntry({
      cameraId: runtime.cameraId,
      name: record.camera.name,
      position: () => runtime.labelPosition,
    });
    runtime.planeVisible = false;
    runtime.planeEntity = parts.renderer.createPlane(
      record,
      runtime,
      geometry,
      positions,
      parts.model.planeOrientationFor(record.camera, positions.capCenter),
    );
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
    if (!parts.renderer?.ready) return null;
    // Québec 511 denies CORS pixel access; Québec map previews are native DOM
    // videos positioned over the globe, never video textures.
    if (parts.model.isBrowserOverlayCamera(record.camera)) return null;
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
      labelPosition: geo.cartesian3.create(),
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
      disposed: false,
    };

    parts.frames.paintProjectionPlaceholder(ctx, record.camera);
    runtime.planeMaterial = parts.renderer.createPlaneMaterial(canvas);

    if (mode === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      // Cesium sizes the video texture from the element's width/height
      // attributes at first upload. Set them from the real stream dimensions
      // and rebind on any resolution change (camera switch, adaptive source).
      const bindVideoTexture = () => {
        if (
          runtime.disposed ||
          runtime.video !== video ||
          !runtime.planeMaterial
        )
          return;
        if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
        video.width = video.videoWidth;
        video.height = video.videoHeight;
        parts.renderer.setPlaneImage(runtime, runtime.canvas);
        parts.renderer.setPlaneImage(runtime, video);
      };
      video.addEventListener('loadedmetadata', bindVideoTexture);
      video.addEventListener('resize', bindVideoTexture);
      runtime.removeVideoBindings = () => {
        video.removeEventListener('loadedmetadata', bindVideoTexture);
        video.removeEventListener('resize', bindVideoTexture);
        runtime.removeVideoBindings = null;
      };
      runtime.video = video;
      runtime.playback = attachCctvVideo(
        video,
        parts.frames.mediaUrlFor(record.camera),
        feedType,
        {
          onFailure: () => {
            if (runtime.disposed) return;
            runtime.removeVideoBindings?.();
            runtime.video = null;
            runtime.mode = 'image';
            runtime.image = new Image();
            runtime.image.decoding = 'async';
            runtime.image.onload = () => {
              if (runtime.disposed) return;
              runtime.imageLoading = false;
              runtime.imageReady = true;
              runtime.imageStamp = Date.now();
            };
            runtime.image.onerror = () => {
              if (runtime.disposed) return;
              runtime.imageLoading = false;
              runtime.imageReady = false;
            };
            if (runtime.planeMaterial)
              parts.renderer?.setPlaneImage(runtime, runtime.canvas);
            parts.frames.refreshProjectionImage(record, true);
            parts.presentation.notifyListeners();
          },
        },
      );
    } else {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (runtime.disposed) return;
        runtime.imageLoading = false;
        runtime.imageReady = true;
        runtime.imageStamp = Date.now();
      };
      img.onerror = () => {
        if (runtime.disposed) return;
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
    try {
      createProjectionPlane(record, runtime, geometry, positions);
    } catch (error) {
      destroyProjectionRuntime(runtime);
      throw error;
    }

    return runtime;
  }

  /**
   * Lazily initializes the projection runtime for a record if it doesn't exist yet.
   * @param {Object} record - Camera record.
   * @returns {Object|null} The record's projection runtime.
   */

  function ensureProjectionRuntime(record) {
    if (!record) return null;
    if (record.projection && !record.projection.disposed) {
      const runtime = record.projection;
      if (runtime.needsPlane && parts.renderer?.ready) {
        const geometry =
          record.frustumGeometry ||
          parts.geometry.computeFrustumGeometry(
            record.camera,
            parts.ground.groundAltFor(record),
            record.probeClampRangeM,
          );
        const positions =
          record.frustumPositions || parts.geometry.frustumCartesians(geometry);
        runtime.planeMaterial = parts.renderer.createPlaneMaterial(
          runtime.canvas,
        );
        createProjectionPlane(record, runtime, geometry, positions);
        if (runtime.video?.videoWidth)
          parts.renderer.setPlaneImage(runtime, runtime.video);
        runtime.needsPlane = false;
        runtime.lastSwappedCanvasStamp = -1;
      }
      return runtime;
    }
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
    if (!runtime || runtime.disposed) return;
    runtime.disposed = true;
    runtime.removeVideoBindings?.();
    runtime.playback?.dispose();
    runtime.playback = null;
    if (runtime.image) {
      runtime.image.onload = null;
      runtime.image.onerror = null;
      runtime.image.src = '';
    }
    if (runtime.video) {
      runtime.video.pause();
      runtime.video.removeAttribute('src');
      runtime.video.load();
    }
    if (runtime.planeEntity) {
      parts.renderer?.removePlane(runtime);
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
    clearTimeout(layerState._projectionTimer);
    layerState._projectionTimer = 0;
    const revision = ++loopRevision;

    const tick = () => {
      if (revision !== loopRevision) return;
      layerState._projectionRaf = 0;
      layerState._projectionTimer = 0;
      if (!parts.renderer?.ready || !parts.model.projectionLoopIsNeeded()) {
        releaseContinuousRender('cctv-projection', parts.renderer?.engine);
        return;
      }

      parts.rendering.refreshCctvFocusStyles(performance.now());

      const active = parts.selection.getActiveRecord();
      if (layerState._enabled && layerState._showProjection && active) {
        ensureProjectionRuntime(active);
        if (active.projection && !active.projection.video) {
          parts.frames.drawProjectionFrame(active);
          if (parts.frames.refreshProjectionTextures(active))
            governorRequestRender(
              'cctv-projection-image',
              parts.renderer?.engine,
            );
        }
      }

      const continuous =
        (layerState._showProjection && active?.projection?.video) ||
        services.focus.focusPassIsNeeded(
          services.focus.getFocusTarget(),
          layerState._activeFocusStyleCount,
        );
      if (continuous) {
        holdContinuousRender('cctv-projection', parts.renderer?.engine);
        layerState._projectionRaf = requestAnimationFrame(tick);
      } else {
        // Stills retain the existing fetch/texture cadence without rendering
        // unchanged pixels at display refresh rate.
        releaseContinuousRender('cctv-projection', parts.renderer?.engine);
        layerState._projectionTimer = setTimeout(
          tick,
          PROJECTION_TEXTURE_SWAP_MS,
        );
      }
    };

    layerState._projectionRaf = requestAnimationFrame(tick);
  }

  /** Cancels the projection animation loop. */

  function stopProjectionLoop() {
    loopRevision++;
    clearTimeout(layerState._projectionTimer);
    layerState._projectionTimer = 0;
    if (layerState._projectionRaf) {
      cancelAnimationFrame(layerState._projectionRaf);
      layerState._projectionRaf = 0;
    }
    releaseContinuousRender('cctv-projection', parts.renderer?.engine);
  }

  /**
   * Pauses video playback on all non-active camera projections and resumes
   * the active one (if projection is enabled).
   * @param {string|null} activeId - ID of the currently active camera.
   */

  /**
   * The active camera's decoded <video>, for a second surface (the panel card)
   * to paint from. Null when the active feed is a still or not yet attached.
   * @returns {HTMLVideoElement|null}
   */
  function getActiveVideoElement() {
    if (!layerState._enabled) return null;
    return parts.selection.getActiveRecord()?.projection?.video || null;
  }

  function pauseInactiveProjectionFeeds(activeId) {
    for (const record of layerState._records) {
      if (!record.projection?.video) continue;
      if (record.camera.id === activeId && layerState._enabled) {
        record.projection.video.play().catch(() => {});
      } else {
        const runtime = record.projection;
        destroyProjectionRuntime(runtime);
        record.projection = null;
        layerState._projectionEntities = layerState._projectionEntities.filter(
          (entry) => entry !== runtime,
        );
      }
    }
  }
  return {
    createCctvProjectionOverlayEntry,
    getActiveVideoElement,
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
