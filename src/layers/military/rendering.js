import {
  CLASS_MODEL_REAL,
  CLASS_SCALE_3D,
  CLASS_SCALE_2D,
} from '../../data/aircraftClass.js';
import {
  visualCenterForModel,
  trailAnchorForModel,
} from '../../data/modelVisualAnchor.js';
import * as Cesium from 'cesium';
import { selectModelEligible } from '../../data/modelEligibility.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { aircraftTreatmentAlpha } from '../../data/aircraftRecession.js';
import { isEmergency } from '../../data/aircraftEmergency.js';
import {
  PLANE_MODEL_SCALE,
  PLANE_MODEL_URL,
  PLANE_NATIVE_RADIUS_M,
  PLANE_BELLY_OFFSET_NATIVE,
  MODEL_SCALE,
  JET_MODEL_URL,
  MODEL_NATIVE_RADIUS_M,
  MODEL_BELLY_OFFSET_NATIVE,
  MODEL_HEADING_OFFSET_DEG,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  MIL_ICON_COLOR,
  TRACKED_ICON_COLOR,
  EMERGENCY_ICON_COLOR,
  MODEL_ALT_CEIL_M,
  MODEL_MAX_ALL,
  MODEL_MAX,
  COCKPIT_MODEL_MAX,
  MODEL_ALL_ADD_M,
  MODEL_PROX_ADD_M,
  MODEL_ALL_KEEP_M,
  MODEL_PROX_KEEP_M,
  IR_RELOAD_BATCH,
  MODEL_MIN_PX,
  MODEL_COLOR_BLEND_AMOUNT,
  TRACKED_MODEL_MIN_PX,
  TRACKED_MODEL_MAX_PX,
  FLEET_DR_INTERVAL_MS,
} from './policy.js';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from '../../data/aircraftModelLighting.js';
import { aircraftVisuals } from '../aircraft/visualState.js';
import { modelState, setModel } from '../../data/modelMirror.js';

