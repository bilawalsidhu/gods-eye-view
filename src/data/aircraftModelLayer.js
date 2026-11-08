import { selectModelEligible } from './modelEligibility.js';
import {
  aircraftTreatmentAlpha,
  DEFAULT_AIRCRAFT_RECESSION_PARAMS,
} from './aircraftRecession.js';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';
import {
  createModelRecord,
  modelIsRendering,
  placeModel,
  showModel,
} from './modelRecord.js';
import { modelDrawnScale } from './modelVisualAnchor.js';
import { findCamera, findDraw, rendererOf } from '../render/rendererOf.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import {
  distance,
  distanceSquared,
  dot,
  RADIANS_PER_DEGREE,
  sub,
} from '../geo/vector.js';

/** A white tint: what an IR-boosted model draws with. */
const WHITE = Object.freeze([1, 1, 1, 1]);

/** Id of the hidden item that keeps the tracked asset loaded. */
const PRELOAD_ID = '~preload';

/** Where the preload item waits, unshown. */
const NOWHERE = Object.freeze({ x: 0, y: 0, z: 0 });

/** How often (ms) a model that has not loaded is written again, so a
 *  renderer that retries failed loads on write (as the Cesium one does)
 *  gets the chance even for a parked contact whose item never changes. */
const UNREADY_REWRITE_MS = 5000;

/** A colour as the draw contract's `[r, g, b, a]`, from `{red, green, blue, alpha}`. */
function rgba(color) {
  if (!color) return null;
  if (typeof color === 'string' || Array.isArray(color)) return color;
  return [color.red, color.green, color.blue, color.alpha ?? 1];
}

/**
 * Whether `point` is inside the eye's view cone (`pose`), a metre's slack:
 * the camera's culling volume against a one-metre sphere.
 */
function inView(pose, point) {
  const v = sub(point, pose.position);
  const depth = dot(v, pose.direction);
  if (depth < -1) return false;
  const tanY = Math.tan(pose.fovy / 2);
  const tanX = tanY * pose.aspectRatio;
  return (
    Math.abs(dot(v, pose.right)) <= Math.max(0, depth) * tanX + 1 &&
    Math.abs(dot(v, pose.up)) <= Math.max(0, depth) * tanY + 1
  );
}

/**
 * An aircraft layer's 3D models: the fleet regime and its gap-proof handoff
 * from the icon set (`createAircraftIcons`), the standalone tracked model, and
 * the ~12 Hz fleet tick that drives both. Shared by the flights and military
 * layers, which differ only in the options below.
 *
 * The models are two `models` sets of the renderer's draw port, made for each
 * layer lifetime (`_createModelSets`): the fleet's, one item per modelled
 * contact, and the tracked contact's (with a hidden item that keeps the
 * tracked asset loaded). Each item is re-posed and restyled in place; the
 * layer keeps its own record of each (`modelRecord.js`), and a set's `ready`
 * says when a model has loaded. Picks name the set and the contact's id.
 * @param {object} options
 * @param {object} options.state The layer state.
 * @param {object} options.services
 * @param {object} options.parts The layer's parts; `icons`, `motion` and
 *   `tracking` are read at call time.
 * @param {(url: string) => string} options.resolveAsset
 * @param {string} options.logLabel Console prefix, e.g. `Data:Flights`.
 * @param {string} options.setPrefix The draw sets' id prefix, e.g. `flights`.
 * @param {object} options.policy The layer's model budgets, radii, pixel
 *   bounds, heading offset and fleet tick interval.
 * @param {(klass: string) => object} options.modelSpec The class's GLB, scale,
 *   geometry and tint blend; `headingOffsetDeg` overrides the policy's.
 * @param {(icao24: string) => object} options.modelColor Model tint
 *   (`{red, green, blue, alpha}`), including the tracked contact's.
 * @param {(icao24: string) => void} [options.onModelEligible] Runs when a
 *   contact is about to render in 3D.
 * @param {(renderTime: object, t: number, nowMs: number, eye: object|null)
 *   => void} [options.afterReplan] The layer's own pass in the fleet tick,
 *   after expired rows are re-planned: the display instant (as the layer's
 *   motion keeps it, and epoch ms), the focus clock and the eye (ECEF), or
 *   null without a camera.
 */
