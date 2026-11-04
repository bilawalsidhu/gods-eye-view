import * as Cesium from 'cesium';
import { selectModelEligible } from './modelEligibility.js';
import { horizonOccluder } from './iconOrientation.js';
import { aircraftTreatmentAlpha } from './aircraftRecession.js';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';
import {
  createModelRecord,
  modelIsRendering,
  placeModel,
  showModel,
} from './modelRecord.js';

/**
 * An aircraft layer's 3D models: the fleet regime and its gap-proof handoff
 * from the icon set (`createAircraftIcons`), the standalone tracked model, and
 * the ~12 Hz fleet tick that drives both. Shared by the flights and military
 * layers, which differ only in the options below.
 * @param {object} options
 * @param {object} options.state The layer state.
 * @param {object} options.services
 * @param {object} options.parts The layer's parts; `icons`, `motion` and
 *   `tracking` are read at call time.
 * @param {(url: string) => string} options.resolveAsset
 * @param {string} options.logLabel Console prefix, e.g. `Data:Flights`.
 * @param {object} options.policy The layer's model budgets, radii, pixel
 *   bounds, heading offset, IR reload batch and fleet tick interval.
 * @param {(klass: string) => object} options.modelSpec The class's GLB, scale,
 *   geometry and tint blend; `headingOffsetDeg` overrides the policy's.
 * @param {(icao24: string) => Cesium.Color} options.modelColor Model tint,
 *   including the tracked contact's.
 * @param {(icao24: string) => void} [options.onModelEligible] Runs when a
 *   contact is about to render in 3D.
 * @param {(renderTime: Cesium.JulianDate, tau: number, nowMs: number,
 *   camera: Cesium.Camera) => void} [options.afterReplan] The layer's own pass
 *   in the fleet tick, after expired rows are re-planned.
 */
