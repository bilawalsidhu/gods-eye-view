import { selectModelEligible } from './modelEligibility.js';
import {
  aircraftTreatmentAlpha,
  DEFAULT_AIRCRAFT_RECESSION_PARAMS,
} from './aircraftRecession.js';
import {
  AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
  aircraftModelBlend,
} from './aircraftModelLighting.js';
import {
  createModelRecord,
  modelIsRendering,
  placeModel,
  showModel,
} from './modelRecord.js';
import { modelDrawnScale } from './modelVisualAnchor.js';
import {
  createRenderPace,
  createScreenSpeed,
  paceHzForSpeed,
} from '../renderPace.js';
import { ROTOR_FPS } from './rotorFrames.js';
import { fleetModelSet, fleetPartTable } from './fleetModels.js';
import { aircraftLayerPartState } from './modelPartDrivers.js';
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

/** How long (ms) a fleet model whose load failed (`loadFailed`) waits
 *  before it is removed and added again, which loads it again. */
const FLEET_MODEL_RETRY_MS = 5000;

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

/** Each icon's move is read over at most this much of its drawn path, in ms. */
const PACE_SPAN_MS = 1000;
/** A drawn path that ends sooner than this is not read: it is replanned. */
const PACE_MIN_SPAN_MS = 20;

/**
 * How much of an icon's drawn path, from display time `t`, its on-screen
 * speed is read over: PACE_SPAN_MS, or what is left of a path that ends
 * sooner (past its end it stands still, which is no speed), or 0 when too
 * little is left to read.
 * @param {number} t Display ms.
 * @param {number|null|undefined} endsAt When the icon's drawn path ends, if it does.
 */