export function createAircraftModels({
  state,
  services,
  parts,
  resolveAsset,
  logLabel,
  setPrefix,
  policy,
  modelSpec: _modelSpec,
  modelColor: _modelColor,
  onModelEligible = () => {},
  afterReplan = () => {},
}) {
  const { isTr3b } = services.aircraftPresentation;
  const { trackedModelScaleForPixelCap } = services.camera;
  const { focusNowMs, getFocusTarget } = services.focus;
  const writeEpsilon = DEFAULT_AIRCRAFT_RECESSION_PARAMS.writeEpsilon;
  let instances = 0;
  /** The fleet items this tick wrote, sent together when it ends. */
  let pendingItems = [];
  /** The ground sample's exclusions, kept while the sets they name live. */
  let exclusions = null;

  /** The camera's pose, or null without a camera to ask. */
  function _pose() {
    try {
      return findCamera(state._viewer)?.pose() ?? null;
    } catch {
      return null;
    }
  }

  /** The renderer canvas's CSS size, and drawing-buffer pixels per CSS
   *  pixel; zero sizes without a renderer. */
  function _viewport() {
    const renderer = rendererOf(state._viewer);
    const canvas = renderer?.canvas;
    return {
      width: Number(canvas?.clientWidth) || 0,
      height: Number(canvas?.clientHeight) || 0,
      pixelRatio: renderer?.quality?.get?.()?.pixelRatio ?? 1,
    };
  }

  /** The model heading offset a class's GLB needs. */
  const _headingOffsetDeg = (klass) =>
    _modelSpec(klass).headingOffsetDeg ?? policy.MODEL_HEADING_OFFSET_DEG;

  /** A course (degrees) as the class's model heading (radians). */
  const _modelHeading = (course, klass) =>
    ((course || 0) + _headingOffsetDeg(klass)) * RADIANS_PER_DEGREE;

  /**
   * Make this lifetime's model sets on the viewer's draw port (none on a
   * renderer that draws no models: the layer stays icons). `draw` stands in
   * for the viewer's (tests).
   * @param {object} viewer
   * @param {{preloadUrl?: string, draw?: object}} [options]
   */
  function _createModelSets(viewer, { preloadUrl, draw } = {}) {
    _disposeModelSets();
    const port = draw ?? findDraw(viewer);
    if (typeof port?.models !== 'function') return;
    const n = ++instances;
    const fleet = port.models({ id: `${setPrefix}-models:${n}` });
    const tracked = port.models({ id: `${setPrefix}-tracked-model:${n}` });
    const offs = [
      fleet.on('ready', (id) => {
        const record = state._models.get(id);
        if (record) record.ready = true;
      }),
      tracked.on('ready', (id) => {
        if (id === state._trackedIcao && state._trackedModel)
          state._trackedModel.ready = true;
      }),
    ];
    state._modelSets = { fleet, tracked, offs };
    // A hidden item keeps the tracked asset loaded, so the tracked model
    // draws as soon as it is wanted.
    if (preloadUrl)
      tracked.upsert([
        {
          id: PRELOAD_ID,
          pos: NOWHERE,
          url: preloadUrl,
          orientation: { heading: 0, pitch: 0, roll: 0 },
          environmentMap: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS.enabled,
          show: false,
          pickable: false,
        },
      ]);
  }

  /** Let this lifetime's model sets go. */
  function _disposeModelSets() {
    const sets = state._modelSets;
    if (!sets) return;
    state._modelSets = null;
    for (const off of sets.offs) off();
    sets.fleet.dispose();
    sets.tracked.dispose();
  }

  /** Show or hide every model (the layer shown or hidden). */
  function _setModelsShown(show) {
    const sets = state._modelSets;
    if (!sets) return;
    sets.fleet.show = show;
    sets.tracked.show = show;
  }

  /** The model sets' ids (picks, height samples); empty without sets. */
  function _modelSetIds() {
    const sets = state._modelSets;
    return sets ? [sets.fleet.id, sets.tracked.id] : [];
  }

  /** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
   *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
   *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
   *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
   *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
   *  contact does not route through here: it is one model, it is what the camera is aimed at,
   *  and it takes its own default-on, hysteretic zoom regime
   *  (`_trackedModelRegimeActive`). */

  function _modelRegimeActive(pose = _pose()) {
    if (!state._models3dEnabled) return false;
    const h = pose?.height ?? Infinity;
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

  /** What a grounded model's ground sample sees through: the vertical sample
   *  at a plane's own lat/lon otherwise lands on its (or a parked neighbour's)
   *  icon or model instead of the tile skin. The query port sees through
   *  every draw set not drawn as ground; these are named for clarity. */

  function _groundSampleExclusions() {
    const modelSets = state._modelSets;
    const iconSetId = state._icons?.setId ?? null;
    if (
      exclusions?.modelSets !== modelSets ||
      exclusions.iconSetId !== iconSetId
    ) {
      const sets = [..._modelSetIds()];
      if (iconSetId) sets.push(iconSetId);
      exclusions = { modelSets, iconSetId, value: { sets } };
    }
    return exclusions.value;
  }

  /** Position a 3D MODEL renders at. Airborne planes use their dead-reckoned position
   *  verbatim. GROUNDED planes' meta altitude is last-known baro or 0 m — nowhere near
   *  the photoreal tile skin in ellipsoid heights (buried ~100+ m at inland airports,
   *  hovering ~30 m at sea-level ones), and unlike the ground billboards a depth-tested
   *  model can't hide behind disableDepthTestDistance. So a modeled grounded plane rides
   *  a ONE-SHOT cached height sample of the skin at its lat/lon (groundSnap.js,
   *  CCTV-B9b discipline: never per-frame; taxiing >50 m retires the cached value to a
   *  bounded last-known and resamples), plus
   *  the belly offset so it sits on its gear rather than sinking to the model-origin
   *  fuselage centerline. Until the FIRST sample lands (tiles streaming / sample miss)
   *  there is no safe depth-tested placement at all: this returns null, the caller
   *  keeps the 2D billboard visible and the model hidden, and it retries later. Once
   *  a contact has resolved once, a later outage holds that measurement inside
   *  groundSnap's drift bound instead — a taxiing aircraft does not pop back to 2D
   *  because a resample is mid-backoff. */

  function _modelDisplayPosition(icao24, pos) {
    const meta = state.records.data.get(icao24);
    if (!meta || !meta.onGround) return pos;
    const h = state._groundSnap.heightFor(
      state._viewer,
      icao24,
      pos,
      _groundSampleExclusions(),
    );
    if (h == null) return null;
    const at = toLonLatH(pos);
    if (!at) return null;
    return fromDegrees(at.lon, at.lat, h + _modelSpec(meta.klass).bellyM);
  }

  /** How a contact's model draws now: the IR boost's flat white, or its tint. */
  function _shadingOf() {
    return state._irBoost ? 'unlit' : 'pbr';
  }

  /** The tint a record sends: `base` at `alpha`, kept while within the
   *  write epsilon; a missing colour or alpha leaves it as it is. */
  function _treat(record, { base, alpha }) {
    if (!base || !Number.isFinite(alpha)) return;
    const tint = record.tint;
    if (
      tint &&
      tint[0] === base[0] &&
      tint[1] === base[1] &&
      tint[2] === base[2] &&
      Math.abs(tint[3] - alpha) <= writeEpsilon
    )
      return;
    record.tint = [base[0], base[1], base[2], alpha];
  }

  /** The record's item, as its set draws it. */
  function _itemOf(id, record, spec) {
    const boost = state._irBoost === true;
    return {
      id,
      pos: { x: record.position.x, y: record.position.y, z: record.position.z },
      url: record.url,
      orientation: { heading: record.heading, pitch: 0, roll: 0 },
      scale: record.scale,
      minPixelSize: record.minPixelSize,
      shading: _shadingOf(),
      tint: record.tint ?? WHITE,
      // The code-side tint dominates every approved model; the IR boost
      // removes the remaining diffuse hint with flat unlit white.
      colorBlend: { mode: 'mix', amount: boost ? 1 : spec.blendAmount },
      environmentMap: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS.enabled,
      show: record.show,
    };
  }

  /** Send a record's item when anything it draws changed. */
  function _send(set, id, record, spec, out) {
    if (!set) return;
    const p = record.position;
    const t = record.tint ?? WHITE;
    // A model still loading is rewritten now and then, for the renderer's retry.
    const loading = record.ready
      ? ''
      : Math.floor(Date.now() / UNREADY_REWRITE_MS);
    const key = `${record.url}|${p.x},${p.y},${p.z}|${record.heading}|${record.scale}|${record.minPixelSize}|${t[0]},${t[1]},${t[2]},${t[3]}|${state._irBoost === true}|${spec.blendAmount}|${record.show}|${loading}`;
    if (key === record.sent) return;
    record.sent = key;
    const item = _itemOf(id, record, spec);
    if (out) out.push(item);
    else set.upsert([item]);
  }

  /** Atomically hand one fleet contact from its icon to a safely placed,
   * ready 3D model. Missing/loading models and unresolved terrain always leave
   * the icon owning the visual, so no render frame can hide both.
   * `beforeShow` runs only on the committing path — the per-tick model treatment
   * belongs to a model that is about to draw, not to one still waiting.
   * `out` collects the items to write (the tick writes them together). */

  function _driveFleetModelHandoff(
    icao24,
    record,
    pos,
    course,
    beforeShow,
    out,
  ) {
    const icons = state._icons;
    if (!record) {
      icons.setShown(icao24, true);
      return false;
    }
    const klass = state.records.data.get(icao24)?.klass;
    const spec = _modelSpec(klass);
    const set = state._modelSets?.fleet ?? null;
    const displayPos = _modelDisplayPosition(icao24, pos);
    if (!displayPos) {
      showModel(record, false); // no ground evidence → nothing safe to place a depth-tested model at
      _send(set, icao24, record, spec, out);
      icons.setShown(icao24, true);
      return false;
    }
    // Placed BEFORE the readiness test on purpose: a model can turn ready
    // between ticks, and its first drawn frame must be at this placement.
    placeModel(record, displayPos, _modelHeading(course, klass));
    if (!record.ready) {
      showModel(record, false); // not loaded yet → keep the 2D icon, no half-model flash
      _send(set, icao24, record, spec, out);
      icons.setShown(icao24, true);
      return false;
    }
    beforeShow?.();
    showModel(record, true);
    _send(set, icao24, record, spec, out);
    icons.setShown(icao24, false); // hand off ONLY once the model renders
    return true;
  }

  /**
   * Whether a 3D model — not the billboard — is what the user actually SEES for
   * this contact, and therefore whether the display floor should stand aside.
   *
   * Model EXISTENCE is not ownership. A fleet model that is still loading, or has
   * no resolved ground to stand on, stays hidden while the icon stays shown
   * (the gap-proof handoff: "hand off ONLY once the model renders"), and a tracked model
   * is retained but hidden whenever the model regime is off — 3D disabled, camera
   * zoomed past the ceiling, or cockpit mode. Gating on `has()`/existence therefore
   * suppressed the clamp in exactly the states where the BILLBOARD is the visual,
   * putting the burial straight back.
   *
   * Admission records a model hidden, so a fleet model admitted but not yet
   * placed cannot claim ownership, and every site that shows one does so only
   * after placing it.
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
  // (`_driveFleetModelHandoff`, after it is placed) and one for the
  // tracked model (`_updateTrackedModel`, likewise); everything else —
  // admission, an unresolved ground, a not-yet-ready glTF, the limb cull, a
  // regime exit — only ever clears it.

  /**
   * The scale a record's model is drawn at, by the draw contract's pixel
   * rule (its `minPixelSize` at its distance from the eye).
   * @param {import('./modelRecord.js').ModelRecord} record
   * @param {object} spec The class spec (`nativeRadiusM`).
   * @param {{pose: object|null, width: number, height: number,
   *   pixelRatio: number}} [view]
   *   One frame's camera and viewport, for a pass over many.
   * @returns {number}
   */
  function _modelDrawnScale(record, spec, view = _drawnScaleView()) {
    return modelDrawnScale({
      scale: record.scale,
      minPixelSize: record.minPixelSize,
      radiusM: spec.nativeRadiusM,
      center: record.position,
      pose: view.pose,
      viewportHeightPx: view.height,
      viewportWidthPx: view.width,
      pixelRatio: view.pixelRatio,
    });
  }

  /** One frame's camera and viewport for `_modelDrawnScale`. */
  function _drawnScaleView() {
    return { pose: _pose(), ..._viewport() };
  }

  /** Spec identity for an admitted model: URL and scale together (same-URL classes
   *  differ by scale — airliner vs quadjet both ship airplane.glb). */

  const _specKeyFor = (klass) => {
    const spec = _modelSpec(klass);
    return `${spec.url}@${spec.scale}`;
  };

  /** Class-change model sync (enrichment AND poll-path klass updates): when the
   *  aircraft's model no longer matches its class's spec, drop it so the
   *  eligibility pass admits the right asset at the right scale. Gap-proof: the
   *  fleet icon is re-shown with the release, so the contact never goes
   *  invisible for the tick gap. The tracked standalone model gets the same
   *  rule (its billboard entity is always the fallback visual). */

  function _syncModelToClass(icao24) {
    const key = _specKeyFor(state.records.data.get(icao24)?.klass);
    const current = state._models.get(icao24);
    if (current && current.specKey !== key) _releaseModel(icao24);
    if (
      icao24 === state._trackedIcao &&
      state._trackedModel &&
      state._trackedModel.specKey !== key
    ) {
      _releaseTrackedModel();
    }
  }

  /** The IR boost flipped: every model restyles in place on its next write
   *  (shading and tint can change live). */
  function _reloadModelsForIrBoost() {
    for (const record of state._models.values()) record.tint = null;
    if (state._trackedModel) state._trackedModel.tint = null;
    state._lastFleetTickMs = 0;
  }

  /** Admit a fleet model for an aircraft; the icon shows until it is ready. */

  function _ensureModel(icao24) {
    // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
    // tick skips it, so a model here would be orphaned + double-rendered.
    if (icao24 === state._trackedIcao) return;
    onModelEligible(icao24);
    if (state._models.has(icao24)) return;
    // Without model sets (the renderer draws none) the icon stays.
    if (!state._modelSets) return;
    if (state._models.size >= _modelCap()) return;
    if (!_modelRegimeActive() || !state.records.data.has(icao24)) return;
    const klass = state.records.data.get(icao24)?.klass;
    const spec = _modelSpec(klass);
    const record = createModelRecord({
      specKey: _specKeyFor(klass), // class-change sync compares against this
      bellyM: spec.bellyM,
      scale: spec.scale,
      minPixelSize: policy.MODEL_MIN_PX,
    });
    record.url = resolveAsset(spec.url);
    record.tint = state._irBoost ? WHITE : rgba(_modelColor(icao24));
    // Admitted, not yet the visual: the handoff places and shows it, and the
    // set loads it from its first write.
    state._models.set(icao24, record);
  }

  /** Remove the 3D model for ONE aircraft (removal / military-suppression / track handoff). */

  function _releaseModel(icao24) {
    _releaseModelsOf([icao24]);
  }

  /** Remove several aircraft's 3D models in one write (the eligibility pass). */

  function _releaseModelsOf(ids) {
    const gone = ids.filter((icao24) => state._models.delete(icao24));
    if (!gone.length) return;
    state._modelSets?.fleet.remove(gone);
    for (const icao24 of gone) _showReleasedIcon(icao24);
  }

  /** Remove all live models (toggle-off / zoom-out); billboards take back over next tick. */

  function _releaseModels() {
    if (state._models.size) state._modelSets?.fleet.clear();
    for (const icao24 of state._models.keys()) _showReleasedIcon(icao24);
    state._models.clear();
  }

  /** A released fleet model hands the visual straight back to its icon (the
   *  tracked contact's entity keeps its own). */

  function _showReleasedIcon(icao24) {
    const icons = state._icons;
    if (icons?.has(icao24) && icao24 !== state._trackedIcao)
      icons.setShown(icao24, true);
  }

  /** Drop the standalone tracked-aircraft model. */

  function _releaseTrackedModel() {
    const record = state._trackedModel;
    if (!record) return;
    state._trackedModel = null;
    if (record.id) state._modelSets?.tracked.remove([record.id]);
  }

  /** Hide the tracked model, writing it once. */
  function _hideTrackedModel() {
    const record = state._trackedModel;
    if (!record) return;
    showModel(record, false);
    _send(
      state._modelSets?.tracked,
      record.id,
      record,
      _modelSpec(state.records.data.get(record.id)?.klass),
    );
  }

  /** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
   *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
   *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
   *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode). */

  function _updateTrackedModel() {
    const active =
      state._trackedIcao &&
      parts.tracking._trackedModelRegimeActive() &&
      state._modelSets;
    if (!active) {
      _hideTrackedModel();
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
      _hideTrackedModel();
      return;
    }
    const icao24 = state._trackedIcao;
    const klass = state.records.data.get(icao24)?.klass;
    const spec = _modelSpec(klass);
    if (state._trackedModel && state._trackedModel.id !== icao24)
      _releaseTrackedModel();
    if (!state._trackedModel) {
      const record = createModelRecord({
        specKey: _specKeyFor(klass), // class-change sync compares against this
        bellyM: spec.bellyM,
        scale: spec.scale,
        minPixelSize: policy.TRACKED_MODEL_MIN_PX,
      });
      record.id = icao24;
      record.url = resolveAsset(spec.url);
      state._trackedModel = record;
    }
    const record = state._trackedModel;
    // The tracked aircraft uses the same dominant light tint as the fleet;
    // the IR boost removes the remaining diffuse hint with flat white.
    if (!record.tint)
      record.tint = state._irBoost ? WHITE : rgba(_modelColor(icao24));
    // Placed while it loads too: its first drawn frame is at this placement.
    const displayPos = _modelDisplayPosition(icao24, pos);
    if (!displayPos) {
      _hideTrackedModel(); // no ground evidence → the icon carries it
      return;
    }
    placeModel(
      record,
      displayPos,
      _modelHeading(parts.motion._trackedDisplayCourse(), klass),
    );
    if (record.ready) {
      const pose = _pose();
      record.scale = trackedModelScaleForPixelCap({
        baseScale: spec.scale,
        nativeRadiusM: spec.nativeRadiusM,
        rangeM: pose?.position ? distance(pose.position, displayPos) : NaN,
        viewportHeightPx: _viewport().height,
        fovyRad: pose?.fovy,
        maximumPixelSize: policy.TRACKED_MODEL_MAX_PX,
      });
    }
    showModel(record, record.ready);
    _send(state._modelSets.tracked, icao24, record, spec);
  }

  /**
   * ~12 Hz fleet pass. Motion, rotation, the horizon cull, limb recession and
   * the two-tier glyph swap all run on the GPU from each icon's motion, so this
   * only re-plans icons whose regime ended, runs the layer's own pass after
   * that (flights floors grounded contacts), advances focus de-emphasis while
   * a target exists, and drives the 3D-model handoff inside the model regime.
   * Driven before each frame draws: what it writes is flushed to the draw
   * sets before the frame draws, as the 3D models it shows and hides are.
   * @returns {void}
   */

  function _fleetTick() {
    try {
      _fleetPass();
    } finally {
      // The models first, then the icons they take over from, so a pass
      // that stopped part way never flushes an icon hidden for a model it
      // did not write.
      if (pendingItems.length) {
        const items = pendingItems;
        pendingItems = [];
        try {
          state._modelSets?.fleet.upsert(items);
        } catch (error) {
          // Nothing of these reached the set: send them again next tick, and
          // let their icons carry the contacts meanwhile.
          for (const item of items) {
            const record = state._models.get(item.id);
            if (record) {
              record.sent = null;
              showModel(record, false);
            }
            _showReleasedIcon(item.id);
          }
          console.warn(`[${logLabel}] fleet model write failed`, error);
        }
      }
      state._icons?.flush();
    }
  }

  function _fleetPass() {
    const icons = state._icons;
    if (!state._viewer || !icons || !icons.show) return;
    const nowMs = focusNowMs(Date.now());

    if (nowMs - state._lastFleetTickMs < policy.FLEET_DR_INTERVAL_MS) return;
    state._lastFleetTickMs = nowMs;
    const pose = _pose();
    // Every contact in this pass shares the same delayed display instant.
    const t = parts.icons._displayMs();

    if (state._cockpitContactMode) parts.tracking._refreshCockpitNearContacts();
    parts.icons._syncImageSwitch();
    parts.icons._replanExpired(t);
    const renderTime = parts.motion._displayTimeAt(
      t,
      state._scratchFleetRenderTime,
    );
    afterReplan(renderTime, t, nowMs, pose?.position ?? null);
    const focusTarget = getFocusTarget();
    parts.icons._focusIcons(t, nowMs, focusTarget);

    // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
    // Drop all models the moment we leave it (toggled off / zoomed out) so icons resume.
    const useModels = _modelRegimeActive(pose);
    if (!useModels && state._models.size) _releaseModels();
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
    const camPos = pose.position;
    const addM = _modelAddDistM();
    const addDistSq = addM * addM;
    const keepM = _modelKeepDistM();
    const keepDistSq = keepM * keepM;
    // Candidates = planes within the KEEP radius, nearest first, each tagged with on-screen-ness.
    const cand = [];
    for (const icao of icons.ids()) {
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
      const position = icons.position(icao, t);
      const d2 = distanceSquared(camPos, position);
      if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
      cand.push([icao, d2, inView(pose, position)]);
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
    _releaseModelsOf(toRelease);

    // 3D model takes over from the icon for eligible planes. GAP-PROOF: the icon stays shown
    // until the model is actually READY to render, so a plane is never both iconless AND
    // modelless (the "planes vanish when 3D turns on" bug). Position the model every tick
    // regardless so it's framed the instant it becomes ready. Converted TR-3Bs stay 2D on
    // purpose: the Easter egg IS the triangle, and there is no GLB for it.
    const occluder = parts.icons._occluder();
    const items = pendingItems;
    for (const icao24 of modelEligible) {
      if (isTr3b(icao24)) continue;
      if (!icons.has(icao24)) continue;
      const position = icons.position(icao24, t);
      if (!parts.icons._aboveHorizon(position, occluder)) {
        // A model that crossed the limb would keep drawing through the
        // hidden globe; the icon's own cull is on the GPU.
        const hidden = state._models.get(icao24);
        if (hidden?.show) {
          showModel(hidden, false);
          _send(
            state._modelSets?.fleet,
            icao24,
            hidden,
            _modelSpec(state.records.data.get(icao24)?.klass),
            items,
          );
        }
        continue;
      }
      _ensureModel(icao24);
      const record = state._models.get(icao24);
      const cameraDistanceM = distance(camPos, position);
      _driveFleetModelHandoff(
        icao24,
        record,
        position,
        icons.course(icao24, t),
        () => {
          _treat(record, {
            // IR boost must survive the per-tick treatment write — otherwise
            // any alpha change would repaint the ordinary tint over the hot
            // white. Boosted models also skip the recession fade: hot targets
            // stay full-strength at any range (icons keep their normal
            // fade — full-opacity glyph walls read as overwhelming).
            base: state._irBoost ? WHITE : rgba(_modelColor(icao24)),
            alpha: state._irBoost
              ? 1
              : aircraftTreatmentAlpha({
                  baseAlpha: icons.alpha(icao24),
                  focusFactor: icons.focus(icao24),
                  cameraDistanceM,
                  cameraHeightM: pose.height,
                }),
          });
        },
        items,
      );
    }
  }
  return {
    _createModelSets,
    _disposeModelSets,
    _setModelsShown,
    _modelSetIds,
    _modelRegimeActive,
    _modelCap,
    _modelAddDistM,
    _modelKeepDistM,
    _groundSampleExclusions,
    _modelDisplayPosition,
    _driveFleetModelHandoff,
    _modelOwnsVisual,
    _modelDrawnScale,
    _drawnScaleView,
    _specKeyFor,
    _syncModelToClass,
    _reloadModelsForIrBoost,
    _ensureModel,
    _releaseModel,
    _releaseModels,
    _showReleasedIcon,
    _releaseTrackedModel,
    _updateTrackedModel,
    _fleetTick,
  };
}
