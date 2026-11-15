import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  AID_TO_NAVIGATION_STYLE,
  vesselTypeCss,
  vesselOverlayCohortLimit,
  VESSEL_OVERLAY_SOURCE_ID,
  applyVesselOverlayPolicy,
  VESSEL_CARD_FADE_DISTANCE_M,
} from '../../data/vesselLabels.js';
import {
  cameraPoseSignature,
  screenProjectedRotation,
} from '../../data/iconOrientation.js';
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
import { fixesMove, vesselPositionAt } from './motion.js';
import { TIMELINE_UNSEEN_MS } from '../../time/timelineFixes.js';
import {
  fleetModelSet,
  loadFleetModelSet,
  vesselModelSpec,
} from '../../data/fleetModels.js';
import { createFleetModelLayer } from '../../data/fleetModelInstances.js';
import { isAidToNavigation } from '../../data/vesselTypes.js';

/** A moving vessel's next frame is asked for once it would move this far on
 * screen (pixels), so it glides when it moves visibly and the scene idles
 * when it does not. */
const VESSEL_STEP_PX = 0.5;
/** A frame is asked for at least this often while any drawn vessel moves. */
const PLACEMENT_FRAME_MS = 1000;
/** How often vessels not drawn move on as the world clock plays (wall ms),
 * so one that comes into view is judged where it is. */
const HIDDEN_FOLLOW_MS = 250;

/** How often the vessels near enough for a model are gathered again (wall ms). */
const MODEL_CANDIDATES_MS = 500;