export function createAircraftModels({
  state,
  services,
  parts,
  resolveAsset,
  logLabel,
  policy,
  modelSpec: _modelSpec,
  modelColor: _modelColor,
  onModelEligible = () => {},
  afterReplan = () => {},
}) {
  const { isTr3b } = services.aircraftPresentation;
  const { trackedModelScaleForPixelCap } = services.camera;
  const { focusNowMs, getFocusTarget } = services.focus;
  const { applyAircraftModelTreatment } = services.recession;

  /** The model heading offset a class's GLB needs. */
  const _headingOffsetDeg = (klass) =>
    _modelSpec(klass).headingOffsetDeg ?? policy.MODEL_HEADING_OFFSET_DEG;

  /** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
   *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
   *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
   *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
   *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
   *  contact does not route through here: it is one model, it is what the camera is aimed at,
   *  and it takes its own default-on, hysteretic zoom regime
   *  (`_trackedModelRegimeActive`). */

  function _modelRegimeActive() {
    if (!state._models3dEnabled) return false;
    const h = state._viewer?.camera?.positionCartographic?.height ?? Infinity;
    return h < policy.MODEL_ALT_CEIL_M;
  }

  /** Active model cap — the eligibility pre-pass AND _ensureModel's admission checks must use the
   *  SAME value, else 'all' (MODEL_MAX_ALL) would mark planes eligible that _ensureModel then refuses
   *  at the lower MODEL_MAX, silently degrading 'all' to 'proximity'. */

  function _modelCap() {
    const mapCap =
      state._models3dMode === 'all' ? policy.MODEL_MAX_ALL : policy.MODEL_MAX;
    // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget. Cockpit is
    // already the heaviest mode (20 Hz camera setView ahead of scene update, photoreal
    // retraversal, the cloud pass) and every model is its own draw call.
    return state._cockpitContactMode
      ? Math.min(policy.COCKPIT_MODEL_MAX, mapCap)
      : mapCap;
  }

  /** Active ADD radius (m) — new planes inside this range get a model. Mode-aware: 'all' reaches far. */

  function _modelAddDistM() {
    return state._models3dMode === 'all'
      ? policy.MODEL_ALL_ADD_M
      : policy.MODEL_PROX_ADD_M;
  }

  /** Active KEEP radius (m) — a modeled plane keeps its model out to here (hysteresis vs ADD). */

  function _modelKeepDistM() {
    return state._models3dMode === 'all'
      ? policy.MODEL_ALL_KEEP_M
      : policy.MODEL_PROX_KEEP_M;
  }

  /** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
   *  `result` (a shared scratch by default) and returns it. Push it with `placeModel`, which copies
   *  it into the model's record and its own matrix, so models never share one mutable matrix
   *  object. `Model.modelMatrix` is a plain field (not a cloning setter); Cesium
   *  clones it per frame in updateModelMatrix(). Sharing a single scratch made every model render at
   *  the LAST-written transform — all stacked on one plane — and, once the tracked model wrote the
   *  scratch every frame, the stack point oscillated frame-to-frame: the "flickering like mad" bug. */

  function _modelMatrix(
    pos,
    headingDeg,
    result = state._scratchModelMtx,
    offsetDeg = policy.MODEL_HEADING_OFFSET_DEG,
  ) {
    state._scratchModelHpr.heading = Cesium.Math.toRadians(
      (headingDeg || 0) + offsetDeg,
    );
    state._scratchModelHpr.pitch = 0;
    state._scratchModelHpr.roll = 0;
    return Cesium.Transforms.headingPitchRollToFixedFrame(
      pos,
      state._scratchModelHpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      result,
    );
  }

  /** Everything scene.sampleHeight must NOT hit when snapping a grounded model: the
   *  vertical pick ray at a plane's own lat/lon otherwise lands on its (or a parked
   *  neighbor's) billboard/model instead of the tile skin. Cesium's ray-pick exclusion
   *  matches picked-object IDs, and every icon AND model in this layer carries its
   *  icao as `id`, so the icao strings cover both; the tracked entity is excluded as the
   *  object itself. Built lazily — only when a sample actually fires (one-shot). */

  function _groundSampleExclusions() {
    const out = parts.icons._iconIds();
    if (state._trackedEntity) out.push(state._trackedEntity);
    return out;
  }

  /** Position a 3D MODEL renders at. Airborne planes use their dead-reckoned position
   *  verbatim. GROUNDED planes' meta altitude is last-known baro or 0 m — nowhere near
   *  the photoreal tile skin in ellipsoid heights (buried ~100+ m at inland airports,
   *  hovering ~30 m at sea-level ones), and unlike the ground billboards a depth-tested
   *  model can't hide behind disableDepthTestDistance. So a modeled grounded plane rides
   *  a ONE-SHOT cached scene.sampleHeight of the skin at its lat/lon (groundSnap.js,
   *  CCTV-B9b discipline: never per-frame; taxiing >50 m retires the cached value to a
   *  bounded last-known and resamples), plus
   *  the belly offset so it sits on its gear rather than sinking to the model-origin
   *  fuselage centerline. Until the FIRST sample lands (tiles streaming / sample miss)
   *  there is no safe depth-tested placement at all: this returns null, the caller
   *  keeps the 2D billboard visible and the model hidden, and it retries later. Once
   *  a contact has resolved once, a later outage holds that measurement inside
   *  groundSnap's drift bound instead — a taxiing aircraft does not pop back to 2D
   *  because a resample is mid-backoff. */

  function _modelDisplayPosition(icao24, pos, result) {
    const meta = state.records.data.get(icao24);
    if (!meta || !meta.onGround) return pos;
    const h = state._groundSnap.heightFor(
      state._viewer,
      icao24,
      pos,
      _groundSampleExclusions,
    );
    if (h == null) return null;
    const carto = Cesium.Cartographic.fromCartesian(
      pos,
      Cesium.Ellipsoid.WGS84,
      state._scratchGroundCarto,
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
    record,
    row,
    pos,
    course,
    beforeShow,
  ) {
    const icons = state._icons;
    if (!record) {
      icons.setShown(row, true);
      return false;
    }
    const displayPos = _modelDisplayPosition(
      icao24,
      pos,
      state._scratchGroundPos,
    );
    if (!displayPos) {
      showModel(record, false); // no ground evidence → nothing safe to place a depth-tested model at
      icons.setShown(row, true);
      return false;
    }
    // The matrix is written BEFORE the readiness test on purpose: a model can flip
    // `ready` during scene update after this tick, and a first rendered frame on a
    // stale load-start matrix is the one-frame jump this ordering prevents.
    placeModel(
      record,
      _modelMatrix(
        displayPos,
        course,
        undefined,
        _headingOffsetDeg(state.records.data.get(icao24)?.klass),
      ),
    );
    if (!record.model.ready) {
      showModel(record, false); // not loaded yet → keep the 2D icon, no half-model flash
      icons.setShown(row, true);
      return false;
    }
    beforeShow?.();
    if (!record.show) showModel(record, true);
    icons.setShown(row, false); // hand off ONLY once the model renders
    return true;
  }

  /**
   * Whether a 3D model — not the billboard — is what the user actually SEES for
   * this contact, and therefore whether the display floor should stand aside.
   *
   * Model EXISTENCE is not ownership. A fleet model that is still loading, or has
   * no resolved ground to stand on, stays hidden while `bb.show` stays true (the
   * gap-proof handoff: "hand off ONLY once the model renders"), and a tracked model
   * is retained but hidden whenever the model regime is off — 3D disabled, camera
   * zoomed past the ceiling, or cockpit mode. Gating on `has()`/existence therefore
   * suppressed the clamp in exactly the states where the BILLBOARD is the visual,
   * putting the burial straight back.
   *
   * Cesium's own default `show === true` is the reason admission clears it
   * explicitly: a fleet model registered in `_models` the instant its glTF resolves
   * would otherwise claim ownership — at the identity matrix — for the frames
   * between admission and the next fleet tick, while the BILLBOARD was still the
   * visual. Ownership means actually rendering, and every site that sets `show`
   * true does so only after committing a matrix.
   *
   * The two halves:
   *  - Fleet: the rendering test alone. Safe for the ground snap either way,
   *    because a fleet model is positioned from the RAW dead-reckon, not from
   *    the billboard.
   *  - Tracked: the rendering test AND `_trackedModelRegimeActive()`. The tracked
   *    model is fed from `_trackedDisplayPosition`, so once it is live the clamp
   *    must stand aside: two different chains would otherwise be deciding one
   *    contact's ground, and the billboard's is the one the operator is not
   *    looking at (T7). The regime check is what makes a regime
   *    flip take effect on the same frame rather than waiting for
   *    `_updateTrackedModel` to clear `show`; the rendering test is what keeps a
   *    null or still-loading tracked model from claiming a visual it is not
   *    drawing yet.
   * @param {string} icao24
   * @param {import('./modelRecord.js').ModelRecord|null} [record] Resolved
   *   fleet model record; null means absent.
   * @returns {boolean}
   */

  function _modelOwnsVisual(icao24, record) {
    if (icao24 === state._trackedIcao) {
      return (
        parts.tracking._trackedModelRegimeActive() &&
        modelIsRendering(state._trackedModel)
      );
    }
    return modelIsRendering(
      record === undefined ? state._models.get(icao24) : record,
    );
  }

  // A model is the visual only once it actually draws, loaded AND shown
  // (`modelIsRendering`). `show` is sufficient evidence of a safe placement
  // because only ONE site ever sets it true for a fleet model
  // (`_driveFleetModelHandoff`, after the matrix is committed) and one for the
  // tracked model (`_updateTrackedModel`, likewise); everything else —
  // admission, an unresolved ground, a not-yet-ready glTF, the limb cull, a
  // regime exit — only ever clears it.

  /** Spec identity for a LOADED model: URL and scale together (same-URL classes
   *  differ by scale — airliner vs quadjet both ship airplane.glb). */

  const _specKeyFor = (klass) => {
    const spec = _modelSpec(klass);
    return `${spec.url}@${spec.scale}`;
  };

  /** Class-change model sync (enrichment AND poll-path klass updates): when the
   *  aircraft's live model or in-flight load no longer matches its class's spec,
   *  drop it so the eligibility pass reloads the right asset at the right scale.
   *  Gap-proof: the fleet billboard is re-shown BEFORE the release so the
   *  contact never goes invisible for the tick gap; _releaseModel's generation
   *  bump also invalidates any pending load. The tracked standalone model gets
   *  the same rule (its billboard entity is always the fallback visual). */

  function _syncModelToClass(icao24) {
    const key = _specKeyFor(state.records.data.get(icao24)?.klass);
    const current = state._models.get(icao24);
    if (
      (current && current.specKey !== key) ||
      (!current && state._modelPending.has(icao24))
    ) {
      _releaseModel(icao24);
    }
    if (
      icao24 === state._trackedIcao &&
      state._trackedModel &&
      state._trackedModel.specKey !== key
    ) {
      _releaseTrackedModel();
    }
  }

  function _reloadModelsForIrBoost() {
    state._irReloadQueue = [...state._models.keys()];
    for (const icao of state._modelPending) {
      if (!state._models.has(icao))
        state._modelGen.set(icao, (state._modelGen.get(icao) || 0) + 1);
    }
    _releaseTrackedModel();
  }

  function _drainIrReloadQueue() {
    if (!state._irReloadQueue) return;
    const batch = state._irReloadQueue.splice(0, policy.IR_RELOAD_BATCH);
    for (const icao of batch) {
      const record = state._models.get(icao);
      if (!record || record.irBoost === state._irBoost) continue; // already right state
      _releaseModel(icao);
    }
    if (state._irReloadQueue.length === 0) state._irReloadQueue = null;
  }

  /** Lazily create the glTF model for an aircraft (fire-and-forget; billboard shows until ready). */

  async function _ensureModel(icao24) {
    // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
    // tick skips it, so a model here would be orphaned + double-rendered.
    if (icao24 === state._trackedIcao) return;
    onModelEligible(icao24);
    if (state._models.has(icao24) || state._modelPending.has(icao24)) return;
    // Count PENDING loads in the cap so a zoomed-in tick can't fire 100s of concurrent loads
    // (the cap is rechecked post-await too, before the add). Mode-aware so 'all' can reach MAX_ALL.
    if (state._models.size + state._modelPending.size >= _modelCap()) return;
    const epoch = state._modelEpoch; // lifecycle token: if destroy() bumps it, this load is dead
    const gen = state._modelGen.get(icao24) || 0; // capture; if it changes during the load, we're stale
    state._modelPending.add(icao24);
    let model = null;
    // Spec identity captured at load START — if enrichment reclassifies the
    // aircraft mid-load, the post-await admission below rejects the stale asset.
    // Boost state likewise: the creation options bake it in, so a mid-load
    // toggle must reject too (the reload queue only covers ADMITTED models).
    const specKey = _specKeyFor(state.records.data.get(icao24)?.klass);
    const loadIrBoost = state._irBoost;
    try {
      const spec = _modelSpec(state.records.data.get(icao24)?.klass);
      model = await Cesium.Model.fromGltfAsync({
        url: resolveAsset(spec.url),
        asynchronous: false,
        environmentMapOptions: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
        minimumPixelSize: policy.MODEL_MIN_PX,
        scale: spec.scale,
        color: state._irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // Launch presentation keeps the code-side tint dominant for every approved
        // model; IR boost removes the remaining diffuse hint with flat UNLIT white.
        colorBlendAmount: state._irBoost ? 1.0 : spec.blendAmount,
        customShader: state._irBoost ? state._IR_UNLIT_SHADER : undefined,
        id: icao24, // so scene.pick returns the icao for click-to-track
      });
    } catch {
      // asset/decode fail — stay an icon. Only touch this lifecycle's state if still current
      // (a destroy/re-init may have swapped the globals while this load was in flight).
      if (epoch === state._modelEpoch) {
        state._modelPending.delete(icao24);
        _cleanupModelGen(icao24);
      }
      return;
    }
    // A load from a PREVIOUS lifecycle (destroy→init happened mid-load) must NOT mutate the new
    // epoch's _modelPending/_modelGen or add to the new collection — just drop its model.
    if (epoch !== state._modelEpoch) {
      try {
        model.destroy();
      } catch {
        /* gone */
      }
      return;
    }
    state._modelPending.delete(icao24);
    // Post-await admission: reject (and DESTROY the loaded model) if anything changed during the
    // load — a release bumped the generation (track/untrack/remove), the layer toggled off / was
    // torn down, the aircraft is gone or now tracked, a model already exists, or the cap filled.
    // Recheck the shared Display 3D toggle and altitude ceiling after the async
    // load. Cockpit uses the same OFF / Proximity / All contract as map Display.
    const stale =
      (state._modelGen.get(icao24) || 0) !== gen ||
      !_modelRegimeActive() ||
      !state._modelCollection ||
      state._modelCollection.isDestroyed() ||
      !state.records.data.has(icao24) ||
      icao24 === state._trackedIcao ||
      state._models.has(icao24) ||
      state._models.size >= _modelCap() ||
      // Class reclassified mid-load → this GLB/scale is for the OLD class.
      _specKeyFor(state.records.data.get(icao24)?.klass) !== specKey ||
      // IR boost flipped mid-load → this model baked the wrong shader/tint.
      state._irBoost !== loadIrBoost;
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
    const record = createModelRecord(model, {
      specKey, // class-change sync compares against this
      irBoost: loadIrBoost, // boost-flip reload queue compares against this
    });
    // Admitted, not yet the visual. Cesium's default is show=true, which would let
    // an unplaced primitive claim ownership from the icon for the frames
    // between admission and the next fleet tick (and draw at the identity matrix,
    // i.e. the Earth's centre). The handoff turns it on once it has a matrix.
    showModel(record, false);
    state._modelCollection.add(model);
    state._models.set(icao24, record);
    state._planeModelLoaded = true; // GLB is cached now — the tracked entity's model can fade in its billboard
  }

  /** Remove the 3D model for ONE aircraft (removal / military-suppression / track handoff).
   *  Bumps the load generation so any in-flight load for this icao is rejected on completion. */

  function _releaseModel(icao24) {
    const record = state._models.get(icao24);
    const pending = state._modelPending.has(icao24);
    // Only bump the generation when there's something to invalidate (an in-flight load or a
    // live model) — so removing never-modeled aircraft doesn't grow _modelGen.
    if (record || pending) {
      state._modelGen.set(icao24, (state._modelGen.get(icao24) || 0) + 1);
    }
    if (record) {
      if (state._modelCollection && !state._modelCollection.isDestroyed()) {
        try {
          state._modelCollection.remove(record.model);
        } catch {
          /* gone */
        }
      }
      state._models.delete(icao24);
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
    if (!state._modelPending.has(icao24) && !state._models.has(icao24))
      state._modelGen.delete(icao24);
  }

  /** Remove all live models (toggle-off / zoom-out); billboards take back over next tick. */

  function _releaseModels() {
    state._irReloadQueue = null; // a full release supersedes any pending boost-flip drain
    // Invalidate in-flight loads so a completion after this bulk release can't add a model.
    for (const icao of state._modelPending)
      state._modelGen.set(icao, (state._modelGen.get(icao) || 0) + 1);
    if (state._modelCollection && !state._modelCollection.isDestroyed()) {
      for (const record of state._models.values()) {
        try {
          state._modelCollection.remove(record.model);
        } catch {
          /* gone */
        }
      }
    }
    for (const icao24 of state._models.keys()) _showReleasedIcon(icao24);
    state._models.clear();
  }

  /** A released fleet model hands the visual straight back to its icon (the
   *  tracked contact's entity keeps its own). */

  function _showReleasedIcon(icao24) {
    const icons = state._icons;
    const row = icons?.row(icao24) ?? -1;
    if (row >= 0 && icao24 !== state._trackedIcao) icons.setShown(row, true);
  }

  /** Destroy the standalone tracked-aircraft model and invalidate any in-flight load. */

  function _releaseTrackedModel() {
    state._trackedModelGen++;
    state._trackedModelLoading = false;
    if (state._trackedModel) {
      if (state._modelCollection && !state._modelCollection.isDestroyed()) {
        try {
          state._modelCollection.remove(state._trackedModel.model);
        } catch {
          /* gone */
        }
      }
      state._trackedModel = null;
    }
  }

  /** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
   *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
   *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
   *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode). */

  function _updateTrackedModel() {
    const active =
      state._trackedIcao &&
      parts.tracking._trackedModelRegimeActive() &&
      state._modelCollection &&
      !state._modelCollection.isDestroyed();
    if (!active) {
      if (state._trackedModel) showModel(state._trackedModel, false);
      return;
    }
    // Ask the frame-cached source directly. If the entity callback already ran,
    // this is a no-op; if model loading completed between phases, it establishes
    // this frame's single sample before the model renders. Camera, detection, and
    // readout consumers then reuse that exact cached position.
    const pos =
      parts.motion._trackedDisplayPosition(state._trackedIcao) ||
      parts.icons._iconPosition(state._trackedIcao);
    if (!pos) {
      if (state._trackedModel) showModel(state._trackedModel, false);
      return;
    }
    if (
      !state._trackedModel &&
      !state._trackedModelLoading &&
      parts.tracking._trackedModelLoadAllowed()
    ) {
      state._trackedModelLoading = true;
      const gen = state._trackedModelGen;
      const trackedSpec = _modelSpec(
        state.records.data.get(state._trackedIcao)?.klass,
      );
      const trackedKey = _specKeyFor(
        state.records.data.get(state._trackedIcao)?.klass,
      );
      const trackedIrBoost = state._irBoost;
      Cesium.Model.fromGltfAsync({
        url: resolveAsset(trackedSpec.url),
        asynchronous: false,
        environmentMapOptions: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
        minimumPixelSize: policy.TRACKED_MODEL_MIN_PX,
        scale: trackedSpec.scale,
        color: state._irBoost
          ? Cesium.Color.WHITE
          : _modelColor(state._trackedIcao),
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // The tracked aircraft uses the same dominant light tint as the fleet;
        // IR boost removes the remaining diffuse hint with flat UNLIT white.
        colorBlendAmount: state._irBoost ? 1.0 : trackedSpec.blendAmount,
        customShader: state._irBoost ? state._IR_UNLIT_SHADER : undefined,
        // Pick id (H1): without it, clicking the very plane being tracked read as
        // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
        // deselect. With the icao, the click handler recognizes it as ours.
        id: state._trackedIcao,
      })
        .then((m) => {
          // Untracked / re-tracked / torn down during the load → drop it.
          if (
            gen !== state._trackedModelGen ||
            !state._modelCollection ||
            state._modelCollection.isDestroyed()
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
            _specKeyFor(state.records.data.get(state._trackedIcao)?.klass) !==
              trackedKey ||
            state._irBoost !== trackedIrBoost
          ) {
            try {
              m.destroy();
            } catch {
              /* gone */
            }
            state._trackedModelLoading = false;
            return;
          }
          // Assign after resolution as well as in the creation options so the
          // standalone primitive always exposes the tracked aircraft pick id.
          m.id = state._trackedIcao;
          const record = createModelRecord(m, {
            specKey: trackedKey, // class-change sync compares against this
            irBoost: trackedIrBoost,
          });
          showModel(record, false); // admitted, not yet the visual — the driver shows it once placed
          // Seed the world transform before the primitive enters the scene. A model
          // can become ready+shown between render phases; leaving Cesium's identity
          // default here produces a one-frame jump to the Earth's center.
          const currentPos =
            parts.motion._trackedDisplayCached() ||
            parts.icons._iconPosition(state._trackedIcao);
          if (currentPos) {
            const displayPos = _modelDisplayPosition(
              state._trackedIcao,
              currentPos,
              state._scratchGroundPos,
            );
            if (displayPos)
              placeModel(
                record,
                _modelMatrix(
                  displayPos,
                  parts.motion._trackedDisplayCourse(),
                  undefined,
                  trackedSpec.headingOffsetDeg ??
                    policy.MODEL_HEADING_OFFSET_DEG,
                ),
              );
          }
          state._trackedModel = record;
          state._trackedModelLoading = false;
          // A good load retires this selection's failure budget — a contact that
          // recovers after a transient blip is not one attempt from giving up.
          state._trackedModelFailIcao = null;
          state._trackedModelFailCount = 0;
          state._trackedModelRetryAtMs = 0;
          state._modelCollection.add(m);
          state._planeModelLoaded = true; // GLB cached — the tracked billboard can fade out once the model is up
        })
        .catch((err) => {
          if (gen !== state._trackedModelGen) return; // superseded load — not this selection's failure
          state._trackedModelLoading = false;
          parts.tracking._noteTrackedModelLoadFailure(trackedSpec.url, err);
        });
      return; // billboard carries the visual until the model is ready
    }
    if (state._trackedModel) {
      // Keep the transform current while GPU resources are still loading. Cesium
      // can flip ready during scene update after this callback; waiting for ready
      // here would let that first rendered frame use a stale load-start matrix.
      const displayPos = _modelDisplayPosition(
        state._trackedIcao,
        pos,
        state._scratchGroundPos,
      );
      if (!displayPos) {
        showModel(state._trackedModel, false); // no ground evidence → the icon carries it
        return;
      }
      const spec = _modelSpec(
        state.records.data.get(state._trackedIcao)?.klass,
      );
      placeModel(
        state._trackedModel,
        _modelMatrix(
          displayPos,
          parts.motion._trackedDisplayCourse(),
          undefined,
          spec.headingOffsetDeg ?? policy.MODEL_HEADING_OFFSET_DEG,
        ),
      );
      if (!state._trackedModel.model.ready) return;
      state._trackedModel.model.scale = trackedModelScaleForPixelCap({
        baseScale: spec.scale,
        nativeRadiusM: spec.nativeRadiusM,
        rangeM: Cesium.Cartesian3.distance(
          state._viewer.camera.positionWC,
          displayPos,
        ),
        viewportHeightPx: state._viewer.scene.canvas.clientHeight,
        fovyRad: state._viewer.camera.frustum.fovy,
        maximumPixelSize: policy.TRACKED_MODEL_MAX_PX,
      });
      showModel(state._trackedModel, true);
    }
  }

  /**
   * ~12 Hz fleet pass. Motion, rotation, the horizon cull, limb recession and
   * the two-tier glyph swap all run on the GPU from each row's segment, so this
   * only re-plans rows whose regime ended, runs the layer's own pass after
   * that (flights floors grounded contacts), advances focus de-emphasis while
   * a target exists, and drives the 3D-model handoff inside the model regime.
   * Driven by scene.preRender.
   * @returns {void}
   */

  function _fleetTick() {
    const icons = state._icons;
    if (!state._viewer || !icons || !icons.show) return;
    const scene = state._viewer.scene;
    const camera = state._viewer.camera;
    const nowMs = focusNowMs(Date.now());

    if (nowMs - state._lastFleetTickMs < policy.FLEET_DR_INTERVAL_MS) return;
    state._lastFleetTickMs = nowMs;
    // Every contact in this pass shares the same delayed display instant.
    const renderTime = parts.icons._displayTime(state._scratchFleetRenderTime);
    const tau = icons.seconds(renderTime);

    _drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
    if (state._cockpitContactMode) parts.tracking._refreshCockpitNearContacts();
    parts.icons._replanExpired(tau);
    afterReplan(renderTime, tau, nowMs, camera);
    const focusTarget = getFocusTarget();
    parts.icons._focusIcons(tau, scene, camera, nowMs, focusTarget);

    // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
    // Drop all models the moment we leave it (toggled off / zoomed out) so icons resume.
    const useModels = _modelRegimeActive();
    // Drop live models AND invalidate in-flight loads on leaving the regime (else a load that
    // resolves after zoom-out could briefly add a model outside the 3D-model regime).
    if (!useModels && (state._models.size || state._modelPending.size))
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
      if (icao === state._trackedIcao) continue;
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
      const position = icons.position(row, tau, state._scratchModelBS.center);
      const d2 = Cesium.Cartesian3.distanceSquared(camPos, position);
      if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
      cand.push([
        icao,
        d2,
        cull.computeVisibility(state._scratchModelBS) !==
          Cesium.Intersect.OUTSIDE,
      ]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first
    if (cand.length > cap && nowMs - state._lastModelCapWarnMs > 5000) {
      console.warn(
        `[${logLabel}] ${cand.length} planes in 3D range; capped at ${cap} (${state._models3dMode}). On-screen planes are prioritized.`,
      );
      state._lastModelCapWarnMs = nowMs;
    }
    const modelEligible = selectModelEligible(cand, {
      cap,
      addDistSq,
      isModeled: (icao) => state._models.has(icao),
    });
    const toRelease = [];
    for (const icao of state._models.keys()) {
      if (icao !== state._trackedIcao && !modelEligible.has(icao))
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
      const position = icons.position(row, tau, state._scratchFleetPos);
      if (!parts.icons._aboveHorizon(row, position, occluder)) {
        // A model that crossed the limb would keep rendering through the
        // hidden globe at its last matrix; the icon's own cull is on the GPU.
        const hidden = state._models.get(icao24);
        if (hidden?.show) showModel(hidden, false);
        continue;
      }
      _ensureModel(icao24);
      const record = state._models.get(icao24);
      const cameraDistanceM = Cesium.Cartesian3.distance(camPos, position);
      _driveFleetModelHandoff(
        icao24,
        record,
        row,
        position,
        icons.course(row, tau),
        () => {
          applyAircraftModelTreatment({
            model: record.model,
            // IR boost must survive the per-tick treatment write — otherwise
            // any alpha change would repaint the ordinary tint over the hot
            // white. Boosted models also skip the recession fade: hot targets
            // stay full-strength at any range (icons keep their normal
            // fade — full-opacity glyph walls read as overwhelming).
            baseColor: state._irBoost
              ? Cesium.Color.WHITE
              : _modelColor(icao24),
            alpha: state._irBoost
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
    _modelRegimeActive,
    _modelCap,
    _modelAddDistM,
    _modelKeepDistM,
    _modelMatrix,
    _groundSampleExclusions,
    _modelDisplayPosition,
    _driveFleetModelHandoff,
    _modelOwnsVisual,
    _specKeyFor,
    _syncModelToClass,
    _reloadModelsForIrBoost,
    _drainIrReloadQueue,
    _ensureModel,
    _releaseModel,
    _cleanupModelGen,
    _releaseModels,
    _showReleasedIcon,
    _releaseTrackedModel,
    _updateTrackedModel,
    _fleetTick,
  };
}