export function createRendering({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { tr3bIconKind, isTr3b } = services.aircraftPresentation;
  const { trackedModelScaleForPixelCap } = services.camera;
  const { focusNowMs, getFocusTarget } = services.focus;
  const { applyAircraftModelTreatment } = services.recession;

  function _modelSpec(klass) {
    let spec = flightState._specCache.get(klass);
    if (spec) return spec;
    const real = CLASS_MODEL_REAL[klass];
    if (real) {
      spec = {
        url: real.url,
        scale: 1,
        nativeRadiusM: real.radiusM,
        bellyM: real.bellyM,
        headingOffsetDeg: 180,
        visualCenterNative: visualCenterForModel(real.url),
        trailAnchorNative: trailAnchorForModel(real.url),
      };
    } else if (
      klass === 'airliner' ||
      klass === 'quadjet' ||
      klass === 'glider'
    ) {
      const scale = PLANE_MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
      spec = {
        url: PLANE_MODEL_URL,
        scale,
        nativeRadiusM: PLANE_NATIVE_RADIUS_M,
        bellyM: PLANE_BELLY_OFFSET_NATIVE * scale,
        headingOffsetDeg: 180,
        visualCenterNative: visualCenterForModel(PLANE_MODEL_URL),
        trailAnchorNative: trailAnchorForModel(PLANE_MODEL_URL),
      };
    } else {
      const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
      spec = {
        url: JET_MODEL_URL,
        scale,
        nativeRadiusM: MODEL_NATIVE_RADIUS_M,
        bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
        headingOffsetDeg: MODEL_HEADING_OFFSET_DEG,
        visualCenterNative: visualCenterForModel(JET_MODEL_URL),
        trailAnchorNative: trailAnchorForModel(JET_MODEL_URL),
      };
    }
    flightState._specCache.set(klass, spec);
    return spec;
  }

  function _normalBillboardScaleByDistance() {
    // Match commercial flights and preserve the established close-range 3×
    // default. Smaller owner-visible scaling must be proposed separately.
    return new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
  }

  function _cockpitBillboardScaleByDistance() {
    return new Cesium.NearFarScalar(1000, 1.15, 8000000, 0.65);
  }

  /** Fleet icon scale: per-class scale, ×GROUND_SCALE while grounded. */

  function _fleetBillboardScale(icao24) {
    const meta = flightState.records.data.get(icao24);
    return (
      BILLBOARD_SCALE *
      (CLASS_SCALE_2D[meta?.klass] || 1) *
      (meta?.onGround ? GROUND_SCALE : 1)
    );
  }

  /** Sprite kind for one contact's icon. Identity for every aircraft except
   *  the ones the operator converted into a TR-3B (Easter egg), which draw the
   *  black-triangle glyph — its thermal-reactive variant while an IR style owns
   *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
   *  conversion survive the poll reconciler and the two-tier raster swap. */

  const _iconKind = (icao24, klass) =>
    tr3bIconKind(icao24, klass, { hot: flightState._irBoost });

  /** Model tint, mirroring the billboard color rules (amber instead of cyan/white). */

  function _modelColor(icao24) {
    if (icao24 === flightState._trackedIcao) return TRACKED_ICON_COLOR;
    return _fleetBillboardColor(icao24);
  }

  /** Fleet (untracked) tint: red while the latest poll broadcast an emergency,
   *  amber otherwise. Cockpit far-contact dots use it too. */

  function _fleetBillboardColor(
    icao24,
    info = flightState.records.data.get(icao24),
  ) {
    return isEmergency(info?.emergency) ? EMERGENCY_ICON_COLOR : MIL_ICON_COLOR;
  }

  /** Cockpit far-contact pips wear the fleet tint. */

  const _cockpitContactColor = _fleetBillboardColor;

  /** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
   *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
   *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
   *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
   *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
   *  contact does not route through here: it is one model, it is what the camera is aimed at,
   *  and it takes its own default-on, hysteretic zoom regime
   *  (`_trackedModelRegimeActive`). Mirror of flights.js. */

  function _modelRegimeActive() {
    if (!flightState._models3dEnabled) return false;
    const h =
      flightState._viewer?.camera?.positionCartographic?.height ?? Infinity;
    return h < MODEL_ALT_CEIL_M;
  }

  /** Active model cap — the eligibility pre-pass AND _ensureModel's admission checks must use the
   *  SAME value, else 'all' (MODEL_MAX_ALL) marks planes eligible that _ensureModel refuses at the
   *  lower MODEL_MAX, silently degrading 'all' to 'proximity'. */

  function _modelCap() {
    const mapCap =
      flightState._models3dMode === 'all' ? MODEL_MAX_ALL : MODEL_MAX;
    // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget.
    return flightState._cockpitContactMode
      ? Math.min(COCKPIT_MODEL_MAX, mapCap)
      : mapCap;
  }

  /** Active ADD/KEEP radii (m) — mode-aware ('all' reaches ~to the horizon). Mirror of flights.js. */

  function _modelAddDistM() {
    return flightState._models3dMode === 'all'
      ? MODEL_ALL_ADD_M
      : MODEL_PROX_ADD_M;
  }

  function _modelKeepDistM() {
    return flightState._models3dMode === 'all'
      ? MODEL_ALL_KEEP_M
      : MODEL_PROX_KEEP_M;
  }

  /** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
   *  `result` (a shared scratch by default) and returns it. Push it with `setModel`, which copies
   *  it into Core's mirror and the model's own matrix, so models never share one mutable matrix
   *  object (see flights.js for the full rationale). */

  function _modelMatrix(
    pos,
    headingDeg,
    result = flightState._scratchModelMtx,
    offsetDeg = MODEL_HEADING_OFFSET_DEG,
  ) {
    flightState._scratchModelHpr.heading = Cesium.Math.toRadians(
      (headingDeg || 0) + offsetDeg,
    );
    flightState._scratchModelHpr.pitch = 0;
    flightState._scratchModelHpr.roll = 0;
    return Cesium.Transforms.headingPitchRollToFixedFrame(
      pos,
      flightState._scratchModelHpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      result,
    );
  }

  /** Everything scene.sampleHeight must NOT hit when snapping a grounded model (mirror of
   *  flights.js): the vertical pick ray at a plane's own lat/lon otherwise lands on its
   *  (or a parked neighbor's) icon/model instead of the tile skin. Exclusion matches
   *  picked-object IDs — every icon AND model here carries its icao as `id` — plus
   *  the tracked entity object itself. Built lazily, only when a sample actually fires. */

  function _groundSampleExclusions() {
    const out = parts.icons._iconIds();
    if (flightState._trackedEntity) out.push(flightState._trackedEntity);
    return out;
  }

  /** Position a 3D MODEL renders at (mirror of flights.js — see the full rationale there).
   *  Grounded planes ride a ONE-SHOT cached scene.sampleHeight of the photoreal tile skin
   *  (groundSnap.js; taxiing >50 m retires it to a bounded last-known) plus the belly
   *  offset so they sit on their
   *  gear; airborne planes pass through. Until the FIRST sample lands, callers keep the
   *  icon visible and the model hidden while this returns null; a
   *  contact that has already resolved once holds that measurement through a later
   *  outage inside groundSnap's drift bound, so taxiing does not pop it back to 2D. */

  function _modelDisplayPosition(icao24, pos, result) {
    const meta = flightState.records.data.get(icao24);
    if (!meta || !meta.onGround) return pos;
    const h = flightState._groundSnap.heightFor(
      flightState._viewer,
      icao24,
      pos,
      _groundSampleExclusions,
    );
    if (h == null) return null;
    const carto = Cesium.Cartographic.fromCartesian(
      pos,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchGroundCarto,
    );
    carto.height = h + _modelSpec(meta.klass).bellyM;
    return Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      carto.height,
      Cesium.Ellipsoid.WGS84,
      result,
    );
  }

  /** Atomically hand one fleet contact from its icon to a safely placed,
   * ready 3D model. Missing/loading models and unresolved terrain always leave
   * the icon owning the visual, so no render frame can hide both.
   * `beforeShow` runs only on the committing path — the per-tick model treatment
   * belongs to a model that is about to draw, not to one still waiting. */

  function _driveFleetModelHandoff(
    icao24,
    model,
    row,
    pos,
    course,
    beforeShow,
  ) {
    const icons = flightState._icons;
    if (!model) {
      icons.setShown(row, true);
      return false;
    }
    const displayPos = _modelDisplayPosition(
      icao24,
      pos,
      flightState._scratchGroundPos,
    );
    if (!displayPos) {
      setModel(model, 'show', false); // no ground evidence → nothing safe to place a depth-tested model at
      icons.setShown(row, true);
      return false;
    }
    // The matrix is written BEFORE the readiness test on purpose: a model can flip
    // `ready` during scene update after this tick, and a first rendered frame on a
    // stale load-start matrix is the one-frame jump this ordering prevents.
    setModel(
      model,
      'modelMatrix',
      _modelMatrix(
        displayPos,
        course,
        undefined,
        _modelSpec(flightState.records.data.get(icao24)?.klass)
          .headingOffsetDeg,
      ),
    );
    if (!model.ready) {
      setModel(model, 'show', false); // not loaded yet → keep the 2D icon, no half-model flash
      icons.setShown(row, true);
      return false;
    }
    beforeShow?.();
    if (!modelState(model).show) setModel(model, 'show', true);
    icons.setShown(row, false); // hand off ONLY once the model renders
    return true;
  }

  /** A model owns the visual only while it is ready, shown, and (for the tracked
   *  primitive) inside the tracked-model regime. Mere existence/loading is not ownership. */

  function _modelOwnsVisual(icao24) {
    if (icao24 === flightState._trackedIcao) {
      return (
        parts.tracking._trackedModelRegimeActive() &&
        _modelIsRendering(flightState._trackedModel)
      );
    }
    return _modelIsRendering(flightState._models.get(icao24));
  }

  /** `show` is sufficient evidence of a safe placement because only the handoff and
   *  the tracked driver ever set it true, and both do so after committing a matrix;
   *  everything else — admission, unresolved ground, an unready glTF, the limb cull,
   *  a regime exit — only ever clears it. Mirror of flights.js. */

  function _modelIsRendering(model) {
    return !!model && model.ready === true && modelState(model)?.show === true;
  }

  /** Spec identity for a LOADED model — mirror of flights.js: URL and scale
   *  together (same-URL classes differ by scale). */

  const _specKeyFor = (klass) => {
    const spec = _modelSpec(klass);
    return `${spec.url}@${spec.scale}`;
  };

  /** Class-change model sync — mirror of flights.js: drop a live model or
   *  in-flight load whose spec no longer matches the class, re-showing the
   *  fleet icon (on release, gap-proof) and covering the tracked standalone. */

  function _syncModelToClass(icao24) {
    const key = _specKeyFor(flightState.records.data.get(icao24)?.klass);
    const current = flightState._models.get(icao24);
    if (
      (current && aircraftVisuals.read(current)?.specKey !== key) ||
      (!current && flightState._modelPending.has(icao24))
    ) {
      _releaseModel(icao24);
    }
    if (
      icao24 === flightState._trackedIcao &&
      flightState._trackedModel &&
      aircraftVisuals.read(flightState._trackedModel)?.specKey !== key
    ) {
      _releaseTrackedModel();
    }
  }

  function _reloadModelsForIrBoost() {
    flightState._irReloadQueue = [...flightState._models.keys()];
    for (const icao of flightState._modelPending) {
      if (!flightState._models.has(icao))
        flightState._modelGen.set(
          icao,
          (flightState._modelGen.get(icao) || 0) + 1,
        );
    }
    _releaseTrackedModel();
  }

  function _drainIrReloadQueue() {
    if (!flightState._irReloadQueue) return;
    const batch = flightState._irReloadQueue.splice(0, IR_RELOAD_BATCH);
    for (const icao of batch) {
      const model = flightState._models.get(icao);
      if (
        !model ||
        aircraftVisuals.read(model)?.irBoost === flightState._irBoost
      )
        continue; // already right state
      _releaseModel(icao);
    }
    if (flightState._irReloadQueue.length === 0)
      flightState._irReloadQueue = null;
  }

  /** Lazily create the glTF model for an aircraft (fire-and-forget; its icon shows until ready). */

  async function _ensureModel(icao24) {
    // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
    // tick skips it, so a model here would be orphaned + double-rendered.
    if (icao24 === flightState._trackedIcao) return;
    if (
      flightState._models.has(icao24) ||
      flightState._modelPending.has(icao24)
    )
      return;
    // Count PENDING loads in the cap so a zoomed-in tick can't fire 100s of concurrent loads
    // (the cap is rechecked post-await too, before the add).
    if (
      flightState._models.size + flightState._modelPending.size >=
      _modelCap()
    )
      return;
    const epoch = flightState._modelEpoch; // lifecycle token: if destroy() bumps it, this load is dead
    const gen = flightState._modelGen.get(icao24) || 0; // capture; if it changes during the load, we're stale
    flightState._modelPending.add(icao24);
    let model = null;
    // Spec identity captured at load START (mirror of flights.js): a mid-load
    // reclassification makes the post-await admission reject the stale asset.
    // Boost state likewise — creation options bake it in.
    const specKey = _specKeyFor(flightState.records.data.get(icao24)?.klass);
    const loadIrBoost = flightState._irBoost;
    try {
      const spec = _modelSpec(flightState.records.data.get(icao24)?.klass);
      model = await Cesium.Model.fromGltfAsync({
        url: resolveAsset(spec.url),
        asynchronous: false,
        environmentMapOptions: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
        minimumPixelSize: MODEL_MIN_PX,
        scale: spec.scale,
        color: flightState._irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // near self-illuminated tint so planes read uniform near AND far; IR boost → flat UNLIT white (hot)
        colorBlendAmount: flightState._irBoost ? 1.0 : MODEL_COLOR_BLEND_AMOUNT,
        customShader: flightState._irBoost
          ? flightState._IR_UNLIT_SHADER
          : undefined,
        id: icao24, // so scene.pick returns the icao for click-to-track
      });
    } catch {
      // asset/decode fail — stay an icon. Only touch this lifecycle's state if still current
      // (a destroy/re-init may have swapped the globals while this load was in flight).
      if (epoch === flightState._modelEpoch) {
        flightState._modelPending.delete(icao24);
        _cleanupModelGen(icao24);
      }
      return;
    }
    // A load from a PREVIOUS lifecycle (destroy→init happened mid-load) must NOT mutate the new
    // epoch's _modelPending/_modelGen or add to the new collection — just drop its model.
    if (epoch !== flightState._modelEpoch) {
      try {
        model.destroy();
      } catch {
        /* gone */
      }
      return;
    }
    flightState._modelPending.delete(icao24);
    // Post-await admission: reject (and DESTROY the loaded model) if anything changed during the
    // load — a release bumped the generation (track/untrack/remove), the layer toggled off / was
    // torn down, the aircraft is gone or now tracked, a model already exists, or the cap filled.
    // Recheck the shared Display 3D toggle and altitude ceiling after the async
    // load. Cockpit uses the same OFF / Proximity / All contract as map Display.
    const stale =
      (flightState._modelGen.get(icao24) || 0) !== gen ||
      !_modelRegimeActive() ||
      !flightState._modelCollection ||
      flightState._modelCollection.isDestroyed() ||
      !flightState.records.data.has(icao24) ||
      icao24 === flightState._trackedIcao ||
      flightState._models.has(icao24) ||
      flightState._models.size >= _modelCap() ||
      // Class reclassified mid-load → this GLB/scale is for the OLD class.
      _specKeyFor(flightState.records.data.get(icao24)?.klass) !== specKey ||
      // IR boost flipped mid-load → this model baked the wrong shader/tint.
      flightState._irBoost !== loadIrBoost;
    if (stale) {
      try {
        model.destroy();
      } catch {
        /* already gone */
      }
      _cleanupModelGen(icao24); // bound the map
      return;
    }
    // Keep the pick identity explicit on the resolved primitive. This also
    // protects injected/custom loaders that do not copy the creation option.
    model.id = icao24;
    const visual = aircraftVisuals.write(model);
    visual.specKey = specKey; // class-change sync compares against this
    visual.irBoost = loadIrBoost; // boost-flip reload queue compares against this
    // Admitted, not yet the visual. Cesium's default is show=true, which would let
    // an unplaced primitive claim ownership from the icon for the frames
    // between admission and the next fleet tick (and draw at the identity matrix,
    // i.e. the Earth's centre). The handoff turns it on once it has a matrix.
    setModel(model, 'show', false);
    flightState._modelCollection.add(model);
    flightState._models.set(icao24, model);
    flightState._planeModelLoaded = true; // GLB is cached now — the tracked entity's model can fade in its billboard
  }

  /** Remove the 3D model for ONE aircraft (removal / track handoff).
   *  Bumps the load generation so any in-flight load for this icao is rejected on completion. */

  function _releaseModel(icao24) {
    const m = flightState._models.get(icao24);
    const pending = flightState._modelPending.has(icao24);
    // Only bump the generation when there's something to invalidate (an in-flight load or a
    // live model) — so removing never-modeled aircraft doesn't grow _modelGen.
    if (m || pending) {
      flightState._modelGen.set(
        icao24,
        (flightState._modelGen.get(icao24) || 0) + 1,
      );
    }
    if (m) {
      if (
        flightState._modelCollection &&
        !flightState._modelCollection.isDestroyed()
      ) {
        try {
          flightState._modelCollection.remove(m);
        } catch {
          /* gone */
        }
      }
      flightState._models.delete(icao24);
      _showReleasedIcon(icao24);
    }
    // Do NOT clear _modelPending here — the in-flight load's OWN post-await removes it. Keeping
    // it (a) prevents a duplicate load from starting and (b) keeps the bumped gen entry alive so
    // the resolving load's gen-check still rejects it.
    _cleanupModelGen(icao24);
  }

  /** Drop an icao's generation entry once nothing references it (no live model, no in-flight
   *  load) — keeps _modelGen bounded. Shared by _releaseModel + both _ensureModel exit paths. */

  function _cleanupModelGen(icao24) {
    if (
      !flightState._modelPending.has(icao24) &&
      !flightState._models.has(icao24)
    )
      flightState._modelGen.delete(icao24);
  }

  /** Remove all live models (toggle-off / zoom-out); icons take back over at once. */

  function _releaseModels() {
    flightState._irReloadQueue = null; // a full release supersedes any pending boost-flip drain
    // Invalidate in-flight loads so a completion after this bulk release can't add a model.
    for (const icao of flightState._modelPending)
      flightState._modelGen.set(
        icao,
        (flightState._modelGen.get(icao) || 0) + 1,
      );
    if (
      flightState._modelCollection &&
      !flightState._modelCollection.isDestroyed()
    ) {
      for (const m of flightState._models.values()) {
        try {
          flightState._modelCollection.remove(m);
        } catch {
          /* gone */
        }
      }
    }
    for (const icao24 of flightState._models.keys()) _showReleasedIcon(icao24);
    flightState._models.clear();
  }

  /** A released fleet model hands the visual straight back to its icon (the
   *  tracked contact's entity keeps its own). */

  function _showReleasedIcon(icao24) {
    const icons = flightState._icons;
    const row = icons?.row(icao24) ?? -1;
    if (row >= 0 && icao24 !== flightState._trackedIcao)
      icons.setShown(row, true);
  }

  /** Destroy the standalone tracked-aircraft model and invalidate any in-flight load. */

  function _releaseTrackedModel() {
    flightState._trackedModelGen++;
    flightState._trackedModelLoading = false;
    if (flightState._trackedModel) {
      if (
        flightState._modelCollection &&
        !flightState._modelCollection.isDestroyed()
      ) {
        try {
          flightState._modelCollection.remove(flightState._trackedModel);
        } catch {
          /* gone */
        }
      }
      flightState._trackedModel = null;
    }
  }

  /** Per-frame driver for the standalone tracked model (see flights.js for the rationale). The
   *  tracked entity stays a pure billboard, so the follow-camera never stalls/freezes on 3D-toggle. */

  function _updateTrackedModel() {
    const active =
      flightState._trackedIcao &&
      parts.tracking._trackedModelRegimeActive() &&
      flightState._modelCollection &&
      !flightState._modelCollection.isDestroyed();
    if (!active) {
      if (flightState._trackedModel)
        setModel(flightState._trackedModel, 'show', false);
      return;
    }
    // Ask the frame-cached source directly. If the entity callback already ran,
    // this is a no-op; if model loading completed between phases, it establishes
    // this frame's single sample before the model renders. Camera, detection, and
    // readout consumers then reuse that exact cached position.
    const pos =
      parts.motion._trackedDisplayPosition(flightState._trackedIcao) ||
      parts.icons._iconPosition(flightState._trackedIcao);
    if (!pos) {
      if (flightState._trackedModel)
        setModel(flightState._trackedModel, 'show', false);
      return;
    }
    if (
      !flightState._trackedModel &&
      !flightState._trackedModelLoading &&
      parts.tracking._trackedModelLoadAllowed()
    ) {
      flightState._trackedModelLoading = true;
      const gen = flightState._trackedModelGen;
      const trackedSpec = _modelSpec(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
      const trackedKey = _specKeyFor(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
      const trackedIrBoost = flightState._irBoost;
      Cesium.Model.fromGltfAsync({
        url: resolveAsset(trackedSpec.url),
        asynchronous: false,
        environmentMapOptions: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
        minimumPixelSize: TRACKED_MODEL_MIN_PX,
        scale: trackedSpec.scale,
        color: flightState._irBoost ? Cesium.Color.WHITE : TRACKED_ICON_COLOR,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // near self-illuminated tint so planes read uniform near AND far; IR boost → flat UNLIT white (hot)
        colorBlendAmount: flightState._irBoost ? 1.0 : MODEL_COLOR_BLEND_AMOUNT,
        customShader: flightState._irBoost
          ? flightState._IR_UNLIT_SHADER
          : undefined,
        // Pick id (H1): without it, clicking the very plane being tracked read as
        // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
        // deselect. With the icao, the click handler recognizes it as ours.
        id: flightState._trackedIcao,
      })
        .then((m) => {
          if (
            gen !== flightState._trackedModelGen ||
            !flightState._modelCollection ||
            flightState._modelCollection.isDestroyed()
          ) {
            try {
              m.destroy();
            } catch {
              /* gone */
            }
            return;
          }
          // Class reclassified OR boost flipped mid-load (no release ran —
          // _trackedModel was still null): drop the stale asset; driver reloads.
          if (
            _specKeyFor(
              flightState.records.data.get(flightState._trackedIcao)?.klass,
            ) !== trackedKey ||
            flightState._irBoost !== trackedIrBoost
          ) {
            try {
              m.destroy();
            } catch {
              /* gone */
            }
            flightState._trackedModelLoading = false;
            return;
          }
          // Assign after resolution as well as in the creation options so the
          // standalone primitive always exposes the tracked aircraft pick id.
          m.id = flightState._trackedIcao;
          aircraftVisuals.write(m).specKey = trackedKey; // class-change sync compares against this
          setModel(m, 'show', false); // admitted, not yet the visual — the driver shows it once placed
          // Seed the world transform before the primitive enters the scene. A model
          // can become ready+shown between render phases; leaving Cesium's identity
          // default here produces a one-frame jump to the Earth's center.
          const currentPos =
            parts.motion._trackedDisplayCached() ||
            parts.icons._iconPosition(flightState._trackedIcao);
          if (currentPos) {
            const displayPos = _modelDisplayPosition(
              flightState._trackedIcao,
              currentPos,
              flightState._scratchGroundPos,
            );
            if (displayPos) {
              setModel(
                m,
                'modelMatrix',
                _modelMatrix(
                  displayPos,
                  parts.motion._trackedDisplayCourse(),
                  undefined,
                  trackedSpec.headingOffsetDeg,
                ),
              );
            }
          }
          flightState._trackedModel = m;
          flightState._trackedModelLoading = false;
          // A good load retires this selection's failure budget — a contact that
          // recovers after a transient blip is not one attempt from giving up.
          flightState._trackedModelFailIcao = null;
          flightState._trackedModelFailCount = 0;
          flightState._trackedModelRetryAtMs = 0;
          flightState._modelCollection.add(m);
          flightState._planeModelLoaded = true;
        })
        .catch((err) => {
          if (gen !== flightState._trackedModelGen) return; // superseded load — not this selection's failure
          flightState._trackedModelLoading = false;
          parts.tracking._noteTrackedModelLoadFailure(trackedSpec.url, err);
        });
      return;
    }
    if (flightState._trackedModel) {
      // Keep the transform current while GPU resources are still loading. Cesium
      // can flip ready during scene update after this callback; waiting for ready
      // here would let that first rendered frame use a stale load-start matrix.
      const displayPos = _modelDisplayPosition(
        flightState._trackedIcao,
        pos,
        flightState._scratchGroundPos,
      );
      if (!displayPos) {
        setModel(flightState._trackedModel, 'show', false); // no ground evidence → the billboard carries it
        return;
      }
      const spec = _modelSpec(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
      setModel(
        flightState._trackedModel,
        'modelMatrix',
        _modelMatrix(
          displayPos,
          parts.motion._trackedDisplayCourse(),
          undefined,
          spec.headingOffsetDeg,
        ),
      );
      if (!flightState._trackedModel.ready) return;
      flightState._trackedModel.scale = trackedModelScaleForPixelCap({
        baseScale: spec.scale,
        nativeRadiusM: spec.nativeRadiusM,
        rangeM: Cesium.Cartesian3.distance(
          flightState._viewer.camera.positionWC,
          displayPos,
        ),
        viewportHeightPx: flightState._viewer.scene.canvas.clientHeight,
        fovyRad: flightState._viewer.camera.frustum.fovy,
        maximumPixelSize: TRACKED_MODEL_MAX_PX,
      });
      setModel(flightState._trackedModel, 'show', true);
    }
  }

  /**
   * ~12 Hz fleet pass. Motion, rotation, the horizon cull, limb recession and
   * the two-tier glyph swap all run on the GPU from each row's segment, so this
   * only re-plans rows whose regime ended, advances focus de-emphasis while a
   * target exists, and drives the 3D-model handoff inside the model regime.
   * Driven by scene.preRender.
   * @returns {void}
   */

  function _fleetTick() {
    const icons = flightState._icons;
    if (!flightState._viewer || !icons || !icons.show) return;
    const scene = flightState._viewer.scene;
    const camera = flightState._viewer.camera;
    const nowMs = focusNowMs(Date.now());

    if (nowMs - flightState._lastFleetTickMs < FLEET_DR_INTERVAL_MS) return;
    flightState._lastFleetTickMs = nowMs;
    // Every contact in this pass shares the same delayed display instant.
    const renderTime = parts.icons._displayTime(
      flightState._scratchFleetRenderTime,
    );
    const tau = icons.seconds(renderTime);

    _drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
    if (flightState._cockpitContactMode)
      parts.tracking._refreshCockpitNearContacts();
    parts.icons._replanExpired(tau);
    const focusTarget = getFocusTarget();
    parts.icons._focusIcons(tau, scene, camera, nowMs, focusTarget);

    // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
    // Drop all models the moment we leave it (toggled off / zoomed out) so icons resume.
    const useModels = _modelRegimeActive();
    // Drop live models AND invalidate in-flight loads on leaving the regime (else a load that
    // resolves after zoom-out could briefly add a model outside the 3D-model regime).
    if (
      !useModels &&
      (flightState._models.size || flightState._modelPending.size)
    )
      _releaseModels();
    if (!useModels) return;

    // 3D-model eligibility: by DISTANCE (the mode's add/keep band), with ON-SCREEN PRIORITY under the
    // cap. FOUR passes, visible-first, so the slots are spent on what you can see: (1) KEEP on-screen
    // already-modeled (hysteresis for visible planes); (2) ADD on-screen new inside the add radius,
    // nearest first; (3) KEEP off-screen already-modeled; (4) ADD off-screen new with leftover slots
    // (so a plane just off the cone still models — the "planes right next to me aren't 3D" complaint).
    // Crucially KEEP is SPLIT by frustum: an off-screen retained model (pass 3) can never starve an
    // on-screen plane that wants one (passes 1–2) — a single KEEP-everything pass could fill the cap
    // with off-screen retained models. Pure-distance let off-screen planes eat the cap; pure-frustum
    // filtering dropped near off-screen planes entirely. This does both right.
    const cap = _modelCap();
    const camPos = camera.positionWC;
    const addM = _modelAddDistM();
    const addDistSq = addM * addM;
    const keepM = _modelKeepDistM();
    const keepDistSq = keepM * keepM;
    const cull = camera.frustum.computeCullingVolume(
      camPos,
      camera.directionWC,
      camera.upWC,
    );
    // Candidates = planes within the KEEP radius, nearest first, each tagged with on-screen-ness.
    const cand = [];
    for (let row = 0; row < icons.count; row++) {
      const icao = icons.idAt(row);
      if (icao === flightState._trackedIcao) continue;
      // A converted TR-3B renders as an icon and can never take a model, so
      // it must not occupy a CAP SLOT either — excluded here at selection time,
      // not just at the handoff below, or accumulated conversions would starve
      // ordinary contacts of 3D models. (The handoff guard stays as defence.)
      if (isTr3b(icao)) continue;
      // Ground planes compete for model slots like everyone else (owner decision
      // 2026-07-03: "3D mode is respected regardless of whether a plane is on the
      // ground or in the air — no distinction"). The cap + nearest-first ordering
      // below already bound airport clusters; grounded placement is handled by the
      // one-shot ground snap in _modelDisplayPosition.
      const position = icons.position(
        row,
        tau,
        flightState._scratchModelBS.center,
      );
      const d2 = Cesium.Cartesian3.distanceSquared(camPos, position);
      if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
      cand.push([
        icao,
        d2,
        cull.computeVisibility(flightState._scratchModelBS) !==
          Cesium.Intersect.OUTSIDE,
      ]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first
    if (cand.length > cap && nowMs - flightState._lastModelCapWarnMs > 5000) {
      console.warn(
        `[Data:Military] ${cand.length} planes in 3D range; capped at ${cap} (${flightState._models3dMode}). On-screen planes are prioritized.`,
      );
      flightState._lastModelCapWarnMs = nowMs;
    }
    const modelEligible = selectModelEligible(cand, {
      cap,
      addDistSq,
      isModeled: (icao) => flightState._models.has(icao),
    });
    const toRelease = [];
    for (const icao of flightState._models.keys()) {
      if (icao !== flightState._trackedIcao && !modelEligible.has(icao))
        toRelease.push(icao);
    }
    for (const icao of toRelease) _releaseModel(icao);

    // 3D model takes over from the icon for eligible planes. GAP-PROOF: the icon stays shown
    // until the model is actually READY to render, so a plane is never both iconless AND
    // modelless (the "planes vanish when 3D turns on" bug). Position the model every tick
    // regardless so it's framed the instant it becomes ready. Converted TR-3Bs stay 2D on
    // purpose: the Easter egg IS the triangle, and there is no GLB for it.
    const occluder = horizonOccluder(camera);
    for (const icao24 of modelEligible) {
      if (isTr3b(icao24)) continue;
      const row = icons.row(icao24);
      if (row < 0) continue;
      const position = icons.position(row, tau, flightState._scratchFleetPos);
      if (!parts.icons._aboveHorizon(row, position, occluder)) {
        // A model that crossed the limb would keep rendering through the
        // hidden globe at its last matrix; the icon's own cull is on the GPU.
        const m = flightState._models.get(icao24);
        if (m && modelState(m)?.show) setModel(m, 'show', false);
        continue;
      }
      _ensureModel(icao24);
      const model = flightState._models.get(icao24);
      const cameraDistanceM = Cesium.Cartesian3.distance(camPos, position);
      _driveFleetModelHandoff(
        icao24,
        model,
        row,
        position,
        icons.course(row, tau),
        () => {
          applyAircraftModelTreatment({
            model,
            // IR boost must survive the per-tick treatment write — otherwise
            // any alpha change would repaint the ordinary tint over the hot
            // white. Boosted models also skip the recession fade: hot targets
            // stay full-strength at any range (icons keep their normal
            // fade — full-opacity glyph walls read as overwhelming).
            baseColor: flightState._irBoost
              ? Cesium.Color.WHITE
              : _modelColor(icao24),
            alpha: flightState._irBoost
              ? 1
              : aircraftTreatmentAlpha({
                  baseAlpha: icons.alpha(row),
                  focusFactor: icons.focus(row),
                  cameraDistanceM,
                  cameraHeightM: camera.positionCartographic?.height,
                }),
          });
        },
      );
    }
  }
  return {
    _modelSpec,
    _normalBillboardScaleByDistance,
    _cockpitBillboardScaleByDistance,
    _fleetBillboardScale,
    _cockpitContactColor,
    _iconKind,
    _modelColor,
    _fleetBillboardColor,
    _modelRegimeActive,
    _modelCap,
    _modelAddDistM,
    _modelKeepDistM,
    _modelMatrix,
    _groundSampleExclusions,
    _modelDisplayPosition,
    _driveFleetModelHandoff,
    _modelOwnsVisual,
    _modelIsRendering,
    _specKeyFor,
    _syncModelToClass,
    _reloadModelsForIrBoost,
    _drainIrReloadQueue,
    _ensureModel,
    _releaseModel,
    _cleanupModelGen,
    _releaseModels,
    _releaseTrackedModel,
    _updateTrackedModel,
    _fleetTick,
  };
}