export function paceSpanMs(t, endsAt) {
  if (endsAt == null || !(endsAt - t < PACE_SPAN_MS)) return PACE_SPAN_MS;
  const left = endsAt - t;
  return left >= PACE_MIN_SPAN_MS ? left : 0;
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
 * layer keeps its own record of each (`modelRecord.js`), a set's `ready`
 * says when a model has loaded and its `loadFailed` when one failed to. A
 * failed fleet model is loaded again every `FLEET_MODEL_RETRY_MS`; the
 * tracked model has a per-selection budget (`TRACKED_MODEL_MAX_LOAD_FAILS`
 * failures, `TRACKED_MODEL_RETRY_BACKOFF_MS` apart), after which the contact
 * stays an icon until another is selected. Picks name the set and the
 * contact's id.
 * @param {object} options
 * @param {object} options.state The layer state.
 * @param {object} options.services
 * @param {object} options.parts The layer's parts; `icons`, `motion` and
 *   `tracking` are read at call time.
 * @param {(url: string) => string} options.resolveAsset
 * @param {string} options.logLabel Console prefix, e.g. `Data:Flights`.
 * @param {string} options.setPrefix The draw sets' id prefix, e.g. `flights`.
 * @param {object} options.policy The layer's model budgets, radii, pixel
 *   bounds, heading offset, fleet tick interval and tracked-model load
 *   budget.
 * @param {(meta: object|undefined) => object} options.modelSpec The fleet
 *   model an aircraft draws with, from its record (its type and emitter
 *   category): the model's url, scale, geometry, tint blend and spec `key`;
 *   `headingOffsetDeg` overrides the policy's. A spec without a `url` (the
 *   fleet set not loaded yet) keeps the aircraft an icon. A spec naming a
 *   `model` of the fleet set is drawn from the set's bytes (`gltf`).
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
  const { focusNowMs, getFocusTarget } = services.focus;
  const writeEpsilon = DEFAULT_AIRCRAFT_RECESSION_PARAMS.writeEpsilon;
  let instances = 0;
  /** The fleet items this tick wrote, sent together when it ends. */
  let pendingItems = [];

  // The pace: how often the fleet is drawn while nothing else draws
  // (renderPace.js). The icons move on the GPU, so a frame is all a move
  // takes; an airliner crosses a hundredth of a pixel a second on the whole
  // globe and hundreds from close by, so the rate follows the fastest icon
  // in view.
  const pace = createRenderPace({ owner: setPrefix, render: services.render });
  const screenSpeed = createScreenSpeed();
  /** How often the icons' on-screen speed is read, in ms. */
  const PACE_READ_MS = 250;
  /** While icons fade for a focus change, they are drawn this often. */
  const PACE_FADE_HZ = 20;
  /** A rotor drawn this recently is in view. */
  const PACE_ROTOR_SEEN_MS = 600;
  let paceReadMs = -Infinity;
  let pacePxPerSec = 0;

  /**
   * The fastest icon in view's speed on screen, in pixels a second: each
   * shown icon's drawn position now and PACE_SPAN_MS on, which takes in a
   * new fix being blended in as well as its flight.
   */
  function _readIconSpeed(pose) {
    const icons = state._icons;
    if (!icons || !screenSpeed.begin(pose, _viewport().height)) return 0;
    const t = parts.icons._displayMs();
    for (const id of icons.ids()) {
      if (!icons.shown(id)) continue;
      const spanMs = paceSpanMs(t, icons.expires(id));
      if (!spanMs) continue;
      screenSpeed.add(
        icons.position(id, t),
        icons.position(id, t + spanMs),
        PACE_SPAN_MS / spanMs,
      );
    }
    return screenSpeed.pxPerSec(PACE_SPAN_MS / 1000);
  }

  /**
   * Draws a second the fleet needs as the camera stands (the pace clamps
   * it to its range). Infinity: as often as the pace allows.
   */
  function _paceHz(nowMs = Date.now()) {
    const pose = _pose();
    if (!pose?.position) return Infinity;
    // Models, and the Cockpit's contacts, are moved on every frame.
    if (
      state._cockpitContactMode ||
      state._models.size ||
      _modelRegimeActive(pose)
    )
      return Infinity;
    if (nowMs - paceReadMs >= PACE_READ_MS) {
      paceReadMs = nowMs;
      pacePxPerSec = _readIconSpeed(pose);
    }
    let hz = paceHzForSpeed(pacePxPerSec);
    if (state._iconFocusFading > 0 && hz < PACE_FADE_HZ) hz = PACE_FADE_HZ;
    // A helicopter in view turns its rotor ROTOR_FPS times a second.
    const rotorAtMs = parts.icons._rotorDrawnAtMs?.() ?? -Infinity;
    if (nowMs - rotorAtMs < PACE_ROTOR_SEEN_MS && hz < ROTOR_FPS)
      hz = ROTOR_FPS;
    return hz;
  }
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

  /** A contact's record (its type and emitter category pick its model). */
  const _metaOf = (icao24) => state.records.data.get(icao24);

  /** The model heading offset an aircraft's model needs. */
  const _headingOffsetDeg = (meta) =>
    _modelSpec(meta).headingOffsetDeg ?? policy.MODEL_HEADING_OFFSET_DEG;

  /** A course (degrees) as the aircraft's model heading (radians). */
  const _modelHeading = (course, meta) =>
    ((course || 0) + _headingOffsetDeg(meta)) * RADIANS_PER_DEGREE;

  /**
   * Make this lifetime's model sets on the viewer's draw port (none on a
   * renderer that draws no models: the layer stays icons). `draw` stands in
   * for the viewer's (tests).
   * @param {object} viewer
   * @param {{draw?: object}} [options]
   */
  function _createModelSets(viewer, { draw } = {}) {
    _disposeModelSets();
    const port = draw ?? findDraw(viewer);
    if (typeof port?.models !== 'function') return;
    const n = ++instances;
    const fleet = port.models({ id: `${setPrefix}-models:${n}` });
    const tracked = port.models({ id: `${setPrefix}-tracked-model:${n}` });
    const offs = [
      fleet.on('ready', (id) => {
        const record = state._models.get(id);
        if (!record) return;
        record.ready = true;
        // Loaded after all (a renderer may retry on its own): no retry due.
        record.failedAt = 0;
      }),
      fleet.on('loadFailed', (id) => {
        const record = state._models.get(id);
        if (record) record.failedAt = Date.now();
      }),
      tracked.on('ready', (id) => {
        if (id !== state._trackedIcao || !state._trackedModel) return;
        state._trackedModel.ready = true;
        // Loaded after all (a renderer may retry on its own): kept.
        state._trackedModel.failedAt = 0;
        // A good load retires this selection's failure budget: a contact
        // that recovers after a transient blip is not one attempt from
        // giving up.
        state._trackedModelFailIcao = null;
        state._trackedModelFailCount = 0;
        state._trackedModelRetryAtMs = 0;
      }),
      tracked.on('loadFailed', (id, message) => {
        const record = state._trackedModel;
        if (id !== state._trackedIcao || !record || record.id !== id) return;
        record.failedAt = Date.now();
        _noteTrackedModelLoadFailure(record.url, message);
      }),
    ];
    state._modelSets = { fleet, tracked, offs };
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

  /** The FLEET's 3D-model regime: models3d enabled AND the camera below the altitude ceiling,
   *  above which no contact can be within the model radius. Since 2026-08-22 the toggle DEFAULTS
   *  ON in `proximity`, which is itself the budget: models only appear within MODEL_ADD_M of the
   *  camera and only for the nearest MODEL_MAX. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
   *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
   *  contact routes through here too (`_trackedModelRegimeActive`), with its place in the
   *  fleet's cap, so selecting a contact never changes its form. */

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

  /** ADD radius (m) — new planes inside this range get a model. Both modes
   *  share it; they differ by their caps. */

  function _modelAddDistM() {
    return policy.MODEL_ADD_M;
  }

  /** KEEP radius (m) — a modeled plane keeps its model out to here (hysteresis vs ADD). */

  function _modelKeepDistM() {
    return policy.MODEL_KEEP_M;
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
    return fromDegrees(at.lon, at.lat, h + _modelSpec(meta).bellyM);
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

  /** A finite number of the first of `values` that is one, else null. */
  const _finite = (...values) =>
    values.find((v) => typeof v === 'number' && Number.isFinite(v)) ?? null;

  /**
   * How high an aircraft flies above the ground under it: its render
   * altitude over the cached ground floor there; null where that floor is
   * not known (the gear then follows the approach rule instead).
   */
  function _heightAboveGround(meta) {
    const altitude = _finite(meta.renderAltitudeM);
    const floor =
      Number.isFinite(meta.rawLat) && Number.isFinite(meta.rawLon)
        ? services.groundFloor?.cachedGroundFloor?.(meta.rawLat, meta.rawLon)
        : null;
    return altitude !== null && Number.isFinite(floor)
      ? altitude - floor
      : null;
  }

  /**
   * The moving parts a contact's model is posed with, from its record
   * (`aircraftLayerPartState`): gear, doors and flaps by its height and climb,
   * fans, propellers and rotors while it flies or taxis. An airport vehicle
   * is a road vehicle (`groundVehiclePartState`): its wheels roll with its
   * speed. Undefined for a model without parts.
   */
  function _partsOf(meta, spec) {
    if (!meta) return undefined;
    const table = fleetPartTable(fleetModelSet(), spec?.model);
    if (!table) return undefined;
    return aircraftLayerPartState(table, {
      klass: meta.klass,
      onGround: meta.onGround === true,
      heightAboveGroundM: _heightAboveGround(meta),
      altitudeM: _finite(meta.altitude, meta.altitudeM),
      verticalRateMps: _finite(meta.verticalRate, meta.verticalRateMps),
      speedMps: _finite(meta.velocity, meta.speedMps),
    });
  }

  /** Pose a record's parts as its contact's record says, and key them for `_send`. */
  function _poseParts(record, meta, spec) {
    const pose = _partsOf(meta, spec);
    record.parts = pose;
    record.partsKey = pose ? JSON.stringify(pose) : '';
  }

  /** The record's item, as its set draws it. */
  function _itemOf(id, record) {
    return {
      id,
      pos: { x: record.position.x, y: record.position.y, z: record.position.z },
      url: record.url,
      // Built from the bytes loaded up front: never fetched mid-session.
      ...(record.gltf ? { gltf: record.gltf } : {}),
      orientation: { heading: record.heading, pitch: 0, roll: 0 },
      scale: record.scale,
      minPixelSize: record.minPixelSize,
      shading: _shadingOf(),
      tint: record.tint ?? WHITE,
      // The mesh's own colours, tinted red in an emergency;
      // the IR boost draws it flat white.
      colorBlend: aircraftModelBlend(state._irBoost === true, record.tint),
      environmentMap: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS.enabled,
      ...(record.parts ? { parts: record.parts } : {}),
      show: record.show,
    };
  }

  /** Send a record's item when anything it draws changed. */
  function _send(set, id, record, spec, out) {
    if (!set) return;
    const p = record.position;
    const t = record.tint ?? WHITE;
    const key = `${record.url}|${p.x},${p.y},${p.z}|${record.heading}|${record.scale}|${record.minPixelSize}|${t[0]},${t[1]},${t[2]},${t[3]}|${state._irBoost === true}|${record.show}|${record.partsKey ?? ''}`;
    if (key === record.sent) return;
    record.sent = key;
    const item = _itemOf(id, record);
    if (out) out.push(item);
    else set.upsert([item]);
  }

  /** A fleet model whose load failed, removed from its set once
   *  `FLEET_MODEL_RETRY_MS` has passed; the write that follows adds it
   *  again, and the set loads it again. */
  function _retryFailedFleetModel(set, icao24, record) {
    if (
      !set ||
      !record.failedAt ||
      Date.now() - record.failedAt < FLEET_MODEL_RETRY_MS
    )
      return;
    record.failedAt = 0;
    record.sent = null;
    // A fresh load: not ready until the set says so again.
    record.ready = false;
    set.remove([icao24]);
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
    const meta = _metaOf(icao24);
    const spec = _modelSpec(meta);
    const set = state._modelSets?.fleet ?? null;
    _retryFailedFleetModel(set, icao24, record);
    const displayPos = _modelDisplayPosition(icao24, pos);
    if (!displayPos) {
      showModel(record, false); // no ground evidence → nothing safe to place a depth-tested model at
      _send(set, icao24, record, spec, out);
      icons.setShown(icao24, true);
      return false;
    }
    // Placed BEFORE the readiness test on purpose: a model can turn ready
    // between ticks, and its first drawn frame must be at this placement.
    placeModel(record, displayPos, _modelHeading(course, meta));
    _poseParts(record, meta, spec);
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
   *    drawing yet. Until the tracked model draws, the fleet model the contact
   *    had when it was selected still draws it, and owns the visual.
   * @param {string} icao24
   * @param {import('./modelRecord.js').ModelRecord|null} [record] Resolved
   *   fleet model record; null means absent.
   * @returns {boolean}
   */

  function _modelOwnsVisual(icao24, record) {
    if (icao24 === state._trackedIcao) {
      // Its fleet model draws it until the tracked model takes over.
      return (
        parts.tracking._trackedModelRegimeActive() &&
        (modelIsRendering(state._trackedModel) ||
          modelIsRendering(state._models.get(icao24)))
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

  /** Spec identity for an admitted model: the model and its scale together
   *  (one model draws several types, each at its own length). */

  const _specKeyFor = (meta) => {
    const spec = _modelSpec(meta);
    return spec.key ?? `${spec.url}@${spec.scale}`;
  };

  /** A spec's bytes in the fleet model set loaded up front, if any. */
  const _gltfOf = (spec) =>
    spec.model ? (fleetModelSet()?.bytes?.get(spec.model) ?? null) : null;

  /** Type-change model sync (enrichment AND poll-path type/category updates): when the
   *  aircraft's model no longer matches its type's spec, drop it so the
   *  eligibility pass admits the right asset at the right scale. Gap-proof: the
   *  fleet icon is re-shown with the release, so the contact never goes
   *  invisible for the tick gap. The tracked standalone model gets the same
   *  rule (its billboard entity is always the fallback visual). */

  function _syncModelToClass(icao24) {
    const key = _specKeyFor(_metaOf(icao24));
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

  /** Admit a fleet model for an aircraft; the icon shows until it is ready.
   *  The selected aircraft's is admitted too, and kept loaded but hidden
   *  while its tracked model draws it (`_keepTrackedFleetModel`). */

  function _ensureModel(icao24) {
    onModelEligible(icao24);
    if (state._models.has(icao24)) return;
    // Without model sets (the renderer draws none) the icon stays.
    if (!state._modelSets) return;
    if (state._models.size >= _modelCap()) return;
    if (!_modelRegimeActive() || !state.records.data.has(icao24)) return;
    const meta = _metaOf(icao24);
    const spec = _modelSpec(meta);
    // Until the fleet model set has loaded the aircraft stays an icon.
    if (!spec.url) return;
    const record = createModelRecord({
      specKey: _specKeyFor(meta), // type-change sync compares against this
      bellyM: spec.bellyM,
      scale: spec.scale,
    });
    record.url = resolveAsset(spec.url);
    record.gltf = _gltfOf(spec);
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

  /** Whether the driver may load the tracked model again: an untried
   *  selection, or one under its failure budget past its backoff. */
  function _trackedModelLoadAllowed(nowMs = Date.now()) {
    if (state._trackedModelFailIcao !== state._trackedIcao) return true;
    if (state._trackedModelFailCount >= policy.TRACKED_MODEL_MAX_LOAD_FAILS)
      return false;
    return nowMs >= state._trackedModelRetryAtMs;
  }

  /** Count a failed tracked-model load against the selection's budget and
   *  arm the backoff, or the give-up latch. */
  function _noteTrackedModelLoadFailure(url, message) {
    if (state._trackedModelFailIcao !== state._trackedIcao) {
      state._trackedModelFailIcao = state._trackedIcao;
      state._trackedModelFailCount = 0;
    }
    state._trackedModelFailCount += 1;
    state._trackedModelRetryAtMs =
      Date.now() + policy.TRACKED_MODEL_RETRY_BACKOFF_MS;
    if (state._trackedModelFailCount >= policy.TRACKED_MODEL_MAX_LOAD_FAILS)
      console.warn(
        `[${logLabel}] tracked 3D model gave up after ${state._trackedModelFailCount} failed loads of ${url}; ` +
          'this contact stays 2D until another is selected',
        message,
      );
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
      _modelSpec(_metaOf(record.id)),
    );
  }

  /** Whether the tracked contact may draw as a model, set by the fleet pass
   *  (preRender). The icon owns the visual from the moment it may not
   *  (`_modelOwnsVisual`), so its models stop drawing in this frame too, not
   *  at the next frame's `_updateTrackedModel`. */
  function _setTrackedModelEligible(eligible) {
    const was = state._trackedModelEligible;
    state._trackedModelEligible = eligible;
    if (!was || eligible) return;
    _hideTrackedModel();
    _hideTrackedFleetModel();
  }

  /** The tracked contact's fleet model lets go once the contact is no
   *  longer drawn as a model at all (out of range, 3D off, cockpit). */
  function _releaseTrackedFleetModel() {
    if (state._trackedIcao && state._models.has(state._trackedIcao))
      _releaseModel(state._trackedIcao);
  }

  /** The tracked contact's fleet model (it was a model when it was
   *  selected, or was admitted since) stops drawing once the tracked model
   *  draws, or while the tracked icon carries the contact, but stays loaded:
   *  deselecting hands the contact straight back to it
   *  (`_handBackDeselected`), with no load and no icon in between. */
  function _hideTrackedFleetModel() {
    const icao24 = state._trackedIcao;
    const record = icao24 ? state._models.get(icao24) : null;
    if (!record?.show) return;
    showModel(record, false);
    _send(state._modelSets?.fleet, icao24, record, _modelSpec(_metaOf(icao24)));
  }

  /** Keep the tracked contact's fleet model loaded and placed where its icon
   *  is, one fleet tick at a time, so it is ready to take the contact back
   *  the moment it is deselected. It never shows here: it draws the contact
   *  only while the tracked model loads, as it did before the selection. */
  function _keepTrackedFleetModel(icao24, position, course, out) {
    _ensureModel(icao24);
    const record = state._models.get(icao24);
    if (!record) return;
    const meta = _metaOf(icao24);
    const set = state._modelSets?.fleet ?? null;
    _retryFailedFleetModel(set, icao24, record);
    const displayPos = _modelDisplayPosition(icao24, position);
    if (displayPos) placeModel(record, displayPos, _modelHeading(course, meta));
    else showModel(record, false); // nowhere safe to draw it
    _send(set, icao24, record, _modelSpec(meta), out);
  }

  /**
   * Hand a contact just deselected back to the fleet in the same frame: to
   * its fleet model when one is loaded (kept while it was selected), placed
   * where its icon is and shown, else to its icon. Runs once the contact no
   * longer reads as tracked.
   * @param {string} icao24
   */
  function _handBackDeselected(icao24) {
    const icons = state._icons;
    const record = state._models.get(icao24);
    if (!icons?.has(icao24)) {
      if (record) _releaseModel(icao24);
      return;
    }
    if (!record) {
      icons.setShown(icao24, true);
      return;
    }
    const pose = _pose();
    if (!pose || !_modelRegimeActive(pose) || isTr3b(icao24)) {
      _releaseModel(icao24); // the icon takes it back
      return;
    }
    const t = parts.icons._displayMs();
    const position = icons.position(icao24, t);
    _driveFleetModelHandoff(
      icao24,
      record,
      position,
      icons.course(icao24, t),
      () =>
        _treatFleetModel(
          icao24,
          record,
          distance(pose.position, position),
          pose,
        ),
    );
  }

  /** A fleet model's tint and alpha this tick: the contact's colour, faded
   *  as its icon is (focus, recession), or the IR boost's full-strength
   *  white. */
  function _treatFleetModel(icao24, record, cameraDistanceM, pose) {
    const icons = state._icons;
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
  }

  /** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
   *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
   *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
   *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode).
   *
   *  The model draws exactly as the fleet would draw this contact: the same
   *  asset at the same scale (its true size) in the same colours; whether it
   *  draws at all is the fleet's rule too (`_trackedModelRegimeActive`).
   *  Selecting a contact changes neither its colour nor its size or form. */

  function _updateTrackedModel() {
    // A failed load is let go (the icon carries the contact); the budget
    // decides when, if ever, it is loaded again.
    if (state._trackedModel?.failedAt) _releaseTrackedModel();
    const active =
      state._trackedIcao &&
      parts.tracking._trackedModelRegimeActive() &&
      state._modelSets;
    if (!active) {
      _hideTrackedModel();
      _releaseTrackedFleetModel();
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
      _hideTrackedFleetModel();
      return;
    }
    const icao24 = state._trackedIcao;
    const meta = _metaOf(icao24);
    const spec = _modelSpec(meta);
    if (state._trackedModel && state._trackedModel.id !== icao24)
      _releaseTrackedModel();
    if (!state._trackedModel) {
      // The icon carries it: after the load budget is spent, or until the
      // fleet model set has loaded.
      if (!_trackedModelLoadAllowed() || !spec.url) {
        _hideTrackedFleetModel();
        return;
      }
      const record = createModelRecord({
        specKey: _specKeyFor(meta), // type-change sync compares against this
        bellyM: spec.bellyM,
        scale: spec.scale,
      });
      record.id = icao24;
      record.url = resolveAsset(spec.url);
      record.gltf = _gltfOf(spec);
      state._trackedModel = record;
    }
    const record = state._trackedModel;
    // The tracked aircraft uses the same dominant light tint as the fleet;
    // the IR boost removes the remaining diffuse hint with flat white. It
    // fades like the tracked billboard while the plane is stale.
    const base = state._irBoost ? WHITE : rgba(_modelColor(icao24));
    _treat(record, {
      base,
      alpha: parts.tracking._trackedStaleCue?.(icao24)?.dimmed
        ? policy.STALE_ALPHA
        : base[3],
    });
    // Placed while it loads too: its first drawn frame is at this placement.
    const displayPos = _modelDisplayPosition(icao24, pos);
    if (!displayPos) {
      _hideTrackedModel(); // no ground evidence → the icon carries it
      _hideTrackedFleetModel();
      return;
    }
    placeModel(
      record,
      displayPos,
      _modelHeading(parts.motion._trackedDisplayCourse(), meta),
    );
    _poseParts(record, meta, spec);
    showModel(record, record.ready);
    _send(state._modelSets.tracked, icao24, record, spec);
    if (record.ready) _hideTrackedFleetModel();
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
    // Every frame, shown or not: the tracked label's stale cue follows the
    // clock. (The tracked trail moves on in its own pass before each frame.)
    if (state._viewer) parts.tracking._staleCueTick?.();
    try {
      // Every frame too: the icons recede by the tuning as it is now, so a
      // change shows on the next frame, shown or not.
      parts.icons._syncRecede?.();
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
      // The pass's own error, if any, is the one that goes on.
      try {
        pace.set(_paceHz());
      } catch (error) {
        console.warn(`[${logLabel}] fleet pace failed`, error);
      }
    }
  }

  function _fleetPass() {
    const icons = state._icons;
    if (!state._viewer || !icons || !icons.show) return;
    // Following the world clock, the icons move on its time.
    parts.icons._syncMotionClock?.();
    const nowMs = focusNowMs(Date.now());

    if (nowMs - state._lastFleetTickMs < policy.FLEET_DR_INTERVAL_MS) return;
    state._lastFleetTickMs = nowMs;
    const pose = _pose();
    // Every contact in this pass shares the same delayed display instant.
    const t = parts.icons._displayMs();

    if (state._cockpitContactMode) parts.tracking._refreshCockpitNearContacts();
    parts.icons._syncImageSwitch();
    // Far and out-of-view contacts are planned for longer (the camera says
    // which are which).
    parts.icons._replanExpired(
      t,
      pose?.position
        ? { eye: pose.position, inView: (position) => inView(pose, position) }
        : null,
    );
    const renderTime = parts.motion._displayTimeAt(
      t,
      state._scratchFleetRenderTime,
    );
    afterReplan(renderTime, t, nowMs, pose?.position ?? null);
    const focusTarget = getFocusTarget();
    parts.icons._focusIcons(t, nowMs, focusTarget);
    // Airborne helicopters in view step their rotor frame (none: no work).
    if (parts.icons._rotorsTurning?.())
      parts.icons._turnRotors(
        Date.now(),
        t,
        pose ? (position) => inView(pose, position) : null,
      );

    // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
    // Drop all models the moment we leave it (toggled off / zoomed out) so icons resume.
    const useModels = _modelRegimeActive(pose);
    if (!useModels && state._models.size) _releaseModels();
    if (!useModels) {
      _setTrackedModelEligible(false);
      return;
    }

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
      // The tracked contact competes like any other (its model is drawn by
      // `_updateTrackedModel`), so selecting it never changes its form; in
      // cockpit it is the airframe you sit in, and takes no slot.
      if (icao === state._trackedIcao && state._cockpitContactMode) continue;
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
      isModeled: (icao) =>
        state._models.has(icao) ||
        (icao === state._trackedIcao && state._trackedModelEligible),
    });
    _setTrackedModelEligible(
      Boolean(state._trackedIcao) && modelEligible.has(state._trackedIcao),
    );
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
      if (
        icons.unseen?.(icao24) ||
        !parts.icons._aboveHorizon(position, occluder)
      ) {
        // A model that crossed the limb would keep drawing through the
        // hidden globe; the icon's own cull is on the GPU. A contact not
        // there yet at the time drawn is hidden as one beyond it.
        const hidden = state._models.get(icao24);
        if (hidden?.show) {
          showModel(hidden, false);
          _send(
            state._modelSets?.fleet,
            icao24,
            hidden,
            _modelSpec(_metaOf(icao24)),
            items,
          );
        }
        continue;
      }
      // The tracked contact draws as `_updateTrackedModel` says; its fleet
      // model is only kept ready for when it is deselected.
      if (icao24 === state._trackedIcao) {
        _keepTrackedFleetModel(
          icao24,
          position,
          icons.course(icao24, t),
          items,
        );
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
        () => _treatFleetModel(icao24, record, cameraDistanceM, pose),
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
    _handBackDeselected,
    _updateTrackedModel,
    _fleetTick,
    _paceHz,
    _startPace: () => {
      paceReadMs = -Infinity;
      pace.start();
    },
    _stopPace: pace.stop,
  };
}
