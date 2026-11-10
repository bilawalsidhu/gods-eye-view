import * as geo from '../../geo/index.js';
import { viewshedColors, cameraHue } from '../../data/cctvViewshed.js';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import {
  GROUND_PRIOR_INIT_WAIT_MS,
  CALIBRATION_RANGE_FLOOR_M,
  VIEW_MOTION_REFRESH_MS,
  VIEW_MOTION_MIN_MOVE_FRACTION,
  VIEW_MOTION_MIN_TURN_DEG,
  VIEW_MOTION_COST_FACTOR,
} from './policy.js';

const MIN_TURN_COS = Math.cos((VIEW_MOTION_MIN_TURN_DEG * Math.PI) / 180);

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
  rendererFactory,
}) {
  const { activateCctvCameraFromWorldClick } = services.activation;
  const { resolvePickId, registerPickOwner, unregisterPickOwner } =
    services.picking;
  const { onFocusTargetAppear } = services.focus;
  const { releaseContinuousRender } = services.render;

  /**
   * The settled-view pass: thin the icons, queue the newly visible geometry,
   * reselect cards, and tell subscribers (the camera picker) when the shown
   * set changed since they were last told, including by motion passes.
   */
  function settleView() {
    if (layerState._restoringViewport || !parts.renderer?.ready) return;
    const changed = parts.rendering.refreshHorizonCulling();
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    parts.cards.refreshAmbientCards();
    if (changed || layerState._viewUnpublished) {
      layerState._viewUnpublished = false;
      parts.presentation.notifyListeners();
    }
  }

  /** Records the camera pose the last view pass ran at. */
  function noteViewPose() {
    const camera = parts.renderer?.cameraPose();
    if (!camera?.position) return;
    layerState._viewPose = {
      position: geo.cartesian3.clone(camera.position),
      direction: camera.direction && geo.cartesian3.clone(camera.direction),
    };
  }

  /**
   * Whether the camera moved or turned enough since the last view pass to
   * change what is on screen. A camera that tracks or flies without settling
   * would otherwise rerun the full pass on every tick.
   */
  function viewPoseChanged() {
    const camera = parts.renderer?.cameraPose();
    const pose = layerState._viewPose;
    if (!pose || !camera?.position) return true;
    const height = Math.max(1, camera.cartographic?.height ?? 0);
    const moved = geo.cartesian3.distance(camera.position, pose.position);
    if (moved > height * VIEW_MOTION_MIN_MOVE_FRACTION) return true;
    if (!pose.direction || !camera.direction) return false;
    return geo.cartesian3.dot(camera.direction, pose.direction) < MIN_TURN_COS;
  }

  function viewMotionTick() {
    if (!layerState._enabled) return;
    const now = performance.now();
    const pass = layerState._viewMotionPass;
    if (pass && now - pass.at < pass.ms * VIEW_MOTION_COST_FACTOR) return;
    if (!viewPoseChanged()) return;
    if (parts.rendering.refreshHorizonCulling())
      layerState._viewUnpublished = true;
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    layerState._viewMotionPass = { at: now, ms: performance.now() - now };
  }

  function startViewMotionTimer() {
    if (layerState._viewMotionTimer) return;
    layerState._viewMotionTimer = setInterval(
      viewMotionTick,
      VIEW_MOTION_REFRESH_MS,
    );
  }

  function stopViewMotionTimer() {
    clearInterval(layerState._viewMotionTimer);
    layerState._viewMotionTimer = 0;
  }

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
    stopViewMotionTimer();
    // Idempotent — also covers a re-init without a prior destroy().
    parts.cards.teardownAmbientCards();
    parts.projection.clearProjectionOverlay();
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._viewRecords = [];
    layerState._cameraIndexCache = null;
    layerState._coverageVisibleIds = new Set();
    layerState._neighborCountCache = null;
    layerState._viewUnpublished = false;
    layerState._viewPose = null;
    layerState._viewMotionPass = null;
    layerState._healthById = new Map();
    layerState._count = 0;
    layerState._lastUpdate = null;
    layerState._lastHealthSyncAt = 0;
    layerState._lastError = null;
    layerState._lastFocusStyleAt = 0;
    layerState._activeFocusStyleCount = 0;
    // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
    // recomputes it against the then-current scene.
    layerState._lastAppliedRegime = null;
  }
  function bindScene(viewer, options) {
    // Track the surface regime the initial geometry was computed for
    // and listen for map-stack changes (main.js re-dispatches
    // MapStackController.onChange as this CustomEvent). The handler compares
    // regimes itself, so 'switching'/'error' emissions and same-regime stack
    // swaps (bing→osm) no-op.
    layerState._lastAppliedRegime = parts.ground.currentSurfaceRegime();
    if (!layerState._mapStackListener && typeof window !== 'undefined') {
      layerState._mapStackListener = () => parts.ground.handleMapStackChanged();
      window.addEventListener(
        'gev:map-stack-changed',
        layerState._mapStackListener,
      );
    }

    // Horizon-cull on camera settle (pairs with
    // the billboards' always-on-top depth setting) + one initial pass so the
    // first paint is already culled.
    if (!layerState._horizonCullListener) {
      // Ambient cards piggyback the same settle event: moveEnd-driven
      // reselection only, never per frame (refreshAmbientCards no-ops while
      // the layer is disabled).
      layerState._horizonCullListener = parts.renderer.onMoveEnd(() => {
        layerState._cameraMoving = false;
        stopViewMotionTimer();
        parts.navigation.reopenNearestCamera();
        if (layerState._enabled) settleView();
      });
    }
    if (!layerState._moveStartListener) {
      // Item B: hover picking pauses while the camera is in motion.
      layerState._moveStartListener = parts.renderer.onMoveStart(() => {
        layerState._cameraMoving = true;
        if (layerState._enabled) startViewMotionTimer();
      });
    }
    const canvas = options.engine?.host.canvas ?? viewer?.scene?.canvas;
    if (canvas && typeof ResizeObserver === 'function') {
      layerState._viewResizeObserver = new ResizeObserver(() => {
        if (layerState._enabled) settleView();
      });
      layerState._viewResizeObserver.observe(canvas);
    }
    parts.rendering.refreshHorizonCulling();

    layerState._removeClick = parts.renderer.bindClick(
      (click) => {
        if (!layerState._enabled) return;
        const picked = parts.renderer.pick(click.position);
        const cameraId = parts.selection.extractPickedCameraId(picked);
        if (cameraId) {
          activateCctvCameraFromWorldClick(
            cameraId,
            parts.selection.setActiveCamera,
          );
          return;
        }
        // Any identified scene object owns this click even if its layer does not
        // register a shared pick predicate. This keeps selectable siblings ahead
        // of an overlapping CCTV card while ID-less globe/terrain/tile surfaces
        // remain eligible for true empty-space deselection.
        const pickedId = resolvePickId(picked);
        if (pickedId !== null) return;
        // The scene pick found no camera — try the
        // painted ambient cards. The cards canvas is pointer-events:none (this
        // handler owns the events), so a click landing on a card's rect selects
        // its camera exactly like a click on the icon. Cesium click positions
        // and the recorded rects are both CSS px — direct comparison.
        const cardId = layerState._cctvOverlayHost.hitTest(
          click.position.x,
          click.position.y,
          { sourceId: CCTV_OVERLAY_SOURCE_ID },
        )?.entryId;
        if (cardId && layerState._recordById.has(cardId)) {
          activateCctvCameraFromWorldClick(
            cardId,
            parts.selection.setActiveCamera,
          );
          return;
        }
        if (
          parts.selection.cctvEmptyClickDeselects(picked, {
            activeCameraId: layerState._activeCameraId,
            calibrationMode: layerState._calibrationMode,
          })
        ) {
          parts.selection.deactivateActiveCamera();
        }
      },
      {
        // Item B: hover summons a card on a cardless camera icon. The gesture
        // classifier owns MOUSE_MOVE too, so chain hover work through its seam
        // instead of replacing the travel accumulator's handler.
        onMouseMove: (movement) =>
          parts.hover.handleHoverMove(movement?.endPosition),
      },
    );
  }
  function createRenderer(viewer, options) {
    if (parts.renderer) throw new Error('CCTV layer is already initialized');
    if (typeof rendererFactory !== 'function')
      throw new TypeError('A CCTV renderer factory is required');
    const renderer = rendererFactory({
      state: layerState,
      services,
      parts,
      source,
      engine: options.engine,
    });
    parts.renderer = renderer;
    try {
      renderer.attach(viewer);
      return renderer;
    } catch (error) {
      renderer.destroy();
      parts.renderer = null;
      throw error;
    }
  }
  const methods = {
    /**
     * Initializes the CCTV layer: loads camera sources, builds the catalog,
     * restores calibration from localStorage, creates billboards, sets up click
     * handling, and performs initial health sync. Coverage entities stay lazy.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    async init(viewer, options = {}) {
      const renderer = createRenderer(viewer, options);
      try {
        layerState._sourceAbort?.abort();
        const sourceAbort = new AbortController();
        layerState._sourceAbort = sourceAbort;
        if (typeof document !== 'undefined')
          document.addEventListener(
            'visibilitychange',
            parts.cards.handleVisibilityChange,
          );
        clearRuntimeState();
        layerState._enabled = false;
        layerState._activeCameraId = null;
        layerState._autoHopSuspended = false;
        layerState._openingCameraProvisional = false;
        layerState._lastHopAt = 0;
        layerState._lastViewContext = '';
        layerState._calibrationById = parts.calibration.loadCalibrationStore();

        parts.renderer.createMarkers();

        const sources = await parts.catalog.loadCameraSources();
        sourceAbort.signal.throwIfAborted();
        // prettier-ignore
        const catalogFromSources = parts.catalog.buildCatalogFromSources(sources);
        const catalog = catalogFromSources.length
          ? catalogFromSources
          : parts.catalog.seedCatalog();

        // Viewshed color identity (design §3a): golden-angle hue over the
        // id-SORTED catalog index — deterministic across sessions for a stable
        // catalog, maximally separated for neighboring cameras.
        const hueIndexById = new Map(
          catalog
            .map((camera) => camera.id)
            .sort()
            .map((id, index) => [id, index]),
        );

        for (const camera of catalog) {
          const savedEntry = layerState._calibrationById.get(camera.id);
          if (savedEntry) {
            // Entries saved before the range floor dropped (no rangeFloorM)
            // keep their effective range by re-basing rangeScale once.
            const values =
              savedEntry.rangeFloorM === CALIBRATION_RANGE_FLOOR_M
                ? savedEntry.values
                : parts.calibration.migrateRangeScaleForFloor(
                    savedEntry.values,
                    camera.rangeM,
                  );
            savedEntry.values = values;
            savedEntry.rangeFloorM = CALIBRATION_RANGE_FLOOR_M;
            camera.calibration = parts.calibration.normalizeCalibration(values);
            camera.calSource = savedEntry.source;
          }
          parts.model.ensureCameraPose(camera);
        }

        // Batch ALL camera coords through the Re:Earth
        // ellipsoidal ground-prior resolver (network-cached — NOT a scene query;
        // the catalog's orthometric groundElevationM feeds the geoid fallback
        // chain). Bounded wait: a warm proxy cache resolves in milliseconds, so
        // records are normally built WITH their prior (correct first paint in
        // every regime); a cold/slow upstream loses the race and the batch
        // applies post-hoc via applyLateGroundPriors instead of hanging init.
        const priorsPromise = parts.ground.resolveGroundPriors(catalog);
        const priors = await Promise.race([
          priorsPromise,
          new Promise((resolve) =>
            setTimeout(() => resolve(null), GROUND_PRIOR_INIT_WAIT_MS),
          ),
        ]);
        sourceAbort.signal.throwIfAborted();

        for (let i = 0; i < catalog.length; i++) {
          const camera = catalog[i];
          // Ellipsoidal ground prior (or null while the batch is still in
          // flight). Geometry falls back to the catalog value only until the
          // batch lands.
          const groundPrior = priors?.[i] || null;
          // Cheap first-pass altitude from the ellipsoidal prior (catalog value
          // only as the pre-prior fallback) — the staggered geometry queue
          // refines with sampled tile heights after enable so the init path
          // never raycasts the scene once per camera.
          const priorGround = Number.isFinite(groundPrior?.ellipsoid)
            ? groundPrior.ellipsoid
            : Number(camera.groundElevationM) || 0;
          camera.absoluteHeightM = priorGround + camera.mountHeightM;
          const position = geo.cartesian3.fromDegrees(
            camera.lon,
            camera.lat,
            camera.absoluteHeightM,
          );
          const billboard = parts.renderer.createMarker(camera, position);

          const record = {
            camera,
            position,
            billboard,
            coverageEntities: [],
            projection: null,
            // Regime-aware ground resolution state.
            //   groundPrior     — { ellipsoid, source } from the Re:Earth batch
            //     (null until a late batch lands). The prior applies in EVERY
            //     regime and is the terrain-globe resolution outright.
            //   groundResolved  — PER-REGIME one-shot latch (regime key →
            //     boolean): true once this record's resolution completed for that
            //     regime; such records are excluded from the completion pass so
            //     their geometry freezes. Re-armed only on a genuine pose change,
            //     explicit user select/move, or a surface-regime change — never
            //     on the 10s timer.
            //   groundSamples   — PER-REGIME resolved ground (regime key →
            //     metres): the accepted one-shot scene sample in google-3d, the
            //     mirrored prior in terrain-globe. Kept across re-arms as the
            //     "has ever resolved" memory for the B9c mid-stream guard.
            //   frustumPositions — cached Cartesians for pure recomputes (so
            //     plane placement never re-derives geometry it already has).
            groundPrior,
            groundResolved: {},
            groundSamples: {},
            frustumGeometry: null,
            frustumPositions: null,
            // §9.1 activation obstruction probe result: effective-range clamp so
            // the far-cap plane never clips into the tiles. Null = unclamped.
            // Reset + re-probed on every activation; cleared when the user takes
            // the range slider (slider overrides the clamp).
            probeClampRangeM: null,
            // Viewshed (design §3a/§3b): per-camera color identity + the volume
            // primitive handle (exists only in viewshed mode for the visible set).
            viewshedColors: viewshedColors(
              cameraHue(hueIndexById.get(camera.id) ?? 0),
            ),
            viewshedPrimitive: null,
            viewshedActiveTint: false,
          };
          layerState._records.push(record);
          layerState._recordById.set(camera.id, record);
        }

        layerState._count = layerState._records.length;
        // No camera is picked here: enable() opens on the one nearest the
        // viewer, unless restored params selected one first.

        // If the prior batch lost init's bounded race, apply it post-hoc
        // when it lands (pure recomputes — applyLateGroundPriors guards against
        // a torn-down/re-inited catalog).
        if (!priors) {
          const initRecords = layerState._records.slice();
          priorsPromise
            .then((late) => {
              if (late) parts.ground.applyLateGroundPriors(initRecords, late);
            })
            .catch(() => {});
        }

        bindScene(viewer, options);
        await parts.health.syncHealthState(true);
        sourceAbort.signal.throwIfAborted();
        parts.rendering.refreshCoverageStyles();
        parts.presentation.notifyListeners();
        parts.renderer.restoreOrder();
        // prettier-ignore
        console.log('[Data:CCTV] Initialized with', layerState._count, 'cameras');
      } catch (error) {
        if (parts.renderer === renderer) methods.destroy();
        else renderer.destroy();
        throw error;
      }
    },

    attachRenderer(viewer, options = {}) {
      const renderer = createRenderer(viewer, options);
      layerState._restoringViewport = Boolean(options.waitForCameraRestore);
      renderer.createMarkers();
      const active = parts.selection.getActiveRecord();
      for (const record of layerState._records) {
        record.billboard = renderer.createMarker(
          record.camera,
          record.position,
        );
        record.groundResolved = {};
        record.groundSamples = {};
        record.probeClampRangeM = null;
        // The new surface is unprobed: update() probes the active camera
        // once its tiles are in.
        record.surfaceProbePending =
          record === active && record.activationDone === true;
        record.activationDone = false;
      }
      renderer.setMarkersVisible(layerState._enabled);
      bindScene(viewer, options);
      if (!layerState._restoringViewport && layerState._enabled)
        this.resumeDisplay();
    },

    resumeViewport() {
      if (!layerState._restoringViewport) return;
      layerState._restoringViewport = false;
      if (layerState._enabled && parts.renderer) this.resumeDisplay();
    },

    resumeDisplay() {
      this.showRenderer();
      if (layerState._calibrationMode) {
        parts.calibration.ensureGizmo();
        layerState._gizmo?.setEnabled(true);
        services.render.holdContinuousRender(
          'cctv-adjust',
          parts.renderer?.engine,
        );
      }
      settleView();
    },

    detachRenderer() {
      if (!parts.renderer) return;
      layerState._restoringViewport = true;
      parts.renderer.hideCredit();
      unregisterPickOwner('cctv', parts.renderer?.engine);
      if (layerState._mapStackListener) {
        window.removeEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
        layerState._mapStackListener = null;
      }
      layerState._viewResizeObserver?.disconnect();
      layerState._viewResizeObserver = null;
      layerState._horizonCullListener?.();
      layerState._moveStartListener?.();
      layerState._removeFocusAppearListener?.();
      layerState._horizonCullListener =
        layerState._moveStartListener =
        layerState._removeFocusAppearListener =
          null;
      layerState._gizmo?.destroy();
      layerState._gizmo = null;
      releaseContinuousRender('cctv-adjust', parts.renderer?.engine);
      layerState._removeClick?.();
      layerState._removeClick = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      stopViewMotionTimer();
      parts.cards.stopCardFrameLoop();
      parts.hover.clearHoverCard();
      parts.projection.clearProjectionOverlay();
      layerState._cctvOverlayHost.clearSource(CCTV_OVERLAY_SOURCE_ID);
      parts.geometry.destroyCoverageEntities({ retainMedia: true });
      for (const record of layerState._records) {
        record.billboard = null;
        record.coverageEntities = [];
      }
      layerState._viewRecords = [];
      layerState._cameraIndexCache = null;
      layerState._viewPose = null;
      layerState._cameraMoving = false;
      parts.renderer.destroy();
      parts.renderer = null;
    },

    /**
     * Enables the layer: shows entities, starts the projection loop, and kicks
     * the staggered geometry-load queue. Heavy work (per-camera ground
     * sampling) is deferred/batched so the frame budget never collapses at
     * enable time.
     */
    enable() {
      layerState._enabled = true;
      layerState._lastUpdate = Date.now();
      if (!layerState._activeCameraId && layerState._records.length) {
        layerState._activeCameraId = parts.navigation.openingCameraId();
        layerState._autoHopSuspended = false;
        layerState._openingCameraProvisional = true;
      }
      this.showRenderer(true);
    },
    showRenderer(refreshImage = false) {
      if (
        layerState._records.some(
          (record) => record.camera.cityId === 'warendorf',
        )
      )
        parts.renderer?.showCredit();
      // Pick-ownership (H2): camera billboards use the camera id directly;
      // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
      registerPickOwner(
        'cctv',
        (pickedId) => {
          if (layerState._recordById.has(pickedId)) return true;
          if (
            typeof pickedId === 'string' &&
            pickedId.startsWith(GIZMO_ID_PREFIX)
          )
            return true;
          const coverage =
            /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/.exec(
              pickedId,
            );
          return Boolean(coverage && layerState._recordById.has(coverage[1]));
        },
        parts.renderer?.engine,
      );
      const activeRecord = parts.selection.getActiveRecord();
      if (activeRecord) {
        parts.projection.ensureProjectionRuntime(activeRecord);
        if (refreshImage)
          parts.frames.refreshProjectionImage(activeRecord, true);
      }
      parts.rendering.refreshHorizonCulling();
      // Re-enabled mid-flight: moveStart has already fired.
      if (layerState._cameraMoving) startViewMotionTimer();
      parts.geometryQueue.startGeometryLoadQueue();
      parts.rendering.refreshCoverageStyles();
      parts.projection.startProjectionLoop();
      // The projection loop self-stops when idle; a focus target appearing
      // (user starts tracking a contact) is the one edge it can't see while
      // stopped, so re-arm on it. Removed on disable.
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = onFocusTargetAppear(() =>
        parts.projection.startProjectionLoop(),
      );
      // Ambient card tier: shared host source + policy-gated frame pacer + the
      // initial selection pass (moveEnd drives every later reselection).
      layerState._cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, true);
      parts.cards.startCardFrameLoop();
      parts.cards.refreshAmbientCards();
      parts.presentation.notifyListeners();
      parts.renderer.restoreOrder();
    },

    /** Disables the layer: hides entities, stops the projection loop and load queue. */
    disable() {
      parts.renderer?.hideCredit();
      layerState._enabled = false;
      unregisterPickOwner('cctv', parts.renderer?.engine);
      // ADJUST mode does not survive a layer toggle — predictable re-entry.
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust', parts.renderer?.engine);
      layerState._gizmo?.setEnabled(false);
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      stopViewMotionTimer();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
      // Nothing is in view while the layer is off.
      layerState._viewRecords = [];
      layerState._cameraIndexCache = null;
      parts.presentation.notifyListeners();
    },

    /**
     * Tears down the layer: destroys click handler, projection loop, coverage
     * entities, billboards, and clears all runtime state and subscribers.
     * Releases resources through the renderer that originally acquired them.
     */
    destroy() {
      parts.renderer?.hideCredit();
      layerState._sourceAbort?.abort();
      if (typeof document !== 'undefined')
        document.removeEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      unregisterPickOwner('cctv', parts.renderer?.engine);
      if (layerState._mapStackListener && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
        layerState._mapStackListener = null;
      }
      layerState._viewResizeObserver?.disconnect();
      layerState._viewResizeObserver = null;
      layerState._horizonCullListener?.();
      layerState._horizonCullListener = null;
      layerState._moveStartListener?.();
      layerState._moveStartListener = null;
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      if (layerState._gizmo) {
        layerState._gizmo.destroy();
        layerState._gizmo = null;
      }
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust', parts.renderer?.engine);
      layerState._removeClick?.();
      layerState._removeClick = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.cards.teardownAmbientCards();
      parts.geometry.destroyCoverageEntities();
      parts.renderer?.destroy();
      parts.renderer = null;
      clearRuntimeState();
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._openingCameraProvisional = false;
      // Clear existing subscribers rather than replacing the Set —
      // replacing would silently orphan any unsubscribe() closures
      layerState._listeners.clear();
    },
  };

  return { clearRuntimeState, methods };
}
