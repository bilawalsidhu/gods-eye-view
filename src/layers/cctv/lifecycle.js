import * as Cesium from 'cesium';
import { viewshedColors, cameraHue } from '../../data/cctvViewshed.js';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import {
  GROUND_PRIOR_INIT_WAIT_MS,
  CAMERA_ICON,
  IDLE_CAMERA_COLOR,
  CALIBRATION_RANGE_FLOOR_M,
} from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { activateCctvCameraFromWorldClick } = services.activation;
  const { resolvePickId, registerPickOwner, unregisterPickOwner } =
    services.picking;
  const { onFocusTargetAppear } = services.focus;
  const { releaseContinuousRender } = services.render;

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
    // Idempotent — also covers a re-init without a prior destroy().
    parts.cards.teardownAmbientCards();
    parts.projection.clearProjectionOverlay();
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._healthById = new Map();
    layerState._count = 0;
    layerState._lastUpdate = null;
    layerState._lastHealthSyncAt = 0;
    layerState._lastError = null;
    layerState._lastFocusStyleAt = 0;
    layerState._activeFocusStyleCount = 0;
    // FIX ①/③: the discovered tileset handle is scene-scoped — drop it so a fresh
    // init re-discovers against the current scene primitives.
    layerState._activeTileset = null;
    // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
    // recomputes it against the then-current scene.
    layerState._lastAppliedRegime = null;
  }
  const methods = {
    /**
     * Initializes the CCTV layer: loads camera sources, builds the catalog,
     * restores calibration from localStorage, creates billboards, sets up click
     * handling, and performs initial health sync. Coverage entities stay lazy.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    async init(viewer) {
      layerState._sourceAbort?.abort();
      const sourceAbort = new AbortController();
      layerState._sourceAbort = sourceAbort;
      if (typeof document !== 'undefined')
        document.addEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      layerState._viewer = viewer;
      clearRuntimeState();
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._lastHopAt = 0;
      layerState._lastViewContext = '';
      layerState._calibrationById = parts.calibration.loadCalibrationStore();

      layerState._billboards = new Cesium.BillboardCollection();
      layerState._viewer.scene.primitives.add(layerState._billboards);
      registerSpriteCollection('cctv', layerState._billboards);

      const sources = await parts.catalog.loadCameraSources();
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

      // Task 5 (height-datum fix): batch ALL camera coords through the Re:Earth
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
        const position = Cesium.Cartesian3.fromDegrees(
          camera.lon,
          camera.lat,
          camera.absoluteHeightM,
        );
        const billboard = layerState._billboards.add({
          id: camera.id,
          image: CAMERA_ICON,
          position,
          color: IDLE_CAMERA_COLOR,
          width: 24,
          height: 24,
          // Field-test fix (2026-07-06): always-on-top. The old finite value
          // (1800 m) re-engaged the depth test at far zoom, where the COARSE
          // far-LOD Google-3D mesh sits above the true ground and swallowed
          // ground-anchored icons ("submerged" pills over SF). Far-side-of-globe
          // icons are handled by refreshHorizonCulling() (the flights-layer
          // EllipsoidalOccluder pattern), not by the depth test.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(350, 1.25, 4_000_000, 0.42),
        });

        const record = {
          camera,
          position,
          billboard,
          coverageEntities: [],
          projection: null,
          // Task 5 (height-datum fix): regime-aware ground resolution state.
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
      if (layerState._records.length > 0) {
        // Projection runtime + first frame fetch are deferred to enable() so
        // initializing the catalog stays render-cheap.
        layerState._activeCameraId = layerState._records[0].camera.id;
      }

      // Task 5: if the prior batch lost init's bounded race, apply it post-hoc
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

      // Task 5: track the surface regime the initial geometry was computed for
      // and listen for map-stack changes (main.js re-dispatches
      // MapStackController.onChange as this CustomEvent). The handler compares
      // regimes itself, so 'switching'/'error' emissions and same-regime stack
      // swaps (bing→osm) no-op.
      layerState._lastAppliedRegime = parts.ground.currentSurfaceRegime();
      if (!layerState._mapStackListener && typeof window !== 'undefined') {
        layerState._mapStackListener = () =>
          parts.ground.handleMapStackChanged();
        window.addEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
      }

      // Field-test fix (2026-07-06): horizon-cull on camera settle (pairs with
      // the billboards' always-on-top depth setting) + one initial pass so the
      // first paint is already culled.
      if (!layerState._horizonCullListener) {
        // Ambient cards piggyback the same settle event: moveEnd-driven
        // reselection only, never per frame (refreshAmbientCards no-ops while
        // the layer is disabled).
        layerState._horizonCullListener = () => {
          layerState._cameraMoving = false;
          parts.rendering.refreshHorizonCulling();
          parts.cards.refreshAmbientCards();
        };
        layerState._viewer.camera.moveEnd.addEventListener(
          layerState._horizonCullListener,
        );
      }
      if (!layerState._moveStartListener) {
        // Item B: hover picking pauses while the camera is in motion.
        layerState._moveStartListener = () => {
          layerState._cameraMoving = true;
        };
        layerState._viewer.camera.moveStart.addEventListener(
          layerState._moveStartListener,
        );
      }
      parts.rendering.refreshHorizonCulling();

      layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
        layerState._viewer.scene.canvas,
      );
      parts.selection.bindCctvWorldClickGesture(
        layerState._clickHandler,
        (click) => {
          if (!layerState._enabled) return;
          const picked = layerState._viewer.scene.pick(click.position);
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
          // Item A (owner round 2): the scene pick found no camera — try the
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

      await parts.health.syncHealthState(true);
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
      restoreSpriteOrder(layerState._viewer);
      console.log('[Data:CCTV] Initialized with', layerState._count, 'cameras');
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
      // Pick-ownership (H2): camera billboards use the camera id directly;
      // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
      registerPickOwner('cctv', (pickedId) => {
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
      });
      if (!layerState._activeCameraId && layerState._records.length) {
        layerState._activeCameraId = layerState._records[0].camera.id;
        layerState._autoHopSuspended = false;
      }
      const activeRecord = parts.selection.getActiveRecord();
      if (activeRecord) {
        parts.projection.ensureProjectionRuntime(activeRecord);
        parts.frames.refreshProjectionImage(activeRecord, true);
      }
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
      restoreSpriteOrder(layerState._viewer);
    },

    /** Disables the layer: hides entities, stops the projection loop and load queue. */
    disable() {
      layerState._enabled = false;
      unregisterPickOwner('cctv');
      // ADJUST mode does not survive a layer toggle — predictable re-entry.
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      layerState._gizmo?.setEnabled(false);
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
      parts.presentation.notifyListeners();
    },

    /**
     * Tears down the layer: destroys click handler, projection loop, coverage
     * entities, billboards, and clears all runtime state and subscribers.
     * @param {Cesium.Viewer} [viewer] - Viewer instance (falls back to stored ref).
     */
    destroy(viewer) {
      layerState._sourceAbort?.abort();
      if (typeof document !== 'undefined')
        document.removeEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      unregisterPickOwner('cctv');
      if (layerState._mapStackListener && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
        layerState._mapStackListener = null;
      }
      const teardownViewer = viewer || layerState._viewer;
      if (layerState._horizonCullListener && teardownViewer?.camera?.moveEnd) {
        teardownViewer.camera.moveEnd.removeEventListener(
          layerState._horizonCullListener,
        );
        layerState._horizonCullListener = null;
      }
      if (layerState._moveStartListener && teardownViewer?.camera?.moveStart) {
        teardownViewer.camera.moveStart.removeEventListener(
          layerState._moveStartListener,
        );
        layerState._moveStartListener = null;
      }
      if (layerState._gizmo) {
        layerState._gizmo.destroy();
        layerState._gizmo = null;
      }
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (teardownViewer?.scene?.screenSpaceCameraController) {
        teardownViewer.scene.screenSpaceCameraController.enableInputs = true;
      }
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.cards.teardownAmbientCards();
      parts.geometry.destroyCoverageEntities();
      if (layerState._billboards && teardownViewer) {
        teardownViewer.scene.primitives.remove(layerState._billboards);
        layerState._billboards = null;
      }
      clearRuntimeState();
      layerState._viewer = null;
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      // Clear existing subscribers rather than replacing the Set —
      // replacing would silently orphan any unsubscribe() closures
      layerState._listeners.clear();
    },
  };

  return { clearRuntimeState, methods };
}
