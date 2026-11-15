import { t } from '../../i18n/index.js';
import {
  AID_TO_NAVIGATION_STYLE,
  vesselTypeCss,
  vesselOverlayCohortLimit,
  VESSEL_OVERLAY_SOURCE_ID,
  applyVesselOverlayPolicy,
  VESSEL_CARD_FADE_DISTANCE_M,
} from '../../data/vesselLabels.js';
import { fromDegrees, fromDegreesInto } from '../../geo/ellipsoid.js';
import { horizonFrom, liftedForHorizon } from '../../geo/horizon.js';
import { distance, distanceSquared } from '../../geo/vector.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import { poseSignature } from '../../render/camera/poseSignature.js';
import { createVesselIconBook } from './iconBook.js';
import {
  VESSEL_LIFT_M,
  DEFAULT_RENDER_ROWS,
  DEFAULT_ACTIVE_LABELS,
  VISIBILITY_UPDATE_MS,
  FOCUS_UPDATE_MS,
  LABEL_GRID_PX,
  CARD_MIN_SEP_PX,
  followsClock,
} from './policy.js';
import { vesselPositionAt } from './motion.js';
import {
  fleetModelSet,
  loadFleetModelSet,
  vesselModelSpec,
} from '../../data/fleetModels.js';
import { createFleetModelLayer } from '../../data/fleetModelInstances.js';
import { isAidToNavigation } from '../../data/vesselTypes.js';

/** How often vessels move on as the world clock plays (wall ms). */
const FOLLOW_POSITION_MS = 250;
/** A frame is asked for this often while a placement moves live vessels. */
const PLACEMENT_FRAME_MS = 1000;

/** The ship artwork's own raster size (px). */
const SHIP_ICON_PX = 32;

let instances = 0;

/** How often the vessels near enough for a model are gathered again (wall ms). */
const MODEL_CANDIDATES_MS = 500;

