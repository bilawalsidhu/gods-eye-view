import { attachCctvVideo } from './videoPlayback.js';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  PLANE_OUTLINE_COLOR,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
} from './policy.js';

/** The monitor plane's alpha over its frame, as its image material had it. */
const PLANE_ALPHA = 0.95;

/** A plain white image, for a plane with no media (tests). */
const WHITE_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
      '<rect width="1" height="1" fill="#fff"/></svg>',
  );

/** Copy a position's coordinates into `out`. */
function copyPosition(from, out) {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  return out;
}

export function createProjection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /**
   * Build the protected label associated with one active monitor plane.
   * @param {{cameraId: string, name: string, position: object|Function}} input
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
   * Re-derives the monitor plane's placement (position, orientation,
   * dimensions) + label from the record's current frustum geometry, so the plane
   * always caps the wireframe exactly (corner rays terminate on its corners).
   * No-op when the record has no plane runtime (idle neighbors have no plane).
   * @param {Object} record - Camera record.
   */

  function updatePlanePlacement(record) {
    const runtime = record?.projection;
    const plane = runtime?.plane;
    if (!plane) return;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.rendering.frustumCartesians(geometry);
    placePlane(plane, record.camera, geometry, positions);
    if (runtime.labelPosition)
      copyPosition(positions.label, runtime.labelPosition);
    parts.drawSets.writePlane(plane);
  }

  /** Pose a plane handle on the frustum's far cap. */
  function placePlane(plane, camera, geometry, positions) {
    plane.center = positions.capCenter;
    plane.orientation = parts.model.planeOrientationFor(
      camera,
      positions.capCenter,
    );
    plane.size = [geometry.halfW * 2, geometry.halfH * 2];
  }

  /**
   * Give the monitor plane another image: a canvas, or the video element.
   * @param {Object} runtime - Projection runtime.
   * @param {{canvas: HTMLCanvasElement}|{video: HTMLVideoElement}} source
   */
  function setPlaneSource(runtime, source) {
    runtime.planeSource = source;
    if (!runtime.plane) return;
    runtime.plane.source = source;
    parts.drawSets.writePlane(runtime.plane);
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
    if (runtime.plane && runtime.plane.show !== !!visible) {
      runtime.plane.show = !!visible;
      parts.drawSets.writePlane(runtime.plane);
    }
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

  /** A plain white plane image, for a plane with no media (tests). */
  function plainPlaneSource() {
    return { image: WHITE_IMAGE };
  }

  /** Create the monitor plane plus its cached host-label presentation. */

  function createProjectionPlane(record, runtime, geometry, positions) {
    runtime.labelPosition ||= { x: 0, y: 0, z: 0 };
    copyPosition(positions.label, runtime.labelPosition);
    runtime.cameraId = String(record.camera.id);
    runtime.overlayEntry = createCctvProjectionOverlayEntry({
      cameraId: runtime.cameraId,
      name: record.camera.name,
      position: () => runtime.labelPosition,
    });
    const plane = {
      id: `cctv-${record.camera.id}-plane`,
      cameraId: record.camera.id,
      source: runtime.planeSource || plainPlaneSource(),
      alpha: PLANE_ALPHA,
      outline: { color: PLANE_OUTLINE_COLOR, widthPx: 1 },
      show: false,
    };
    placePlane(plane, record.camera, geometry, positions);
    runtime.plane = plane;
    parts.drawSets.writePlane(plane);
    return plane;
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
      plane: null,
      cameraId: String(record.camera.id),
      labelPosition: { x: 0, y: 0, z: 0 },
      overlayEntry: null,
      planeSource: { canvas },
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

    if (mode === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      // The plane shows the video once it knows its size (the element's
      // width/height follow the real stream dimensions); the renderer reads
      // it at a new size on any later resolution change (camera switch,
      // adaptive source).
      const bindVideoTexture = () => {
        if (runtime.video !== video || runtime.disposed) return;
        if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
        video.width = video.videoWidth;
        video.height = video.videoHeight;
        if (runtime.planeSource?.video !== video)
          setPlaneSource(runtime, { video });
      };
      video.addEventListener('loadedmetadata', bindVideoTexture);
      video.addEventListener('resize', bindVideoTexture);
      runtime.video = video;
      runtime.playback = attachCctvVideo(
        video,
        parts.frames.mediaUrlFor(record.camera),
        feedType,
        {
          onFailure: () => {
            if (runtime.disposed) return;
            runtime.video = null;
            runtime.mode = 'image';
            runtime.image = new Image();
            runtime.image.decoding = 'async';
            runtime.image.onload = () => {
              runtime.imageLoading = false;
              runtime.imageReady = true;
              runtime.imageStamp = Date.now();
            };
            runtime.image.onerror = () => {
              runtime.imageLoading = false;
              runtime.imageReady = false;
            };
            setPlaneSource(runtime, { canvas: runtime.canvas });
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
    // directly (the renderer reads it every frame); image feeds start on the
    // placeholder canvas and switch to double-buffer swaps at <=1Hz.
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.rendering.frustumCartesians(geometry);
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
    if (record.projection && !record.projection.disposed)
      return record.projection;
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
    if (runtime.plane) {
      parts.drawSets.removePlane(runtime.plane);
      runtime.plane = null;
    }
    if (layerState._projectionOverlayOwnerId === runtime.cameraId)
      clearProjectionOverlay();
    runtime.overlayEntry = null;
    runtime.labelPosition = null;
    runtime.planeSource = null;
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
        if (active.projection && !active.projection.video) {
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
    setPlaneSource,
    plainPlaneSource,
    createProjectionPlane,
    createProjectionRuntime,
    ensureProjectionRuntime,
    destroyProjectionRuntime,
    startProjectionLoop,
    stopProjectionLoop,
    pauseInactiveProjectionFeeds,
  };
}
