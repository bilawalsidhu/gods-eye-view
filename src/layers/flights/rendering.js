import * as Cesium from 'cesium';
import { cyberSonarBaseAlpha } from '../../cyberSonar.js';
import {
  CLASS_SCALE_2D,
  CLASS_MODEL_REAL,
  CLASS_SCALE_3D,
  CLASS_MODEL_URL,
} from '../../data/aircraftClass.js';
import {
  visualCenterForModel,
  trailAnchorForModel,
} from '../../data/modelVisualAnchor.js';
import { cockpitContactDotImage } from '../../data/cockpitContactDot.js';
import { aircraftIcon, TRACKED_ICON_PX } from '../../data/aircraftIcons.js';
import {
  cameraPoseSignature,
  horizonOccluder,
  screenProjectedRotation,
} from '../../data/iconOrientation.js';
import { limitCourseStep, courseSlewCapDps } from '../../data/motionModel.js';
import {
  MIL_TINT,
  GROUND_SCALE,
  MODEL_COLOR_BLEND_AMOUNT,
  MODEL_SCALE,
  PLANE_MODEL_URL,
  MODEL_NATIVE_RADIUS_M,
  MODEL_BELLY_OFFSET_NATIVE,
  COCKPIT_CONTACT_SIZE_PX,
  COCKPIT_CIVILIAN_COLOR,
  MODEL_ALT_CEIL_M,
  MODEL_MAX_ALL,
  MODEL_MAX,
  COCKPIT_MODEL_MAX,
  MODEL_ALL_ADD_M,
  MODEL_PROX_ADD_M,
  MODEL_ALL_KEEP_M,
  MODEL_PROX_KEEP_M,
  MODEL_HEADING_OFFSET_DEG,
  IR_RELOAD_BATCH,
  MODEL_MIN_PX,
  TRACKED_MODEL_MIN_PX,
  TRACKED_MODEL_MAX_PX,
  FLEET_DR_INTERVAL_MS,
  COURSE_SLEW_DT_MAX_SEC,
  ROTATION_REFRESH_MS,
  COURSE_MAX_DPS,
} from './policy.js';