export function createRendering({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  let visualRecords = new WeakMap();

  // The fallback preserves helper calls with externally supplied render records.
  function getVisual(record) {
    return visualRecords.get(record) || record;
  }

  /** Where a record's icon is drawn: its row holds at the visual position. */
  function iconPosition(record) {
    return getVisual(record).position;
  }

  function prepareRecordVisual(record) {
    let visual = visualRecords.get(record);
    if (!visual) {
      // Unkeyed records (no id) are rebuilt every poll, so their rows take
      // a fresh id that no vessel id can collide with.
      visual = {
        iconId:
          record.id || `ais-unkeyed:${++vesselState._unkeyedIconSequence}`,
        visible: false,
      };
      visualRecords.set(record, visual);
    }
    const { lat, lon } = drawnAt(record);
    visual.position = anchorAt(lat, lon);
    // A ship model's origin is its waterline: the sea surface, unlifted.
    visual.waterline = anchorAt(lat, lon, 0);
    if (services.placement) {
      visual.drawnLat = lat;
      visual.drawnLon = lon;
    }
    return visual;
  }

  /**
   * Where a record is drawn now: following the world clock, where it was at
   * the time; live, where a host-supplied placement draws it, if one does.
   * @param {Object} record - Vessel record with a finite lat/lon.
   * @returns {{lat: number, lon: number}} A fresh pair (the placement's
   *   answer is reused by its next call).
   */
  function drawnAt(record) {
    const { lat, lon } = followsClock(vesselState)
      ? vesselPositionAt(record, vesselState.worldNow())
      : (services.placement?.place(record.id, vesselState._aisRuntime.now()) ??
        record);
    return { lat, lon };
  }

  /**
   * Where an icon at `lat`/`lon` is anchored: VESSEL_LIFT_M above the sea
   * surface (the geoid, once its grid has loaded).
   * @param {number} lat
   * @param {number} lon
   * @param {number} [liftM] Height above the sea surface (the icon's lift by
   *   default; 0 for a ship model's waterline).
   * @returns {{x: number, y: number, z: number}} ECEF metres: icon items,
   *   focus and the layer's queries take it as it is.
   */
  function anchorAt(lat, lon, liftM = VESSEL_LIFT_M) {
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(lat, lon),
      liftM,
    );
    return fromDegrees(lon, lat, heightM);
  }

  /**
   * Where a record's icon is anchored (see drawnAt and anchorAt).
   * @param {Object} record - Vessel record with a finite lat/lon.
   * @param {number} [liftM] Height above the sea surface.
   * @returns {{x: number, y: number, z: number}} ECEF metres.
   */
  function anchorPosition(record, liftM = VESSEL_LIFT_M) {
    const { lat, lon } = drawnAt(record);
    return anchorAt(lat, lon, liftM);
  }

  /**
   * Move a prepared vessel visual to `lat`/`lon` (a host-supplied placement
   * moved it), writing into its own positions rather than allocating new
   * ones: the placement pass runs for every drawn vessel several times a
   * second. Its icon is drawn there again.
   */
  function moveRecordVisual(record, visual, lat, lon) {
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(lat, lon),
      VESSEL_LIFT_M,
    );
    fromDegreesInto(lon, lat, heightM, visual.position);
    fromDegreesInto(lon, lat, heightM - VESSEL_LIFT_M, visual.waterline);
    visual.drawnLat = lat;
    visual.drawnLon = lon;
    syncRecordIcon(record);
  }

  // Reused projection buffers for the card pass, grown to the candidates.
  let worldXyz = new Float64Array(0);
  let screenXy = new Float32Array(0);

  function resetRecordVisuals() {
    visualRecords = new WeakMap();
  }

  const { spriteDrawOrder } = services.sprites;
  const {
    forgetSpriteFocus,
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
    spriteFocusAtRest,
  } = services.focus;
  const {
    holdContinuousRender,
    releaseContinuousRender,
    governorRequestRender,
  } = services.render;

  function renderRowLimit() {
    const configured = Number(options.maxRows);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(500, Math.min(50000, Math.round(configured)));
    }
    return DEFAULT_RENDER_ROWS;
  }

  function labelRowLimit() {
    const configured = Number(options.maxLabels);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.max(0, Math.min(renderRowLimit(), Math.round(configured)));
    }
    return Math.min(DEFAULT_ACTIVE_LABELS, renderRowLimit());
  }

  /**
   * The layer's icon draw set. Vessels hold still between polls, so each
   * item's motion is a hold at its anchor, turned along its course on screen.
   * The set draws over depth and culls the far side of the horizon, judged a
   * little above sea level (locked height-datum principle #2: contacts are
   * ALWAYS visible; the tile sea mesh ≠ the geoid, so a depth-tested chevron
   * at the geoid would clip behind local tide/mesh noise).
   */
  function ensureCollections(viewer) {
    ensureModels(viewer);
    if (!viewer || state.icons) return;
    const set = drawOf(viewer).icons({
      id: `ais-vessels:${++instances}`,
      // Translucent, as its billboards were: overlapping chevrons keep
      // their outlines rather than the first one's fill.
      blend: 'translucent',
      horizonCull: true,
      drawOrder: spriteDrawOrder?.('ais') ?? 0,
    });
    // Columns of no rows put the set's host in the scene now, rather than
    // with its first vessel.
    set.setColumns?.({ ids: [] });
    state.icons = createVesselIconBook(set);
    state.icons.show = state.feed.enabled;
  }

  /** Let the icon draw set go (the layer is destroyed). */
  function disposeCollections() {
    state.icons?.dispose();
    state.icons = null;
  }

  /** Whether the Cockpit's bridge camera rides this record's ship. */
  function isCockpitSubject(record) {
    return (
      Boolean(state.cockpitSubjectId) && record.id === state.cockpitSubjectId
    );
  }

  /**
   * Redraw the icons of the ship the bridge camera rode and the one it now
   * rides: the camera sits on the ridden ship's icon, which would fill the
   * view, so it is hidden while held.
   */
  function syncCockpitSubjectIcon() {
    const held = state.cockpitSubjectId || null;
    if (vesselState._iconHiddenId === held) return;
    const before = vesselState._iconHiddenId;
    vesselState._iconHiddenId = held;
    for (const id of [before, held]) {
      const record = id ? state.records.byId.get(id) : null;
      if (record) syncRecordIcon(record);
    }
  }

  /** The icon item a record draws, as it now is. */
  function iconItem(record, visual) {
    const selected = record === state.selectedRecord;
    const courseDeg = vesselCourseDeg(record);
    return {
      id: visual.iconId,
      // Hidden while the bridge camera rides it, or its model draws it.
      show: !isCockpitSubject(record) && !visual.modelOwnsVisual,
      pos: visual.position,
      image: shipIcon(record, selected),
      size: [SHIP_ICON_PX, SHIP_ICON_PX],
      // Selection changes the colour only, never the size.
      scale: shipScale(record),
      rotationMode: 'course',
      // Held on course; `course` for renderers without motion segments.
      course: courseDeg,
      motion: { kind: 'hold', courseDeg },
      focus: state.icons?.focus(visual.iconId) ?? 1,
      disableDepthTest: Infinity,
      meta: visual.meta,
    };
  }

  /**
   * Add a freshly added vessel record's icon row. Map labels are canvas cards
   * (vesselLabels.js) rebuilt by the declutter pass — no per-record label
   * primitive exists anymore.
   * @param {Object} record - Normalized vessel record.
   * @param {{isPointVisible: Function}|null} occluder - Horizon test for initial visibility.
   */

  function addRecordPrimitives(record, occluder) {
    const visual = getVisual(record);
    // The pick meta, and the key of the vessel's focus emphasis.
    visual.meta = { layer: 'ais-live-vessels', id: visual.iconId };
    state.icons.put({ ...iconItem(record, visual), focus: 1 });
    if (visual.position)
      visual.cullPosition = liftedForHorizon(visual.position);
    visual.visible = isVisible(visual.cullPosition, occluder);
  }

  /**
   * Draw a record's icon from its visual position, course, tint and
   * selection, and keep the point the renderer judges the horizon at
   * (`cullPosition`: lifted to a little above sea level, as a horizon-culled
   * GPU icon is) so the CPU card/focus pass draws the same boundary.
   * @param {Object} record - Vessel record with a prepared visual.
   */

  function syncRecordIcon(record) {
    const visual = getVisual(record);
    if (!state.icons?.has(visual.iconId) || !visual.position) return;
    state.icons.put(iconItem(record, visual));
    visual.cullPosition = liftedForHorizon(visual.position);
  }

  /**
   * Remove a record's icon row.
   * @param {Object} record - Vessel record to tear down.
   */

  function removeRecordPrimitives(record) {
    if (!record) return;
    const icons = state.icons;
    const visual = getVisual(record);
    if (!icons?.has(visual.iconId)) return;
    forgetSpriteFocus(icons.item(visual.iconId).meta);
    icons.remove(visual.iconId);
  }

  function shipScale(record) {
    const speed = Number(record.speed || 0);
    if (speed >= 18) return 0.78;
    if (speed >= 8) return 0.68;
    return 0.6;
  }

  /**
   * Best available real-world direction of travel for a vessel, degrees
   * clockwise from north (true heading preferred, course-over-ground fallback).
   * The renderer turns this into its screen rotation each frame. An aid to
   * navigation is fixed, so it has none.
   * @param {Object} record - Vessel record.
   * @returns {number} Course in degrees (0 when unknown).
   */

  function vesselCourseDeg(record) {
    if (isAidToNavigation(record)) return 0;
    const direction = record.heading ?? record.course;
    return Number.isFinite(direction) ? direction : 0;
  }

  /**
   * Build (and cache) a chevron/delta-wing SVG data URL tinted for the vessel.
   * The shape points north (up) so the row's course maps directly to heading.
   * An aid to navigation, which has no heading, is a ringed disc instead.
   * One icon is generated per color+variant and shares one atlas slot.
   * @param {Object} record - Vessel record (drives per-type tint).
   * @param {boolean} selected - True for the white/brighter selected variant.
   * @returns {string} SVG data URL.
   */

  function shipIcon(record, selected) {
    const aid = isAidToNavigation(record);
    const cssColor = selected
      ? '#ffffff'
      : aid
        ? AID_TO_NAVIGATION_STYLE.css
        : vesselTypeCss(record.type);
    const key = `${cssColor}:${selected ? 'selected' : 'normal'}:${aid ? 'aid' : 'ship'}`;
    if (vesselState.shipIconCache.has(key))
      return vesselState.shipIconCache.get(key);

    const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
    const strokeWidth = selected ? 1.1 : 0.7;
    const shape = aid
      ? `<circle r="8" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth * 2}"/>
      <circle r="3" fill="${stroke}"/>`
      : `<path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(16,16)">
      ${shape}
    </g>
  </svg>`;
    const icon = 'data:image/svg+xml;base64,' + btoa(svg);
    vesselState.shipIconCache.set(key, icon);
    return icon;
  }

  // Under the DISPLAY rail's 3D toggle, vessels near the camera are drawn as
  // the project's procedural fleet models at their reported length and beam,
  // on the aircraft layers' icon-to-model rules (services.fleet). The fleet
  // set loads once, up front, when the layer starts.
  let fleetModels = null;
  /** Items drawn last frame, and the map the next frame's are gathered into. */
  let modelItems = new Map();
  let spareItems = new Map();
  let modelCandidatesAtMs = -Infinity;

  function ensureModels(viewer) {
    const fleet = services.fleet;
    if (!viewer || fleetModels || !fleet?.policy) return;
    loadFleetModelSet({ resolveAsset: fleet.resolveAsset }).catch(() => {
      /* models stay off; vessels keep their icons */
    });
    fleetModels = createFleetModelLayer({
      viewer,
      display: fleet.display,
      policy: fleet.policy,
      resolveAsset: fleet.resolveAsset,
      // A hull below the waterline would show through a plain globe.
      waterline: true,
    });
  }

  /**
   * The model item for `record`, its spec rebuilt only when its type or size
   * changes; null for a virtual aid to navigation, which keeps its disc: no
   * buoy stands there (vesselModelSpec).
   */
  function modelItem(record, set) {
    if (record.virtual === true) return null;
    let item = modelItems.get(record.id);
    if (!item || item.record !== record)
      item = {
        record,
        pickId: getVisual(record).meta,
        tint: null,
        modelOwnsVisual: false,
      };
    const specKey = `${record.type}|${record.mmsi}|${record.length}|${record.beam}|${record.name}`;
    if (item.specKey !== specKey) {
      item.specKey = specKey;
      item.spec = vesselModelSpec(set, record);
    }
    item.position = getVisual(record).waterline;
    // An aid to navigation is a fixed mark: it does not turn to a heading.
    item.headingDeg = item.spec?.fixed ? 0 : vesselCourseDeg(record);
    item.show = record.id !== state.cockpitSubjectId;
    return item;
  }

  /** Gather the vessels within the models' keep radius of the camera into `into`. */
  function gatherModelItems(set, into) {
    const eye = state.viewer
      ? findCamera(state.viewer)?.pose()?.position
      : null;
    if (!eye) return;
    const policy = services.fleet.policy;
    const keepM =
      services.fleet.display?.()?.models3dMode === 'all'
        ? policy.keepAllM
        : policy.keepM;
    const limitSq = keepM * keepM * 1.44;
    for (const record of state.records.all) {
      const waterline = getVisual(record).waterline;
      if (!waterline) continue;
      if (distanceSquared(eye, waterline) > limitSq) continue;
      const item = modelItem(record, set);
      if (item) into.set(record.id, item);
    }
  }

  /** Give a vessel's chevron back when its model no longer draws it. */
  function handBackVisual(record) {
    const visual = getVisual(record);
    if (!visual.modelOwnsVisual) return;
    visual.modelOwnsVisual = false;
    syncRecordIcon(record);
  }

  function updateModels() {
    if (!fleetModels) return;
    if (!fleetModels.active()) {
      if (modelItems.size) {
        modelItems.clear();
        fleetModels.frame(modelItems, performance.now());
        for (const record of state.records.all) handBackVisual(record);
      }
      return;
    }
    const set = fleetModelSet();
    const now = performance.now();
    const next = spareItems;
    next.clear();
    if (now - modelCandidatesAtMs >= MODEL_CANDIDATES_MS) {
      modelCandidatesAtMs = now;
      gatherModelItems(set, next);
    } else {
      for (const [id, item] of modelItems)
        if (state.records.byId.get(id) === item.record) {
          const kept = modelItem(item.record, set);
          if (kept) next.set(id, kept);
        }
    }
    for (const [id, item] of modelItems)
      if (next.get(id) !== item) handBackVisual(item.record);
    spareItems = modelItems;
    modelItems = next;
    fleetModels.frame(modelItems, now);
    for (const item of modelItems.values()) {
      const visual = getVisual(item.record);
      if (item.modelOwnsVisual) {
        if (!visual.modelOwnsVisual) {
          visual.modelOwnsVisual = true;
          syncRecordIcon(item.record);
        }
      } else handBackVisual(item.record);
    }
    if (fleetModels.settling) governorRequestRender('ais-vessels-models');
  }

  function destroyModels() {
    fleetModels?.destroy();
    fleetModels = null;
    modelItems = new Map();
    spareItems = new Map();
    modelCandidatesAtMs = -Infinity;
  }

  // Vessels move only when a poll lands, so the layer does not hold the
  // continuous render loop. Its passes run in preRender, which idle mode fires
  // only for rendered frames: a forced pass (new data, selection) requests its
  // frame, a frame that moved the camera but fell inside the 800 ms cadence
  // leaves a trailing frame so the view the camera stopped on is always
  // evaluated, and the continuous hold is kept only while focus emphasis is
  // animating. The trailing frame is keyed to camera motion alone: the pass's
  // own label publication requests a frame, and scheduling on that would loop.
  function installRuntime(viewer) {
    if (state.preRenderRemover || !viewer) return;
    state.preRenderRemover =
      findFrame(viewer)?.on('preRender', () => {
        if (followsClock(vesselState)) followClockPositions();
        else if (services.placement && state.feed.enabled) followPlacements();
        updateVisibility();
        if (state.feed.enabled) updateModels();
      }) ?? null;
  }

  // As the world clock plays, vessels between two fixes move on along them.
  let followedAtWallMs = -Infinity;
  let followedAtMs = null;
  function followClockPositions() {
    const wallMs = performance.now();
    if (wallMs - followedAtWallMs < FOLLOW_POSITION_MS) return;
    followedAtWallMs = wallMs;
    const atMs = vesselState.worldNow();
    if (atMs === followedAtMs) return;
    followedAtMs = atMs;
    for (const record of state.records.all) {
      if (!record.motion) continue;
      prepareRecordVisual(record);
      syncRecordIcon(record);
    }
  }

  // Live with a host-supplied placement, vessels move on between refreshes:
  // drawn where it places them at most every FOLLOW_POSITION_MS, with a frame
  // asked for every PLACEMENT_FRAME_MS while it places any drawn vessel, so
  // they move while the scene idles.
  let placedAtWallMs = -Infinity;
  let placing = false;
  let placementFrameTimer = null;
  function followPlacements() {
    const wallMs = performance.now();
    if (wallMs - placedAtWallMs >= FOLLOW_POSITION_MS) {
      placedAtWallMs = wallMs;
      placing = false;
      const nowMs = vesselState._aisRuntime.now();
      // Drawn vessels only, as a sprite or a model: a hidden one is placed
      // again when it is drawn.
      for (const record of state.records.all) {
        const visual = visualRecords.get(record);
        if (!visual?.position) continue;
        const drawn =
          (visual.visible && !isCockpitSubject(record)) ||
          visual.modelOwnsVisual;
        if (!drawn) continue;
        const placed = services.placement.place(record.id, nowMs);
        if (placed) placing = true;
        const { lat, lon } = placed ?? record;
        if (lat === visual.drawnLat && lon === visual.drawnLon) continue;
        moveRecordVisual(record, visual, lat, lon);
      }
    }
    if (placing && placementFrameTimer === null)
      placementFrameTimer = vesselState._aisRuntime.setTimeout(() => {
        placementFrameTimer = null;
        if (state.feed.enabled && !followsClock(vesselState))
          governorRequestRender('ais-vessels-placement');
      }, PLACEMENT_FRAME_MS);
  }

  /** Stop asking for placement frames (the layer turned off or went away). */
  function cancelPlacementFrame() {
    placedAtWallMs = -Infinity;
    placing = false;
    if (placementFrameTimer === null) return;
    vesselState._aisRuntime.clearTimeout(placementFrameTimer);
    placementFrameTimer = null;
  }

  function scheduleTrailingVisibilityPass(now) {
    if (state.trailingVisibilityTimer) return;
    const waitMs = Math.max(
      0,
      VISIBILITY_UPDATE_MS - (now - state.lastVisibilityUpdate),
    );
    state.trailingVisibilityTimer = vesselState._aisRuntime.setTimeout(() => {
      state.trailingVisibilityTimer = null;
      if (state.feed.enabled) governorRequestRender('ais-vessels-visibility');
    }, waitMs);
  }

  function cancelTrailingVisibilityPass() {
    if (!state.trailingVisibilityTimer) return;
    vesselState._aisRuntime.clearTimeout(state.trailingVisibilityTimer);
    state.trailingVisibilityTimer = null;
  }

  function updateVisibility(force = false) {
    if (!state.feed.enabled) return;
    if (force) governorRequestRender('ais-vessels-update');
    const now = focusNowMs(performance.now());
    const focusTarget = getFocusTarget();
    const regularPass =
      force || now - state.lastVisibilityUpdate >= VISIBILITY_UPDATE_MS;
    const focusPass =
      focusPassIsNeeded(focusTarget, state.activeFocusCount) &&
      (force || now - state.lastFocusUpdate >= FOCUS_UPDATE_MS);
    // The pose is read only when a pass runs or a moved camera could still
    // need its trailing pass: most frames fall inside the cadence with one
    // already waiting.
    const pose =
      state.viewer &&
      (regularPass || focusPass || !state.trailingVisibilityTimer)
        ? findCamera(state.viewer)?.pose()
        : null;
    if (
      !regularPass &&
      pose &&
      poseSignature(pose) !== vesselState._lastCamPoseSig
    )
      scheduleTrailingVisibilityPass(now);
    if (!regularPass && !focusPass) return;
    if (regularPass) state.lastVisibilityUpdate = now;
    if (focusPass) state.lastFocusUpdate = now;
    if (!state.records.all.length) {
      // No records — flush any lingering card entries (vanished-feed case).
      // Still record the pose this pass evaluated, or every later frame that
      // falls inside the cadence would schedule another trailing frame.
      if (regularPass) {
        if (pose) vesselState._lastCamPoseSig = poseSignature(pose);
        updateClusteredLabels([]);
      }
      if (focusPass) {
        state.activeFocusCount = 0;
        releaseContinuousRender('ais-vessels');
      }
      return;
    }

    const query = state.viewer ? findQuery(state.viewer) : null;
    syncCockpitSubjectIcon();
    if (regularPass) {
      // Candidate construction stays on the original 800 ms selector cadence.
      // The 80 ms focus-only pass below never allocates label candidates.
      // Icons cull and rotate on the GPU; this pass only picks the cards and
      // remembers which vessels the horizon leaves in view for focus.
      if (pose) vesselState._lastCamPoseSig = poseSignature(pose);
      const occluder = makeOccluder(pose);
      const labelCandidates = [];
      for (const record of state.records.all) {
        const visual = getVisual(record);
        visual.visible = isVisible(visual.cullPosition, occluder);
        if (visual.visible) labelCandidates.push(record);
      }
      updateClusteredLabels(labelCandidates);
    }
    if (focusPass && query && pose) {
      const result = applyVesselFocusDeemphasis({
        records: state.records.all,
        target: focusTarget,
        previousActiveCount: state.activeFocusCount,
        nowMs: now,
        screenPositionFor: (position) => query.project(position),
        cameraDistanceFor: (position) => distance(pose.position, position),
      });
      state.activeFocusCount = result.activeCount;
      if (result.activeCount > 0 || result.transitioning)
        holdContinuousRender('ais-vessels');
      else releaseContinuousRender('ais-vessels');
    }
  }

  /**
   * Apply focus emphasis to vessel icons through their items' `focus`
   * (narrow always-visible amendment: the ship chevron remains present at the
   * non-zero floor while it competes with the tracked target). Kept as a
   * production wire seam so the animation/deadband contract can be tested
   * without a renderer.
   * @param {object} input
   * @param {object} [input.icons] The icon book (defaults to the layer's).
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyVesselFocusDeemphasis({
    records,
    icons = state.icons,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const record of records || []) {
      const visual = getVisual(record);
      const id = visual?.iconId;
      const item = icons?.item(id);
      const position = visual?.position;
      if (!item || !position) continue;
      const sprite = item.meta;
      // Most of a worldwide feed sits behind the horizon. A hidden icon with
      // no pending focus state at full emphasis would advance to exactly what
      // it already is, so skip it instead of paying its distance and state
      // work every 80 ms while anything is tracked.
      if (
        !visual.visible &&
        spriteFocusAtRest(sprite) &&
        !focusAlphaNeedsWrite(icons.focus(id), 1, params)
      )
        continue;
      const focus = advanceSpriteFocus(sprite, {
        // Hidden/far-side icons still finish any pending release so the active
        // count remains truthful and they cannot reappear with stale dim alpha.
        screenPosition: visual.visible ? screenPositionFor(position) : null,
        cameraDistance: cameraDistanceFor(position),
        nowMs,
        target,
        params,
        // Vessel artwork is 32 px before scale. Including the ambient
        // chevron's own rendered extent prevents edge-overlap misses.
        spriteHalfWidthPx: item.size[0] * (item.scale ?? 1) * 0.5,
        spriteHalfHeightPx: item.size[1] * (item.scale ?? 1) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      if (focusAlphaNeedsWrite(icons.focus(id), focus.factor, params)) {
        icons.setFocus(id, focus.factor);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  /** The ellipsoid's horizon from the eye, or null with no camera. */
  function makeOccluder(
    pose = state.viewer ? findCamera(state.viewer)?.pose() : null,
  ) {
    return pose?.position ? horizonFrom(pose.position) : null;
  }

  function isVisible(cullPosition, occluder) {
    if (!cullPosition || !occluder) return true;
    return occluder.isPointVisible(cullPosition);
  }

  /**
   * Source selector for the shared world-overlay pipeline: the
   * grid declutter picks which vessels get cards — one winner per screen-space
   * grid cell, priority-ranked, capped — and publishes presentation entries to
   * the host, which owns projection, final placement, fade and paint. Runs on the
   * throttled visibility pass and forced refreshes, never per frame. The
   * selected vessel always gets its full-detail card, even when horizon-culled
   * from the ambient candidates; its protected entry bypasses ambient quotas.
   * @param {Array<Object>} records - Horizon-visible vessel records.
   */

  function updateClusteredLabels(records) {
    const viewer = state.viewer;
    const query = viewer ? findQuery(viewer) : null;
    const selected = state.selectedRecord;
    // From the bridge, the selected vessel is the viewer; its card would be
    // pinned to the camera position.
    const selectedCarded = selected && selected.id !== state.cockpitSubjectId;
    const entries = selectedCarded
      ? [components.cards.buildSelectedVesselCard(selected)]
      : [];
    const maxLabels = labelRowLimit();

    if (!query || !records.length || maxLabels <= 0) {
      state.activeLabelCount = entries.length;
      publishVesselOverlayEntries(entries);
      return;
    }

    // Every candidate projected in one call: NaN behind the eye.
    const ambient = records.filter((record) => record !== selected);
    if (worldXyz.length < ambient.length * 3) {
      worldXyz = new Float64Array(ambient.length * 3);
      screenXy = new Float32Array(ambient.length * 2);
    }
    ambient.forEach((record, i) => {
      const p = getVisual(record).position;
      worldXyz[i * 3] = p.x;
      worldXyz[i * 3 + 1] = p.y;
      worldXyz[i * 3 + 2] = p.z;
    });
    query.projectMany(
      worldXyz.subarray(0, ambient.length * 3),
      screenXy.subarray(0, ambient.length * 2),
    );
    const cells = new Map();
    for (let i = 0; i < ambient.length; i++) {
      const record = ambient[i];
      const x = screenXy[i * 2];
      const y = screenXy[i * 2 + 1];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const key = `${Math.floor(x / LABEL_GRID_PX)}:${Math.floor(y / LABEL_GRID_PX)}`;
      const candidate = {
        record,
        score: labelPriority(record, selected),
        x,
        y,
      };
      const existing = cells.get(key);
      if (!existing || candidate.score > existing.score) {
        cells.set(key, candidate);
      }
    }

    // Greedy min-separation pass over the priority-ranked cell winners: the
    // selected card's anchor seeds the accepted set so ambient cards keep clear.
    const accepted = [];
    if (selectedCarded) {
      const screen = query.project(iconPosition(selected));
      if (screen) accepted.push({ x: screen.x, y: screen.y });
    }
    const ranked = [...cells.values()].sort((a, b) => b.score - a.score);
    for (const candidate of ranked) {
      if (entries.length >= maxLabels) break;
      if (
        !components.cards.cardScreenSeparated(
          accepted,
          candidate,
          CARD_MIN_SEP_PX,
        )
      )
        continue;
      accepted.push({ x: candidate.x, y: candidate.y });
      entries.push(components.cards.buildVesselCard(candidate.record));
    }
    state.activeLabelCount = entries.length;
    publishVesselOverlayEntries(entries);
  }

  /**
   * Publish a complete, bounded source snapshot to the shared host. The source
   * selector remains authoritative for the 118 px grid and 150 px separation;
   * the host then composes this demand with sibling ambient-card sources.
   * @param {Object[]} entries Formatted vessel card entries.
   */

  function publishVesselOverlayEntries(entries) {
    const canvas = canvasOf(state.viewer);
    const width = Number(canvas?.clientWidth) || 0;
    const height = Number(canvas?.clientHeight) || 0;
    const ambientLimit = vesselOverlayCohortLimit(
      width,
      height,
      labelRowLimit(),
    );
    vesselState._vesselOverlayHost.setEntries(
      VESSEL_OVERLAY_SOURCE_ID,
      entries.map((entry) => {
        const card = applyVesselOverlayPolicy(
          entry,
          VESSEL_CARD_FADE_DISTANCE_M,
        );
        if (!card.interactive) return card;
        const id = String(card.id || '').startsWith('vessel:')
          ? card.id.slice('vessel:'.length)
          : '';
        const mmsi = state.records.byId.get(id)?.mmsi || '';
        return {
          ...card,
          accessibilityLabel: mmsi
            ? t('Focus vessel {name}, MMSI {mmsi}', { name: card.title, mmsi })
            : t('Focus {label}', { label: card.title }),
          activate: () => {
            const record = state.records.byId.get(id);
            if (!record) return false;
            components.selection.selectAndFocusVessel(record);
            return true;
          },
        };
      }),
      {
        cohortLimit: Math.max(1, ambientLimit),
        collisionCapacity: ambientLimit,
        moving: false,
      },
    );
  }

  function labelPriority(record, selected) {
    if (record === selected) return 100000;
    let score = 0;
    if (hasUsefulName(record)) score += 1000;
    if (record.speed !== null)
      score += Math.min(400, Math.max(0, record.speed) * 20);
    if (record.heading !== null || record.course !== null) score += 80;
    if (record.type) score += 40;
    return score;
  }

  function hasUsefulName(record) {
    const text = String(record.name || '').trim();
    return Boolean(
      text &&
      text !== 'VESSEL' &&
      !/^MMSI\s*\d+$/i.test(text) &&
      text !== record.mmsi &&
      text !== record.id,
    );
  }

  function setVisible(show) {
    if (state.icons) state.icons.show = show;
    fleetModels?.setVisible(show);
    if (!show && fleetModels) {
      fleetModels.clear();
      for (const item of modelItems.values())
        getVisual(item.record).modelOwnsVisual = false;
      modelItems.clear();
    }
    vesselState._vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, show);
  }
  return {
    getVisual,
    iconPosition,
    prepareRecordVisual,
    anchorPosition,
    resetRecordVisuals,
    renderRowLimit,
    labelRowLimit,
    ensureCollections,
    disposeCollections,
    addRecordPrimitives,
    syncRecordIcon,
    removeRecordPrimitives,
    shipScale,
    vesselCourseDeg,
    shipIcon,
    installRuntime,
    updateVisibility,
    cancelTrailingVisibilityPass,
    cancelPlacementFrame,
    followPlacements,
    applyVesselFocusDeemphasis,
    makeOccluder,
    isVisible,
    updateClusteredLabels,
    publishVesselOverlayEntries,
    labelPriority,
    hasUsefulName,
    setVisible,
    updateModels,
    destroyModels,
  };
}