/** Scratch for where a moved vessel was drawn. */
const _movedFrom = new Cesium.Cartesian3();

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

  function prepareRecordVisual(record) {
    let visual = visualRecords.get(record);
    if (!visual) {
      visual = { billboard: record.billboard || null };
      visualRecords.set(record, visual);
    }
    // Following the world clock, a vessel is drawn where it was at the time;
    // live, where a host-supplied placement draws it, if one does.
    const { lat, lon } = followsClock(vesselState)
      ? vesselPositionAt(record, vesselState.worldNow())
      : (services.placement?.place(record.id, vesselState._aisRuntime.now()) ??
        record);
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(lat, lon),
      VESSEL_LIFT_M,
    );
    visual.position = Cesium.Cartesian3.fromDegrees(lon, lat, heightM);
    // A ship model's origin is its waterline: the sea surface, unlifted.
    visual.waterline = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      heightM - VESSEL_LIFT_M,
    );
    visual.surfacePosition = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    visual.normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      visual.position,
      new Cesium.Cartesian3(),
    );
    visual.drawnLat = lat;
    visual.drawnLon = lon;
    return visual;
  }

  /**
   * Move a prepared vessel visual to `lat`/`lon`, writing into its own
   * positions rather than allocating new ones: the placement pass runs for
   * every drawn vessel several times a second.
   */
  function moveRecordVisual(visual, lat, lon) {
    const heightM = components.queries.vesselDatumHeightM(
      components.tracking.currentGeoidN(lat, lon),
      VESSEL_LIFT_M,
    );
    const ellipsoid = Cesium.Ellipsoid.WGS84;
    Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      heightM,
      ellipsoid,
      visual.position,
    );
    Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      heightM - VESSEL_LIFT_M,
      ellipsoid,
      visual.waterline,
    );
    Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      0,
      ellipsoid,
      visual.surfacePosition,
    );
    ellipsoid.geodeticSurfaceNormal(visual.position, visual.normal);
    visual.drawnLat = lat;
    visual.drawnLon = lon;
  }

  function resetRecordVisuals() {
    visualRecords = new WeakMap();
  }

  const { registerSpriteCollection } = services.sprites;
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

  function ensureCollections(viewer) {
    ensureModels(viewer);
    if (!viewer || state.billboardCollection) return;
    state.billboardCollection = new Cesium.BillboardCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    state.billboardCollection.show = state.feed.enabled;
    viewer.scene.primitives.add(state.billboardCollection);
    registerSpriteCollection('ais', state.billboardCollection);
  }

  /**
   * Create the billboard primitive for a freshly added vessel record. Map labels
   * are canvas cards (vesselLabels.js) rebuilt by the declutter pass — no
   * per-record label primitive exists anymore.
   * @param {Object} record - Normalized vessel record.
   * @param {Cesium.EllipsoidalOccluder|null} occluder - Horizon occluder for initial visibility.
   */

  function addRecordPrimitives(record, occluder) {
    const visible =
      state.feed.enabled &&
      isVisible(getVisual(record).surfacePosition, occluder, record);
    getVisual(record).billboard = state.billboardCollection.add({
      position: getVisual(record).position,
      show: visible,
      image: shipIcon(record, false),
      scale: shipScale(record),
      // Screen-projected rotation lands on the next visibility/rotation pass.
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      // Locked height-datum principle #2: contacts are ALWAYS visible —
      // depth-test-free sprites; the EllipsoidalOccluder handles the far side.
      // (The tile sea mesh ≠ the geoid exactly, so a depth-tested chevron at
      // the geoid still clips out behind local tide/mesh noise.)
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: record,
    });
  }

  /**
   * Remove a record's billboard primitive from its collection.
   * @param {Object} record - Vessel record to tear down.
   */

  function removeRecordPrimitives(record) {
    if (!record) return;
    if (getVisual(record).billboard && state.billboardCollection) {
      forgetSpriteFocus(getVisual(record).billboard);
      state.billboardCollection.remove(getVisual(record).billboard);
    }
    getVisual(record).billboard = null;
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
   * Screen rotation is computed from this by the shared projected-rotation
   * pass in updateVisibility — never directly from the compass value. An aid
   * to navigation is fixed, so it has none.
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
   * The shape points north (up) so billboard rotation maps directly to heading.
   * An aid to navigation, which has no heading, is a ringed disc instead.
   * One icon is generated per color+variant and reused across all billboards.
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
  const modelOccluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);

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
   * Whether a vessel's chevron is drawn: on the camera's side of the Earth,
   * not the bridge camera's own vessel, and not drawn by its model. The
   * visibility pass and the model handoff both decide by this.
   */
  function billboardShown(record, occluder) {
    const visual = getVisual(record);
    return (
      isVisible(visual.surfacePosition, occluder, record) &&
      record.id !== state.cockpitSubjectId &&
      !visual.modelOwnsVisual
    );
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
      item = { record, pickId: record, tint: null, modelOwnsVisual: false };
    const specKey = `${record.type}|${record.mmsi}|${record.length}|${record.beam}|${record.name}`;
    if (item.specKey !== specKey) {
      item.specKey = specKey;
      item.spec = vesselModelSpec(set, record);
    }
    item.position = getVisual(record).waterline;
    // An aid to navigation is a fixed mark: it does not turn to a heading.
    item.headingDeg = item.spec?.fixed ? 0 : vesselCourseDeg(record);
    item.show = record.id !== state.cockpitSubjectId && seenYet(record);
    return item;
  }

  /** Gather the vessels within the models' keep radius of the camera into `into`. */
  function gatherModelItems(set, into) {
    const camera = state.viewer?.camera;
    if (!camera?.positionWC) return;
    const policy = services.fleet.policy;
    const keepM =
      services.fleet.display?.()?.models3dMode === 'all'
        ? policy.keepAllM
        : policy.keepM;
    const limitSq = keepM * keepM * 1.44;
    for (const record of state.records.all) {
      const waterline = getVisual(record).waterline;
      if (!waterline) continue;
      if (
        Cesium.Cartesian3.distanceSquared(camera.positionWC, waterline) >
        limitSq
      )
        continue;
      const item = modelItem(record, set);
      if (item) into.set(record.id, item);
    }
  }

  /** Give a vessel's chevron back when its model no longer draws it. */
  function handBackVisual(record, occluder) {
    const visual = getVisual(record);
    if (!visual.modelOwnsVisual) return;
    visual.modelOwnsVisual = false;
    if (visual.billboard)
      visual.billboard.show = billboardShown(record, occluder);
  }

  function updateModels() {
    if (!fleetModels) return;
    const camera = state.viewer?.camera;
    const occluder = camera?.positionWC ? modelOccluder : null;
    if (occluder) occluder.cameraPosition = camera.positionWC;
    if (!fleetModels.active()) {
      if (modelItems.size) {
        modelItems.clear();
        fleetModels.frame(modelItems, performance.now());
        for (const record of state.records.all)
          handBackVisual(record, occluder);
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
      if (next.get(id) !== item) handBackVisual(item.record, occluder);
    spareItems = modelItems;
    modelItems = next;
    fleetModels.frame(modelItems, now);
    for (const item of modelItems.values()) {
      const visual = getVisual(item.record);
      if (item.modelOwnsVisual) {
        visual.modelOwnsVisual = true;
        if (visual.billboard) visual.billboard.show = false;
      } else handBackVisual(item.record, occluder);
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

  // The layer does not hold the continuous render loop. Its passes run in
  // preRender, which idle mode fires only for rendered frames: moving vessels
  // ask for the frame that next moves them visibly (askMotionFrame), a forced
  // pass (new data, selection) requests its frame, a frame that moved the
  // camera but fell inside the 800 ms cadence leaves a trailing frame so the view the camera stopped on is always
  // evaluated, and the continuous hold is kept only while focus emphasis is
  // animating. The trailing frame is keyed to camera motion alone: the pass's
  // own label publication requests a frame, and scheduling on that would loop.
  function installRuntime(viewer) {
    if (state.preRenderRemover || !viewer) return;
    state.preRenderRemover = viewer.scene.preRender.addEventListener(() => {
      if (state.feed.enabled) {
        if (followsClock(vesselState)) followClockPositions();
        else if (services.placement) followPlacements();
      }
      updateVisibility();
      if (state.feed.enabled) updateModels();
    });
  }

  // As the world clock plays, vessels between two fixes move on along them:
  // drawn ones every frame, each once per world time, hidden ones (which may
  // come into view) every HIDDEN_FOLLOW_MS.
  let hiddenFollowedAtWallMs = -Infinity;
  function followClockPositions() {
    const atMs = vesselState.worldNow();
    const motion = startMotionPass();
    const moveHidden =
      motion.wallMs - hiddenFollowedAtWallMs >= HIDDEN_FOLLOW_MS;
    if (moveHidden) hiddenFollowedAtWallMs = motion.wallMs;
    for (const record of state.records.all) {
      if (!record.motion && !fixesMove(record.fixes)) continue;
      let visual = visualRecords.get(record);
      if (!visual?.position) {
        visual = prepareRecordVisual(record);
        visual.followedAtMs = atMs;
      } else {
        const drawn = visual.billboard?.show || visual.modelOwnsVisual;
        if (visual.followedAtMs === atMs || (!drawn && !moveHidden)) continue;
        visual.followedAtMs = atMs;
        const { lat, lon } = vesselPositionAt(record, atMs);
        // At either end of its fixes a vessel holds still.
        if (lat === visual.drawnLat && lon === visual.drawnLon) continue;
        moveDrawnVisual(visual, lat, lon, motion);
      }
      if (visual.billboard) visual.billboard.position = visual.position;
    }
    askMotionFrame(motion);
  }

  // Live with a host-supplied placement, vessels move on between refreshes:
  // drawn where it places them every frame, with the next frame asked for
  // as soon as a drawn vessel would move visibly, so they move while the
  // scene idles.
  function followPlacements() {
    const nowMs = vesselState._aisRuntime.now();
    const motion = startMotionPass();
    // Drawn vessels only, as a sprite or a model: a hidden one is placed
    // again when it is drawn.
    for (const record of state.records.all) {
      const visual = visualRecords.get(record);
      if (!visual?.position) continue;
      if (!visual.billboard?.show && !visual.modelOwnsVisual) continue;
      const placed = services.placement.place(record.id, nowMs);
      if (placed) motion.moving = true;
      const { lat, lon } = placed ?? record;
      if (lat === visual.drawnLat && lon === visual.drawnLon) continue;
      moveDrawnVisual(visual, lat, lon, motion);
      if (visual.billboard) visual.billboard.position = visual.position;
    }
    askMotionFrame(motion);
  }

  // One pass of moving vessels: whether any drawn vessel is moving, how far
  // the fastest moved (as an angle seen from the camera, radians, and in
  // metres), the pass's wall time and the wall time since the pass before.
  let motionPassWallMs = null;
  const motionPass = {
    camera: null,
    wallMs: 0,
    sinceMs: 0,
    moving: false,
    angle: 0,
    metres: 0,
  };
  function startMotionPass() {
    const wallMs = performance.now();
    motionPass.camera = state.viewer?.camera ?? null;
    motionPass.wallMs = wallMs;
    motionPass.sinceMs =
      motionPassWallMs === null ? 0 : wallMs - motionPassWallMs;
    motionPass.moving = false;
    motionPass.angle = 0;
    motionPass.metres = 0;
    motionPassWallMs = wallMs;
    return motionPass;
  }

  /** Move a drawn visual, noting how far it moved as seen from the camera. */
  function moveDrawnVisual(visual, lat, lon, motion) {
    const from = Cesium.Cartesian3.clone(visual.position, _movedFrom);
    moveRecordVisual(visual, lat, lon);
    if (!visual.billboard?.show && !visual.modelOwnsVisual) return;
    motion.moving = true;
    const metres = Cesium.Cartesian3.distance(from, visual.position);
    motion.metres = Math.max(motion.metres, metres);
    const eye = motion.camera?.positionWC;
    if (!eye) return;
    const distance = Cesium.Cartesian3.distance(eye, from);
    if (distance > 0) motion.angle = Math.max(motion.angle, metres / distance);
  }

  /** How far the fastest drawn vessel moved on screen in a pass (pixels):
   * through the perspective view's angle, or across the 2D view's width. */
  function movedPixels(motion) {
    const canvas = state.viewer?.canvas;
    const frustum = motion.camera?.frustum;
    if (!canvas || !frustum) return 0;
    if (frustum.fovy > 0 && canvas.clientHeight > 0)
      return (
        (motion.angle * canvas.clientHeight) / (2 * Math.tan(frustum.fovy / 2))
      );
    const width = frustum.right - frustum.left;
    if (!(frustum.fovy > 0) && width > 0 && canvas.clientWidth > 0)
      return (motion.metres * canvas.clientWidth) / width;
    return 0;
  }

  // The timer for the next vessel frame while one is asked for, and when it
  // is due (the AIS runtime's clock).
  let placementFrameTimer = null;
  let placementFrameDueMs = 0;
  /**
   * While a drawn vessel moves, ask for the next frame when the fastest one
   * will have moved VESSEL_STEP_PX on screen at the speed this pass saw, and
   * at most PLACEMENT_FRAME_MS away.
   */
  function askMotionFrame(motion) {
    if (!motion.moving) return;
    let waitMs = PLACEMENT_FRAME_MS;
    const movedPx = movedPixels(motion);
    if (movedPx > 0 && motion.sinceMs > 0)
      waitMs = Math.min(waitMs, (VESSEL_STEP_PX * motion.sinceMs) / movedPx);
    // A frame already asked for no later than this one stands.
    const runtime = vesselState._aisRuntime;
    const dueMs = runtime.now() + waitMs;
    if (placementFrameTimer !== null) {
      if (placementFrameDueMs <= dueMs) return;
      runtime.clearTimeout(placementFrameTimer);
    }
    placementFrameDueMs = dueMs;
    placementFrameTimer = runtime.setTimeout(() => {
      placementFrameTimer = null;
      if (state.feed.enabled) governorRequestRender('ais-vessels-placement');
    }, waitMs);
  }

  /** Stop asking for placement frames (the layer turned off or went away). */
  function cancelPlacementFrame() {
    motionPassWallMs = null;
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
    // Following the clock, the time drawn decides which vessels are there
    // yet: a time that moved since the last pass (a seek while paused) gets
    // its pass too.
    const worldMs = followsClock(vesselState) ? vesselState.worldNow() : null;
    if (
      !regularPass &&
      ((state.viewer?.camera &&
        cameraPoseSignature(state.viewer.camera) !==
          vesselState._lastCamPoseSig) ||
        worldMs !== state.visibilityWorldMs)
    )
      scheduleTrailingVisibilityPass(now);
    if (!regularPass && !focusPass) return;
    if (regularPass) {
      state.lastVisibilityUpdate = now;
      state.visibilityWorldMs = worldMs;
    }
    if (focusPass) state.lastFocusUpdate = now;
    if (!state.records.all.length) {
      // No records — flush any lingering card entries (vanished-feed case).
      // Still record the pose this pass evaluated, or every later frame that
      // falls inside the cadence would schedule another trailing frame.
      if (regularPass) {
        if (state.viewer?.camera)
          vesselState._lastCamPoseSig = cameraPoseSignature(
            state.viewer.camera,
          );
        updateClusteredLabels([]);
      }
      if (focusPass) {
        state.activeFocusCount = 0;
        releaseContinuousRender('ais-vessels');
      }
      return;
    }

    const scene = state.viewer?.scene;
    const camera = state.viewer?.camera;
    if (regularPass) {
      // Candidate construction stays on the original 800 ms selector cadence.
      // The 80 ms focus-only pass below never allocates label candidates.
      const poseSig = camera ? cameraPoseSignature(camera) : '';
      const doRotations = force || poseSig !== vesselState._lastCamPoseSig;
      if (doRotations) vesselState._lastCamPoseSig = poseSig;
      const occluder = makeOccluder();
      const labelCandidates = [];
      for (const record of state.records.all) {
        const visual = getVisual(record);
        const visible = isVisible(visual.surfacePosition, occluder, record);
        if (visual.billboard) {
          // The bridge camera sits on this sprite; showing it would fill the view.
          // The same rule as billboardShown, its horizon test already made.
          visual.billboard.show =
            visible &&
            record.id !== state.cockpitSubjectId &&
            !visual.modelOwnsVisual;
          // An aid's disc is never turned (vesselCourseDeg).
          if (visible && doRotations && scene && !isAidToNavigation(record)) {
            const rot = screenProjectedRotation(
              scene,
              visual.position,
              vesselCourseDeg(record),
              visual.billboard.rotation,
            );
            if (
              rot !== null &&
              Math.abs(rot - visual.billboard.rotation) > 0.002
            ) {
              visual.billboard.rotation = rot;
            }
          }
        }
        if (visible) labelCandidates.push(record);
      }
      updateClusteredLabels(labelCandidates);
    }
    if (focusPass && scene && camera) {
      const result = applyVesselFocusDeemphasis({
        records: state.records.all,
        target: focusTarget,
        previousActiveCount: state.activeFocusCount,
        nowMs: now,
        screenPositionFor: (position) =>
          Cesium.SceneTransforms.worldToWindowCoordinates(
            scene,
            position,
            vesselState._scratchFocusScreen,
          ),
        cameraDistanceFor: (position) =>
          Cesium.Cartesian3.distance(camera.positionWC, position),
      });
      state.activeFocusCount = result.activeCount;
      if (result.activeCount > 0 || result.transitioning)
        holdContinuousRender('ais-vessels');
      else releaseContinuousRender('ais-vessels');
    }
  }

  /**
   * Apply focus alpha to vessel sprites. Kept as a production wire seam so the
   * animation/deadband contract can be tested without constructing WebGL.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyVesselFocusDeemphasis({
    records,
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
      const bb = visual?.billboard;
      const position = bb?.position || visual?.position;
      if (!bb || !position) continue;
      // Most of a worldwide feed sits behind the horizon. A hidden sprite with
      // no pending focus state and full alpha would advance to exactly what it
      // already is, so skip it instead of paying its distance and state work
      // every 80 ms while anything is tracked.
      if (
        bb.show === false &&
        spriteFocusAtRest(bb) &&
        !focusAlphaNeedsWrite(bb.color?.alpha, 1, params)
      )
        continue;
      const focus = advanceSpriteFocus(bb, {
        // Hidden/far-side sprites still finish any pending release so the active
        // count remains truthful and they cannot reappear with stale dim alpha.
        screenPosition: bb.show === false ? null : screenPositionFor(position),
        cameraDistance: cameraDistanceFor(position),
        nowMs,
        target,
        params,
        // Vessel artwork is 32 px before billboard scale. Including the
        // ambient chevron's own rendered extent prevents edge-overlap misses.
        spriteHalfWidthPx: (bb.width || 32) * (bb.scale || 1) * 0.5,
        spriteHalfHeightPx: (bb.height || 32) * (bb.scale || 1) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      if (focusAlphaNeedsWrite(bb.color?.alpha, focus.factor, params)) {
        // Narrow always-visible amendment: the ship chevron remains present at
        // the non-zero floor while it competes with the tracked target. Preserve
        // the billboard's existing base RGB, matching the other layer patterns,
        // rather than repainting every chevron from a hard-coded WHITE base.
        const baseColor = bb.color || Cesium.Color.WHITE;
        bb.color = baseColor.withAlpha(focus.factor);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  function makeOccluder() {
    const cameraPosition = state.viewer?.camera?.positionWC;
    if (!cameraPosition) return null;
    return new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      cameraPosition,
    );
  }

  function isVisible(surfacePosition, occluder, record) {
    if (record && !seenYet(record)) return false;
    if (!surfacePosition || !occluder) return true;
    return occluder.isPointVisible(surfacePosition);
  }

  /** Whether a vessel is there at the time drawn: following the clock, not
   * more than TIMELINE_UNSEEN_MS before its first fix. */
  function seenYet(record) {
    const first = record.fixes?.[0];
    return (
      !first ||
      !followsClock(vesselState) ||
      vesselState.worldNow() >= first.atMs - TIMELINE_UNSEEN_MS
    );
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
    const scene = viewer?.scene;
    const selected = state.selectedRecord;
    // From the bridge, the selected vessel is the viewer; its card would be
    // pinned to the camera position.
    const selectedCarded = selected && selected.id !== state.cockpitSubjectId;
    const entries = selectedCarded
      ? [components.cards.buildSelectedVesselCard(selected)]
      : [];
    const maxLabels = labelRowLimit();

    if (!scene || !records.length || maxLabels <= 0) {
      state.activeLabelCount = entries.length;
      publishVesselOverlayEntries(entries);
      return;
    }

    const cells = new Map();
    for (const record of records) {
      const visual = getVisual(record);
      if (record === selected) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        visual.position,
      );
      if (!screen) continue;
      const key = `${Math.floor(screen.x / LABEL_GRID_PX)}:${Math.floor(screen.y / LABEL_GRID_PX)}`;
      const candidate = {
        record,
        score: labelPriority(record, selected),
        x: screen.x,
        y: screen.y,
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
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        getVisual(selected).billboard?.position || getVisual(selected).position,
      );
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
    const canvas = state.viewer?.scene?.canvas || state.viewer?.canvas;
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
    if (state.billboardCollection) {
      state.billboardCollection.show = show;
    }
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
    prepareRecordVisual,
    resetRecordVisuals,
    renderRowLimit,
    labelRowLimit,
    ensureCollections,
    addRecordPrimitives,
    removeRecordPrimitives,
    shipScale,
    vesselCourseDeg,
    shipIcon,
    installRuntime,
    updateVisibility,
    cancelTrailingVisibilityPass,
    cancelPlacementFrame,
    followPlacements,
    followClockPositions,
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