export function createRendering({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { isMilitaryIcao } = services.militaryRegistry;
  const { tr3bIconKind, isTr3b } = services.aircraftPresentation;
  const { trackedModelScaleForPixelCap } = services.camera;
  const {
    focusNowMs,
    getFocusTarget,
    nearFarScalarValueAtDistance,
    advanceProjectedSpriteFocus,
  } = services.focus;
  const { applyAircraftBillboardTreatment, applyAircraftModelTreatment } =
    services.recession;

  /** Fleet (untracked) billboard tint: amber for known-military, white otherwise.
   *  Ground traffic gets NO special tint (owner verdict 2026-07-03 field test). */

  function _fleetBillboardColor(icao24) {
    return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
  }

  /** Fleet billboard scale: per-class scale, ×GROUND_SCALE while grounded. */

  function _fleetBillboardScale(icao24, klass) {
    return (
      (CLASS_SCALE_2D[klass] || 1) *
      (flightState.records.data.get(icao24)?.onGround ? GROUND_SCALE : 1)
    );
  }

  /** Depth-test policy for aircraft billboards. Round 5 (owner directive
   *  2026-07-06: "I just want the planes and their lines to ALWAYS be
   *  visible... evenly applied"): EVERY contact renders depth-test-free at
   *  every distance — grounded, low, and airborne alike. The photoreal mesh
   *  writes depth and residual baro/floor error will always leave some sprite
   *  geometry at or below it; a uniform rule beats the grounded-only /
   *  low-AGL-only conditions that kept leaving classes of contacts buried
   *  (2026-07-03 Van Nuys grounded case; 2026-07-06 Austin QNH-below-field
   *  case). Far-side planes are still removed by the fleet tick's horizon
   *  occluder, which never depended on depth. Kept as a function so the
   *  callers' restyle sites stay diff-stable. */

  function _groundDepthDistance() {
    return Number.POSITIVE_INFINITY;
  }

  function _modelSpec(klass) {
    const cached = flightState._specCache.get(klass);
    if (cached) return cached;
    const real = CLASS_MODEL_REAL[klass];
    let spec;
    if (real) {
      spec = {
        url: real.url,
        scale: 1,
        nativeRadiusM: real.radiusM,
        bellyM: real.bellyM,
        blendAmount: MODEL_COLOR_BLEND_AMOUNT,
        visualCenterNative: visualCenterForModel(real.url),
        trailAnchorNative: trailAnchorForModel(real.url),
      };
    } else {
      const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
      const url = CLASS_MODEL_URL[klass] || PLANE_MODEL_URL;
      spec = {
        url,
        scale,
        nativeRadiusM: MODEL_NATIVE_RADIUS_M,
        bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
        blendAmount: MODEL_COLOR_BLEND_AMOUNT,
        visualCenterNative: visualCenterForModel(url),
        trailAnchorNative: trailAnchorForModel(url),
      };
    }
    flightState._specCache.set(klass, spec);
    return spec;
  }

  function _normalBillboardScaleByDistance() {
    // Preserve the established close-range 3× scale. Any smaller owner-visible
    // default belongs in a separate evidence-backed proposal.
    return new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
  }

  function _cockpitBillboardScaleByDistance() {
    return new Cesium.NearFarScalar(1000, 1.15, 8000000, 0.65);
  }

  /** Sprite kind for one contact's billboard. Identity for every aircraft except
   *  the ones the operator converted into a TR-3B (Easter egg), which draw the
   *  black-triangle glyph — its thermal-reactive variant while an IR style owns
   *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
   *  conversion survive the poll reconciler and the two-tier raster swap. */

  const _iconKind = (icao24, klass) =>
    tr3bIconKind(icao24, klass, { hot: flightState._irBoost });

  /** Apply the current normal/cockpit visual contract to one owned fleet billboard. */

  function _applyFleetBillboardPresentation(icao24, bb) {
    if (!bb) return;
    const limbScale = flightState._billboardLimbScale.get(bb) ?? 1;
    const isCockpitContact =
      flightState._cockpitContactMode && icao24 !== flightState._trackedIcao;
    const isCockpitNear =
      isCockpitContact && flightState._cockpitNearContacts.has(icao24);
    if (isCockpitContact && !isCockpitNear) {
      const freshnessAlpha = cyberSonarBaseAlpha(bb);
      bb.image = cockpitContactDotImage();
      bb.width = COCKPIT_CONTACT_SIZE_PX;
      bb.height = COCKPIT_CONTACT_SIZE_PX;
      bb.scale = limbScale;
      bb.scaleByDistance = _cockpitBillboardScaleByDistance();
      bb.color = (
        isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR
      ).withAlpha(freshnessAlpha);
      bb.rotation = 0;
      return;
    }

    const meta = flightState.records.data.get(icao24);
    bb.image = aircraftIcon(
      _iconKind(icao24, meta?.klass),
      bb._gevIconLarge ? TRACKED_ICON_PX : undefined,
    );
    bb.width = icao24 === flightState._trackedIcao ? 24 : 20;
    bb.height = icao24 === flightState._trackedIcao ? 24 : 20;
    bb.scale = _fleetBillboardScale(icao24, meta?.klass) * limbScale;
    bb.scaleByDistance = _normalBillboardScaleByDistance();
    bb.color = _fleetBillboardColor(icao24).withAlpha(cyberSonarBaseAlpha(bb));
  }

  /**
   * Per-preRender fleet pass at ~12Hz: dead-reckons every untracked billboard,
   * horizon-culls billboards beyond the limb (no far-side depth with the globe
   * hidden), and refreshes screen-projected icon rotations whenever the camera
   * pose changed (plus a 1s drift catch-up while idle). Driven by
   * scene.preRender — NOT camera.changed, whose granularity is globally
   * degraded by other layers mutating camera.percentageChanged.
   * @returns {void}
   */

  /** Model tint, mirroring the billboard color rules. */

  function _modelColor(icao24) {
    if (icao24 === flightState._trackedIcao) return Cesium.Color.CYAN;
    return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
  }

  /** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
   *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
   *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
   *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
   *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
   *  contact does not route through here: it is one model, it is what the camera is aimed at,
   *  and it takes its own default-on, hysteretic zoom regime
   *  (`_trackedModelRegimeActive`). */

  function _modelRegimeActive() {
    if (!flightState._models3dEnabled) return false;
    const h =
      flightState._viewer?.camera?.positionCartographic?.height ?? Infinity;
    return h < MODEL_ALT_CEIL_M;
  }

  /** Active model cap — the eligibility pre-pass AND _ensureModel's admission checks must use the
   *  SAME value, else 'all' (MODEL_MAX_ALL) would mark planes eligible that _ensureModel then refuses
   *  at the lower MODEL_MAX, silently degrading 'all' to 'proximity'. */

  function _modelCap() {
    const mapCap =
      flightState._models3dMode === 'all' ? MODEL_MAX_ALL : MODEL_MAX;
    // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget. Cockpit is
    // already the heaviest mode (20 Hz camera setView ahead of scene update, photoreal
    // retraversal, the cloud pass) and every model is its own draw call.
    return flightState._cockpitContactMode
      ? Math.min(COCKPIT_MODEL_MAX, mapCap)
      : mapCap;
  }

  /** Active ADD radius (m) — new planes inside this range get a model. Mode-aware: 'all' reaches far. */

  function _modelAddDistM() {
    return flightState._models3dMode === 'all'
      ? MODEL_ALL_ADD_M
      : MODEL_PROX_ADD_M;
  }

  /** Active KEEP radius (m) — a modeled plane keeps its model out to here (hysteresis vs ADD). */

  function _modelKeepDistM() {
    return flightState._models3dMode === 'all'
      ? MODEL_ALL_KEEP_M
      : MODEL_PROX_KEEP_M;
  }

  /** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
   *  `result` and returns it — pass each model's OWN `.modelMatrix` so models never share one
   *  mutable matrix object. `Model.modelMatrix` is a plain field (not a cloning setter); Cesium
   *  clones it per frame in updateModelMatrix(). Sharing a single scratch made every model render at
   *  the LAST-written transform — all stacked on one plane — and, once the tracked model wrote the
   *  scratch every frame, the stack point oscillated frame-to-frame: the "flickering like mad" bug. */

  function _modelMatrix(
    pos,
    headingDeg,
    result = flightState._scratchModelMtx,
  ) {
    flightState._scratchModelHpr.heading = Cesium.Math.toRadians(
      (headingDeg || 0) + MODEL_HEADING_OFFSET_DEG,
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

  /** Everything scene.sampleHeight must NOT hit when snapping a grounded model: the
   *  vertical pick ray at a plane's own lat/lon otherwise lands on its (or a parked
   *  neighbor's) billboard/model instead of the tile skin. Cesium's ray-pick exclusion
   *  matches picked-object IDs, and every billboard AND model in this layer carries its
   *  icao as `id`, so the icao strings cover both; the tracked entity is excluded as the
   *  object itself. Built lazily — only when a sample actually fires (one-shot). */

  function _groundSampleExclusions() {
    const out = [...flightState._billboards.keys()];
    if (flightState._trackedEntity) out.push(flightState._trackedEntity);
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

  /** Atomically hand one fleet contact from its billboard to a safely placed,
   * ready 3D model. Missing/loading models and unresolved terrain always leave
   * the billboard owning the visual, so no render frame can hide both.
   * `beforeShow` runs only on the committing path — the per-tick model treatment
   * belongs to a model that is about to draw, not to one still waiting. */

  function _driveFleetModelHandoff(icao24, model, bb, pos, course, beforeShow) {
    if (!model) {
      bb.show = true;
      return false;
    }
    const displayPos = _modelDisplayPosition(
      icao24,
      pos,
      flightState._scratchGroundPos,
    );
    if (!displayPos) {
      model.show = false; // no ground evidence → nothing safe to place a depth-tested model at
      bb.show = true;
      return false;
    }
    // The matrix is written BEFORE the readiness test on purpose: a model can flip
    // `ready` during scene update after this tick, and a first rendered frame on a
    // stale load-start matrix is the one-frame jump this ordering prevents.
    _modelMatrix(displayPos, course, model.modelMatrix);
    if (!model.ready) {
      model.show = false; // not loaded yet → keep the 2D icon, no half-model flash
      bb.show = true;
      return false;
    }
    beforeShow?.();
    if (!model.show) model.show = true;
    if (bb.show) bb.show = false; // hand off ONLY once the model renders
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
   * @returns {boolean}
   */

  function _modelOwnsVisual(icao24) {
    if (icao24 === flightState._trackedIcao) {
      return (
        parts.tracking._trackedModelRegimeActive() &&
        _modelIsRendering(flightState._trackedModel)
      );
    }
    return _modelIsRendering(flightState._models.get(icao24));
  }

  /** A model is the visual only once it actually draws — loaded AND shown.
   *
   * `show` is sufficient evidence of a safe placement because only ONE site ever
   * sets it true for a fleet model (`_driveFleetModelHandoff`, after the matrix is
   * committed) and one for the tracked model (`_updateTrackedModel`, likewise);
   * everything else — admission, an unresolved ground, a not-yet-ready glTF, the
   * limb cull, a regime exit — only ever clears it. */

  function _modelIsRendering(model) {
    return !!model && model.ready === true && model.show === true;
  }

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
    const key = _specKeyFor(flightState.records.data.get(icao24)?.klass);
    const current = flightState._models.get(icao24);
    if (
      (current && current._gevSpecKey !== key) ||
      (!current && flightState._modelPending.has(icao24))
    ) {
      const bb = flightState._billboards.get(icao24);
      if (bb && icao24 !== flightState._trackedIcao) bb.show = true;
      _releaseModel(icao24);
    }
    if (
      icao24 === flightState._trackedIcao &&
      flightState._trackedModel &&
      flightState._trackedModel._gevSpecKey !== key
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
      if (!model || model._gevIrBoost === flightState._irBoost) continue; // already right state
      const bb = flightState._billboards.get(icao);
      if (bb && icao !== flightState._trackedIcao) bb.show = true;
      _releaseModel(icao);
    }
    if (flightState._irReloadQueue.length === 0)
      flightState._irReloadQueue = null;
  }

  /** Lazily create the glTF model for an aircraft (fire-and-forget; billboard shows until ready). */

  async function _ensureModel(icao24) {
    // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
    // tick skips it, so a model here would be orphaned + double-rendered.
    if (icao24 === flightState._trackedIcao) return;
    parts.enrichment._requestTypeEnrichment(icao24, true); // model-eligible: about to render in 3D — jump the ambient backlog
    if (
      flightState._models.has(icao24) ||
      flightState._modelPending.has(icao24)
    )
      return;
    // Count PENDING loads in the cap so a zoomed-in tick can't fire 100s of concurrent loads
    // (the cap is rechecked post-await too, before the add). Mode-aware so 'all' can reach MAX_ALL.
    if (
      flightState._models.size + flightState._modelPending.size >=
      _modelCap()
    )
      return;
    const epoch = flightState._modelEpoch; // lifecycle token: if destroy() bumps it, this load is dead
    const gen = flightState._modelGen.get(icao24) || 0; // capture; if it changes during the load, we're stale
    flightState._modelPending.add(icao24);
    let model = null;
    // Spec identity captured at load START — if enrichment reclassifies the
    // aircraft mid-load, the post-await admission below rejects the stale asset.
    // Boost state likewise: the creation options bake it in, so a mid-load
    // toggle must reject too (the reload queue only covers ADMITTED models).
    const specKey = _specKeyFor(flightState.records.data.get(icao24)?.klass);
    const loadIrBoost = flightState._irBoost;
    try {
      const spec = _modelSpec(flightState.records.data.get(icao24)?.klass);
      model = await Cesium.Model.fromGltfAsync({
        url: resolveAsset(spec.url),
        asynchronous: false,
        minimumPixelSize: MODEL_MIN_PX,
        scale: spec.scale,
        color: flightState._irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // Launch presentation keeps the code-side tint dominant for every approved
        // model; IR boost removes the remaining diffuse hint with flat UNLIT white.
        colorBlendAmount: flightState._irBoost ? 1.0 : spec.blendAmount,
        customShader: flightState._irBoost
          ? flightState._IR_UNLIT_SHADER
          : undefined,
        id: icao24, // so scene.pick returns the icao for click-to-track
      });
    } catch {
      // asset/decode fail — stay billboard. Only touch this lifecycle's state if still current
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
    model._gevSpecKey = specKey; // class-change sync compares against this
    model._gevIrBoost = loadIrBoost; // boost-flip reload queue compares against this
    // Admitted, not yet the visual. Cesium's default is show=true, which would let
    // an unplaced primitive claim ownership from the billboard for the frames
    // between admission and the next fleet tick (and draw at the identity matrix,
    // i.e. the Earth's centre). The handoff turns it on once it has a matrix.
    model.show = false;
    flightState._modelCollection.add(model);
    flightState._models.set(icao24, model);
    flightState._planeModelLoaded = true; // GLB is cached now — the tracked entity's model can fade in its billboard
  }

  /** Remove the 3D model for ONE aircraft (removal / military-suppression / track handoff).
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

  /** Remove all live models (toggle-off / zoom-out); billboards take back over next tick. */

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
    flightState._models.clear();
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

  /** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
   *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
   *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
   *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode). */

  function _updateTrackedModel() {
    const active =
      flightState._trackedIcao &&
      parts.tracking._trackedModelRegimeActive() &&
      flightState._modelCollection &&
      !flightState._modelCollection.isDestroyed();
    if (!active) {
      if (flightState._trackedModel) flightState._trackedModel.show = false;
      return;
    }
    // Ask the frame-cached source directly. If the entity callback already ran,
    // this is a no-op; if model loading completed between phases, it establishes
    // this frame's single sample before the model renders. Camera, detection, and
    // readout consumers then reuse that exact cached position.
    const pos =
      parts.motion._trackedDisplayPosition(flightState._trackedIcao) ||
      flightState._billboards.get(flightState._trackedIcao)?.position;
    if (!pos) {
      if (flightState._trackedModel) flightState._trackedModel.show = false;
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
        minimumPixelSize: TRACKED_MODEL_MIN_PX,
        scale: trackedSpec.scale,
        color: flightState._irBoost ? Cesium.Color.WHITE : Cesium.Color.CYAN,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        // The tracked aircraft uses the same dominant light tint as the fleet;
        // IR boost removes the remaining diffuse hint with flat UNLIT white.
        colorBlendAmount: flightState._irBoost ? 1.0 : trackedSpec.blendAmount,
        customShader: flightState._irBoost
          ? flightState._IR_UNLIT_SHADER
          : undefined,
        // Pick id (H1): without it, clicking the very plane being tracked read as
        // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
        // deselect. With the icao, the click handler recognizes it as ours.
        id: flightState._trackedIcao,
      })
        .then((m) => {
          // Untracked / re-tracked / torn down during the load → drop it.
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
          m._gevSpecKey = trackedKey; // class-change sync compares against this
          m.show = false; // admitted, not yet the visual — the driver shows it once placed
          // Seed the world transform before the primitive enters the scene. A model
          // can become ready+shown between render phases; leaving Cesium's identity
          // default here produces a one-frame jump to the Earth's center.
          const currentPos =
            parts.motion._trackedDisplayCached() ||
            flightState._billboards.get(flightState._trackedIcao)?.position;
          if (currentPos) {
            const displayPos = _modelDisplayPosition(
              flightState._trackedIcao,
              currentPos,
              flightState._scratchGroundPos,
            );
            if (displayPos)
              _modelMatrix(
                displayPos,
                parts.motion._trackedDisplayCourse(),
                m.modelMatrix,
              );
          }
          flightState._trackedModel = m;
          flightState._trackedModelLoading = false;
          // A good load retires this selection's failure budget — a contact that
          // recovers after a transient blip is not one attempt from giving up.
          flightState._trackedModelFailIcao = null;
          flightState._trackedModelFailCount = 0;
          flightState._trackedModelRetryAtMs = 0;
          flightState._modelCollection.add(m);
          flightState._planeModelLoaded = true; // GLB cached — the tracked billboard can fade out once the model is up
        })
        .catch((err) => {
          if (gen !== flightState._trackedModelGen) return; // superseded load — not this selection's failure
          flightState._trackedModelLoading = false;
          parts.tracking._noteTrackedModelLoadFailure(trackedSpec.url, err);
        });
      return; // billboard carries the visual until the model is ready
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
        flightState._trackedModel.show = false; // no ground evidence → the billboard carries it
        return;
      }
      _modelMatrix(
        displayPos,
        parts.motion._trackedDisplayCourse(),
        flightState._trackedModel.modelMatrix,
      );
      if (!flightState._trackedModel.ready) return;
      const spec = _modelSpec(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
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
      flightState._trackedModel.show = true;
    }
  }

  function _fleetTick() {
    if (
      !flightState._viewer ||
      !flightState._billboardCollection ||
      !flightState._billboardCollection.show
    )
      return;
    const scene = flightState._viewer.scene;
    const camera = flightState._viewer.camera;
    const nowMs = focusNowMs(Date.now());

    // (The tracked trail head is now the per-frame _trailHeadEntity segment — no 1 Hz
    // primitive rebuild needed here anymore.)

    if (nowMs - flightState._lastFleetTickMs < FLEET_DR_INTERVAL_MS) return;
    const tickDtSec = flightState._lastFleetTickMs
      ? Math.min(
          COURSE_SLEW_DT_MAX_SEC,
          (nowMs - flightState._lastFleetTickMs) / 1000,
        )
      : 0.08;
    flightState._lastFleetTickMs = nowMs;

    _drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
    if (flightState._cockpitContactMode)
      parts.tracking._refreshCockpitNearContacts();
    const poseSig = cameraPoseSignature(camera);
    // Only the nearby Cockpit silhouettes need projected course; far dots are
    // rotation-free. The per-contact gate below keeps the pip path cheap.
    const doRotations =
      poseSig !== flightState._lastCamPoseSig ||
      nowMs - flightState._lastRotPassMs >= ROTATION_REFRESH_MS;
    if (doRotations) {
      flightState._lastCamPoseSig = poseSig;
      flightState._lastRotPassMs = nowMs;
    }

    const occluder = horizonOccluder(camera);
    const focusTarget = getFocusTarget();

    // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
    // Drop all models the moment we leave it (toggled off / zoomed out) so billboards resume.
    const useModels = _modelRegimeActive();
    // Drop live models AND invalidate in-flight loads on leaving the regime (else a load that
    // resolves after zoom-out could briefly add a model outside the 3D-model regime).
    if (
      !useModels &&
      (flightState._models.size || flightState._modelPending.size)
    )
      _releaseModels();

    // 3D-model eligibility: by DISTANCE (the mode's add/keep band), with ON-SCREEN PRIORITY under the
    // cap. FOUR passes, visible-first, so the slots are spent on what you can see: (1) KEEP on-screen
    // already-modeled (hysteresis for visible planes); (2) ADD on-screen new inside the add radius,
    // nearest first; (3) KEEP off-screen already-modeled; (4) ADD off-screen new with leftover slots
    // (so a plane just off the cone still models — the "planes right next to me aren't 3D" complaint).
    // Crucially KEEP is SPLIT by frustum: an off-screen retained model (pass 3) can never starve an
    // on-screen plane that wants one (passes 1–2) — a single KEEP-everything pass could fill the cap
    // with off-screen retained models. Pure-distance let off-screen planes eat the cap; pure-frustum
    // filtering dropped near off-screen planes entirely. This does both right.
    let modelEligible = null;
    if (useModels) {
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
      for (const [icao, bb] of flightState._billboards) {
        if (icao === flightState._trackedIcao) continue;
        // A converted TR-3B renders as a billboard and can never take a model, so
        // it must not occupy a CAP SLOT either — excluded here at selection time,
        // not just at the handoff below, or accumulated conversions would starve
        // ordinary contacts of 3D models. (The handoff guard stays as defence.)
        if (isTr3b(icao)) continue;
        // Ground planes compete for model slots like everyone else (owner decision
        // 2026-07-03: "3D mode is respected regardless of whether a plane is on the
        // ground or in the air — no distinction"). The cap + nearest-first ordering
        // below already bound airport clusters; grounded placement is handled by the
        // one-shot ground snap in _modelDisplayPosition.
        const d2 = Cesium.Cartesian3.distanceSquared(camPos, bb.position);
        if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
        Cesium.Cartesian3.clone(
          bb.position,
          flightState._scratchModelBS.center,
        );
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
          `[Data:Flights] ${cand.length} planes in 3D range; capped at ${cap} (${flightState._models3dMode}). On-screen planes are prioritized.`,
        );
        flightState._lastModelCapWarnMs = nowMs;
      }
      modelEligible = new Set();
      // 1. KEEP on-screen already-modeled (visible retained — no flicker for what you can see).
      for (const [icao, , inF] of cand) {
        if (modelEligible.size >= cap) break;
        if (inF && flightState._models.has(icao)) modelEligible.add(icao);
      }
      // 2. ADD on-screen NEW inside the add radius, nearest first (visible additions win the cap).
      for (const [icao, d2, inF] of cand) {
        if (modelEligible.size >= cap) break;
        if (inF && d2 <= addDistSq && !modelEligible.has(icao))
          modelEligible.add(icao);
      }
      // 3. KEEP off-screen already-modeled (hysteresis, but LOWER priority than anything visible — so a
      //    retained off-screen model can never starve an on-screen plane that wants one; dropping it is
      //    invisible and it re-adds the moment it's back in view).
      for (const [icao, , inF] of cand) {
        if (modelEligible.size >= cap) break;
        if (!inF && flightState._models.has(icao)) modelEligible.add(icao);
      }
      // 4. ADD off-screen NEW inside the add radius with any leftover slots.
      for (const [icao, d2, inF] of cand) {
        if (modelEligible.size >= cap) break;
        if (!inF && d2 <= addDistSq && !modelEligible.has(icao))
          modelEligible.add(icao);
      }
      const toRelease = [];
      for (const icao of flightState._models.keys()) {
        if (icao !== flightState._trackedIcao && !modelEligible.has(icao))
          toRelease.push(icao);
      }
      for (const icao of toRelease) _releaseModel(icao);
    }

    for (const [icao24, bb] of flightState._billboards) {
      if (icao24 === flightState._trackedIcao) continue; // tracked entity owns its own motion

      const info = flightState.records.data.get(icao24);

      const dr = parts.motion._deadReckon(icao24, flightState._scratchFleetPos);
      // The dead-reckoned point drifts away from the fix whose cell supplied the
      // height, so a grounded contact's sprite ends up under the mesh it taxied
      // (or coasted) over. Re-floor at the DISPLAYED coordinate — read-only, and
      // never while a 3D model owns the visual (T7).
      const display = parts.motion._floorGroundedDisplayPosition(
        icao24,
        info,
        dr,
        _modelOwnsVisual(icao24),
        nowMs,
      );
      // Gate the write — assigning Billboard.position dirties the whole
      // collection's vertex buffer, so skip sub-meter moves.
      if (
        display &&
        Cesium.Cartesian3.distanceSquared(display, bb.position) > 1.0
      ) {
        bb.position = display;
      }

      // Round 6: occlusion-test a LIFTED point for contacts rendering below
      // (or within a wingspan of) the ellipsoid — EllipsoidalOccluder judges a
      // sub-ellipsoid point near the limb "beyond the horizon" and the fleet
      // pass would hide a plane that is really just low over high-N terrain
      // waiting for its floor to warm (ATL grounded contacts at geoid −31 m).
      const beyondHorizon = !occluder.isPointVisible(
        flightState._cullPositions.get(icao24) || bb.position,
      );
      // A billboard flipping INTO view (horizon reveal while the camera idles)
      // gets its rotation refreshed THIS tick even without a pose change —
      // otherwise it reappears wearing its stale (often creation-north) nose for
      // up to ROTATION_REFRESH_MS. (Model-handed-off planes also read show=false
      // here; harmless — the model branch below `continue`s past the rotation.)
      const revealed = !beyondHorizon && !bb.show;
      if (bb.show === beyondHorizon) bb.show = !beyondHorizon;
      if (beyondHorizon) {
        // Also hide any 3D model — otherwise a model that crossed the limb would keep
        // rendering through the hidden globe at its last matrix.
        const m = flightState._models.get(icao24);
        if (m && m.show) m.show = false;
        continue;
      }

      // One order-independent write site composes freshness × focus × limb haze
      // for alpha, and base class/ground scale × limb taper for scale. Cesium's
      // locked NearFarScalar remains a separate multiplicative stage. This
      // narrowly amends always-visible rendering without count culling or zero
      // alpha; nearer focus behavior remains tunable rather than universal.
      const cameraDistanceM = Cesium.Cartesian3.distance(
        camera.positionWC,
        bb.position,
      );
      const distanceScale = nearFarScalarValueAtDistance(
        bb.scaleByDistance,
        cameraDistanceM,
      );
      const focus = advanceProjectedSpriteFocus(
        bb,
        bb.position,
        scene,
        camera,
        nowMs,
        focusTarget,
        undefined,
        (bb.width || 20) * (bb.scale || 1) * distanceScale * 0.5,
        (bb.height || 20) * (bb.scale || 1) * distanceScale * 0.5,
      );
      const isCockpitNear =
        flightState._cockpitContactMode &&
        flightState._cockpitNearContacts.has(icao24);
      const layerBaseColor =
        flightState._cockpitContactMode && !isCockpitNear
          ? isMilitaryIcao(icao24)
            ? MIL_TINT
            : COCKPIT_CIVILIAN_COLOR
          : _fleetBillboardColor(icao24);
      const baseColor = layerBaseColor;
      const treatment = applyAircraftBillboardTreatment({
        billboard: bb,
        baseScale:
          flightState._cockpitContactMode && !isCockpitNear
            ? 1
            : _fleetBillboardScale(icao24, info?.klass),
        baseAlpha: flightState.records.missingPolls.get(icao24) ? 0.45 : 1,
        baseColor,
        focusFactor: focus.factor,
        cameraDistanceM,
        cameraHeightM: camera.positionCartographic?.height,
      });
      flightState._billboardLimbScale.set(bb, treatment.factors.scale);
      // Two-tier glyph raster (owner playtest 2026-08-16): the billboard atlas
      // has no mipmaps, so no single texture stays crisp across the ~25–150
      // device-px range scaleByDistance produces. Swap between the 64 px fleet
      // raster and the 192 px close raster on the billboard's ACTUAL on-screen
      // size — post-treatment bb.scale, so focus/limb recession counts — with
      // hysteresis so zoom oscillation never thrashes the atlas.
      if (!flightState._cockpitContactMode || isCockpitNear) {
        const glyphDevPx =
          (bb.width || 20) *
          (bb.scale || 1) *
          distanceScale *
          (globalThis.devicePixelRatio || 1);
        const wantLarge = bb._gevIconLarge ? glyphDevPx > 56 : glyphDevPx > 76;
        if (wantLarge !== !!bb._gevIconLarge) {
          bb._gevIconLarge = wantLarge;
          bb.image = aircraftIcon(
            _iconKind(icao24, info?.klass),
            wantLarge ? TRACKED_ICON_PX : undefined,
          );
        }
      }

      // Smoothed display course: the path direction _deadReckon just reported
      // for THIS aircraft (nothing else calls _deadReckon in between), rate-
      // limited so segment-boundary course steps glide instead of snapping.
      // The slew cap eases toward COURSE_MIN_DPS at low speed, and a hovering
      // aircraft (hold flag) keeps its previous nose direction outright.
      const rawCourse =
        flightState._drCourseDeg != null
          ? flightState._drCourseDeg
          : (info && info.true_track) || 0;
      const prevCourse = flightState._displayCourse.get(icao24);
      const course =
        flightState._drCourseHold && prevCourse != null
          ? prevCourse
          : limitCourseStep(
              prevCourse,
              rawCourse,
              courseSlewCapDps(
                flightState._drSpeedMps != null
                  ? flightState._drSpeedMps
                  : ((info && info.velocity) ?? NaN),
                COURSE_MAX_DPS,
              ),
              tickDtSec,
            );
      flightState._displayCourse.set(icao24, course);

      // 3D model takes over from the billboard for in-view planes (modelEligible). GAP-PROOF: the
      // billboard stays shown until the model is actually READY to render, so a plane is never both
      // iconless AND modelless (the "planes vanish when 3D turns on" bug). Position the model every
      // tick regardless so it's framed the instant it becomes ready.
      // Converted TR-3Bs stay 2D on purpose: the Easter egg IS the triangle, and
      // there is no GLB for it, so the model handoff is suppressed rather than
      // fed a stand-in mesh. The billboard keeps rendering (and keeps satisfying
      // the getNearby/getDetectableObjects `bb.show` visibility guards), so a
      // converted contact still works in Contacts and Cockpit.
      if (useModels && dr && modelEligible.has(icao24) && !isTr3b(icao24)) {
        _ensureModel(icao24);
        const model = flightState._models.get(icao24);
        const ownsVisual = _driveFleetModelHandoff(
          icao24,
          model,
          bb,
          dr,
          course,
          () => {
            applyAircraftModelTreatment({
              model,
              // IR boost must survive the per-tick treatment write — otherwise
              // any alpha change would repaint the ordinary tint over the hot
              // white. Boosted models also skip the recession fade: hot targets
              // stay full-strength at any range (billboards keep their normal
              // fade — full-opacity glyph walls read as overwhelming).
              baseColor: flightState._irBoost
                ? Cesium.Color.WHITE
                : _modelColor(icao24),
              alpha: flightState._irBoost ? 1 : treatment.alpha,
            });
          },
        );
        if (ownsVisual) continue; // skip billboard rotation
      }

      if (
        (!flightState._cockpitContactMode || isCockpitNear) &&
        (doRotations || revealed)
      ) {
        const rot = screenProjectedRotation(
          scene,
          bb.position,
          course,
          bb.rotation,
        );
        if (rot !== null && Math.abs(rot - bb.rotation) > 0.002) {
          bb.rotation = rot;
        }
      }
    }
  }
  return {
    _fleetBillboardColor,
    _fleetBillboardScale,
    _groundDepthDistance,
    _modelSpec,
    _normalBillboardScaleByDistance,
    _cockpitBillboardScaleByDistance,
    _iconKind,
    _applyFleetBillboardPresentation,
    _modelColor,
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
