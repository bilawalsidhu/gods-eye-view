import { bindOverlayHost } from '../../../overlays/bindOverlayHost.js';
// The datacenters and dams on the globe contract (engine.movers,
// engine.lines, engine.ground, engine.surface), the same on every engine.
// Each point or polygon feature has a reference:
// - a 10 px tip disc in the layer colour with a 2 px black outline, drawn
//   over the scene, about 65 px above the feature's base;
// - a 3.5 px stem in the layer colour from the base to the tip, hidden by
//   the scene;
// - for a Point feature, a disc of the 8 px GeoJSON pin's width at the base.
// Polygon footprints are one engine.ground polygon set in the layer colour
// at 0.3, without an outline (Cesium draws none on a clamped polygon); line
// features are one engine.ground corridor set, 2 px in the layer colour.
// The camera-height LOD (src/data/localGeojsonLod.js) picks the references
// and footprints that draw; it runs again after a camera move, and during
// continuous motion on its probe window. Once the camera is within 75 km and
// the ground under a reference is in view, the base moves onto the sampled
// surface. The references' cards go to the shared world-overlay host. A
// click on any of them selects the feature and flies there.

import * as geo from '../../../geo/index.js';
import { isPointerFree } from '../../../data/inputOwnership.js';
import {
  applyInfraEvictionGrace,
  selectInfraLod,
  shouldRecomputeInfraLod,
} from '../../../data/localGeojsonLod.js';
import {
  LOCAL_OVERLAY_COHORT_LIMIT,
  createLocalInfrastructureOverlayEntry,
  createLocalInfrastructureOverlayPublisher,
  labelPriorityFromProperties,
  localInfrastructureOverlayCopy,
  selectLocalInfrastructureOverlayCohort,
} from '../../../data/localGeojsonCore.js';
import { rgbaFromCss } from '../../shared/color.js';

const DEFAULT_LABEL_MAX = 900;
const DEFAULT_LABEL_GRID_PX = 132;
/** The reference walk runs at most this often. */
export const WALK_INTERVAL_MS = 450;
const TIP_PX = 10;
const TIP_OUTLINE_PX = 2;
const STEM_PX = 3.5;
// The 8 px GeoJSON pin is about 5 px wide.
const PIN_PX = 5;
const FOOTPRINT_ALPHA = 0.3;
const LINE_PX = 2;
// The tip stands this many pixels above the base.
const STEM_TARGET_PX = 65;
// Before the first walk sizes it.
const INITIAL_TIP_M = 2000;
const FLY_HEIGHT_M = 5000;
const FLY_SECONDS = 1.5;
/**
 * The base starts on the ellipsoid. High features (dams in river canyons)
 * sit hundreds of metres above it, which buries a short close-in stem, so
 * once the camera is this near the surface height under each base is
 * sampled once and the base moves onto it.
 */
export const GROUND_SAMPLE_MAX_DISTANCE_M = 75000;
export const GROUND_SAMPLE_RETRY_MS = 2000;
const GROUND_SAMPLE_MAX_ABS_HEIGHT_M = 9000;
/**
 * A sampleable scene can still never answer under a feature; each retry
 * asks for the frame the next one needs, so after this many armed retries
 * without a newly grounded base the layer stops asking. A camera move, a
 * grounded base or sampling becoming supported again re-opens the budget.
 * 30 × 2 s is far longer than a tile stream-in.
 */
export const GROUND_SAMPLE_MAX_ARMED_RETRIES = 30;
/** Tip moves below this are camera noise and are not drawn. */
export const LOCAL_STEM_TIP_EPSILON_M = 0.5;
const TIP_EPSILON_SQ = LOCAL_STEM_TIP_EPSILON_M ** 2;

const finite = (value) => Number.isFinite(value);
const lonLat = (position) => [position[0], position[1]];

/**
 * Cesium's PerspectiveFrustum.fov: the horizontal angle on a wide canvas,
 * the vertical one on a tall canvas (what the stem sizing reads).
 */
function frustumFov({ fovy, aspectRatio }) {
  const aspect = aspectRatio ?? 1;
  return aspect > 1 ? 2 * Math.atan(Math.tan(fovy / 2) * aspect) : fovy;
}

/**
 * The datacenter or dam display: `{ show(dataset), select(featureId),
 * hide(), destroy(), lod() }`. `dataset` is the session's
 * `{ features, records }` (src/layers/infrastructure/index.js).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ config: object, services: object }} options The layer's
 *   descriptor (src/data/infrastructure.js) and the application operations
 *   (docs/INFRASTRUCTURE-LAYERS.md).
 */
export function createInfrastructureDisplay(
  engine,
  { config, services = {} } = {},
) {
  services = {
    ...services,
    ...(services.context?.forEngine?.(engine) ?? services.context),
  };
  if (!engine?.movers || !engine?.lines || !engine?.ground)
    throw new TypeError('The infrastructure display needs a globe engine');
  const {
    id,
    name,
    source,
    color,
    osmDerived = false,
    labels = true,
    labelMax = DEFAULT_LABEL_MAX,
    labelGridPx = DEFAULT_LABEL_GRID_PX,
  } = config;
  const css = rgbaFromCss(color);
  const rgba = css.rgba();
  const footprintFill = [css.red, css.green, css.blue, FOOTPRINT_ALPHA];
  const publisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: bindOverlayHost(services.overlayHost, () => engine),
  });
  const key = (featureId) => `${id}:${featureId}`;
  const wake = (reason = id) => engine.render.request(reason);

  // Records in dataset order (their tip index), by feature id.
  const rows = new Map();
  // Line features by id, for clicks.
  const lineFeatures = new Map();
  // Drawn object ids (sets and lines) whose picks are this layer's.
  const owners = new Set();
  // record id → its stem, while the record is drawn.
  const stems = new Map();
  const removers = [];
  let dataset = null,
    tips = null,
    pins = null,
    footprints = null,
    corridors = null,
    exclude = [],
    destroyed = false;
  // The LOD selection.
  let active = new Set(),
    grace = new Map(),
    budget = 0,
    computed = false,
    topology = null,
    lastProbeMs = Number.NEGATIVE_INFINITY;
  const lastLodCamera = geo.cartesian3.create();
  // The walk.
  let dirty = true,
    lastWalk = Number.NEGATIVE_INFINITY,
    walkCount = 0;
  // The ground-sample retry.
  let retryTimer = null,
    retryArms = 0,
    lastCapability = null;
  // Per walk: the view-projection matrix, computed on first use.
  const viewProjection = geo.matrix4.create();
  let viewProjectionWalk = -1;
  const scratchCarto = geo.cartographic.create(0, 0, 0);
  const scratchLow = geo.cartesian3.create();
  const scratchHigh = geo.cartesian3.create();
  const scratchWindow = geo.cartesian2.create(0, 0);

  const photoreal = () => engine.maps?.photorealActive?.() === true;

  function scheduleGroundRetry() {
    if (retryTimer || !dataset || !engine.surface.supported) return;
    if (retryArms >= GROUND_SAMPLE_MAX_ARMED_RETRIES) return;
    retryArms += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (dataset && !destroyed) wake(`local-ground-retry:${id}`);
    }, GROUND_SAMPLE_RETRY_MS);
  }

  function clearGroundRetry() {
    retryArms = 0;
    lastCapability = null;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** The record's vertical at `height` metres above the ellipsoid. */
  function vertical(row, height, result) {
    scratchCarto.longitude = row.carto.longitude;
    scratchCarto.latitude = row.carto.latitude;
    scratchCarto.height = height;
    return geo.cartographic.toCartesian(scratchCarto, undefined, result);
  }

  // Whether both points are outside one side of the view frustum: the
  // clip-space tests x ≥ -w, x ≤ w, y ≥ -w, y ≤ w and w ≥ 0 (in front of
  // the camera), each linear in the world position.
  function bothOutside(low, high) {
    if (viewProjectionWalk !== walkCount) {
      engine.projector.viewProjection(viewProjection);
      viewProjectionWalk = walkCount;
    }
    const m = viewProjection;
    const ax = m[0] * low.x + m[4] * low.y + m[8] * low.z + m[12];
    const ay = m[1] * low.x + m[5] * low.y + m[9] * low.z + m[13];
    const aw = m[3] * low.x + m[7] * low.y + m[11] * low.z + m[15];
    const bx = m[0] * high.x + m[4] * high.y + m[8] * high.z + m[12];
    const by = m[1] * high.x + m[5] * high.y + m[9] * high.z + m[13];
    const bw = m[3] * high.x + m[7] * high.y + m[11] * high.z + m[15];
    return (
      (ax + aw < 0 && bx + bw < 0) ||
      (aw - ax < 0 && bw - bx < 0) ||
      (ay + aw < 0 && by + bw < 0) ||
      (aw - ay < 0 && bw - by < 0) ||
      (aw < 0 && bw < 0)
    );
  }

  /**
   * Whether the camera sees the ground under the record: inside the view
   * frustum and above the horizon. A sample of unseen ground passes through
   * the Earth (about -6,344 km near Ashburn on Esri) and fails on every
   * retry, each one a full offscreen render on Cesium. Unsampled bases sit
   * on the ellipsoid, so the test uses the terrain height when there is one
   * (not under photoreal tiles, which hide the globe); otherwise it tests
   * the vertical across ±GROUND_SAMPLE_MAX_ABS_HEIGHT_M, every height a
   * sample can accept.
   */
  function groundInView(row) {
    const terrain = photoreal()
      ? undefined
      : engine.surface.terrainHeight(row.carto);
    const known =
      finite(terrain) && Math.abs(terrain) <= GROUND_SAMPLE_MAX_ABS_HEIGHT_M;
    const low = vertical(
      row,
      known ? terrain : -GROUND_SAMPLE_MAX_ABS_HEIGHT_M,
      scratchLow,
    );
    const high = known
      ? low
      : vertical(row, GROUND_SAMPLE_MAX_ABS_HEIGHT_M, scratchHigh);
    if (bothOutside(low, high)) return false;
    // The horizon hides every point below the ellipsoid from a camera near
    // it, so ground below 0 m is tested at 0 m; unknown ground at the top
    // of the vertical.
    const horizonHeight = known
      ? Math.max(terrain, 0)
      : GROUND_SAMPLE_MAX_ABS_HEIGHT_M;
    return engine.projector.horizonVisible(
      vertical(row, horizonHeight, scratchHigh),
    );
  }

  function setGroundHeight(row, height) {
    row.groundHeight = height;
    geo.cartesian3.fromRadians(
      row.carto.longitude,
      row.carto.latitude,
      height,
      undefined,
      row.base,
    );
    row.baseMoved = true;
  }

  // The scene height under the record, once, while the visible surface has
  // loaded. A coarse sample can lie below the loaded terrain: the terrain is
  // the floor then (not under photoreal tiles), while roofs and valid
  // below-sea-level heights stay.
  function sampleGround(row, now) {
    if (row.groundSampled || !engine.surface.supported) return false;
    if (now - row.lastSample < GROUND_SAMPLE_RETRY_MS) return false;
    if (!groundInView(row)) return false;
    row.lastSample = now;
    const globe = !photoreal();
    if (globe && !engine.surface.tilesLoaded()) return false;
    // The stem stands on the sample point: out of the sample.
    const stem = stems.get(row.id);
    stem?.line.show(false);
    let sampled;
    try {
      sampled = engine.surface.sampleHeight(row.carto, exclude);
    } finally {
      stem?.line.show(true);
    }
    if (!finite(sampled) || Math.abs(sampled) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M)
      return false;
    const terrain = globe ? engine.surface.terrainHeight(row.carto) : undefined;
    if (finite(terrain) && Math.abs(terrain) <= GROUND_SAMPLE_MAX_ABS_HEIGHT_M)
      sampled = Math.max(sampled, terrain);
    row.groundSampled = true;
    setGroundHeight(row, sampled);
    return true;
  }

  // A sampled base follows refined terrain upward on the bounded walks,
  // without another sample.
  function refreshTerrainFloor(row, camera) {
    if (!row.groundSampled || photoreal() || !engine.surface.tilesLoaded())
      return false;
    if (
      geo.cartesian3.distance(camera, row.base) >= GROUND_SAMPLE_MAX_DISTANCE_M
    )
      return false;
    const height = engine.surface.terrainHeight(row.carto);
    if (
      !finite(height) ||
      Math.abs(height) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M ||
      height <= row.groundHeight
    )
      return false;
    setGroundHeight(row, height);
    return true;
  }

  // The tip STEM_TARGET_PX above the base at the camera's distance; a move
  // under LOCAL_STEM_TIP_EPSILON_M is not drawn.
  function sizeStem(row, now, pose, view, knownDistance = null) {
    const distance = finite(knownDistance)
      ? knownDistance
      : geo.cartesian3.distance(pose.position, row.base);
    if (distance < GROUND_SAMPLE_MAX_DISTANCE_M) sampleGround(row, now);
    const tipHeight =
      row.groundHeight +
      Math.max(distance, 1) *
        2 *
        Math.tan(view.fov / 2) *
        (STEM_TARGET_PX / view.height);
    geo.cartesian3.fromRadians(
      row.carto.longitude,
      row.carto.latitude,
      tipHeight,
      undefined,
      row.nextTip,
    );
    if (geo.cartesian3.distanceSquared(row.tip, row.nextTip) <= TIP_EPSILON_SQ)
      return false;
    geo.cartesian3.clone(row.nextTip, row.tip);
    row.tipMoved = true;
    return true;
  }

  function buildFootprints() {
    const items = [];
    for (const row of rows.values())
      if (row.rings && active.has(row.id))
        items.push({
          rings: row.rings,
          fill: footprintFill,
          pickId: row.pickId,
        });
    footprints.replace(items);
    footprints.commit();
  }

  function stemOf(row) {
    let stem = stems.get(row.id);
    if (!stem) {
      const lineId = `${id}-stem-${row.id}`;
      stem = {
        id: lineId,
        line: engine.lines.createLine({
          id: lineId,
          widthPx: STEM_PX,
          color: rgba,
          pickId: row.pickId,
        }),
      };
      stem.line.setPositions([row.base, row.tip]);
      stem.base = geo.cartesian3.clone(row.base);
      stem.tip = geo.cartesian3.clone(row.tip);
      owners.add(lineId);
      stems.set(row.id, stem);
    }
    return stem;
  }

  function dropStem(rowId) {
    const stem = stems.get(rowId);
    if (!stem) return;
    stem.line.destroy();
    owners.delete(stem.id);
    stems.delete(rowId);
  }

  // The LOD selection, from every record's distance and horizon.
  function selectLod(pose, now) {
    const candidates = [];
    for (const row of rows.values())
      candidates.push({
        id: row.id,
        priority: row.priority,
        distanceM: geo.cartesian3.distance(pose.position, row.base),
        inView: engine.projector.horizonVisible(row.base),
      });
    const selection = selectInfraLod(candidates, {
      cameraHeightM: pose.cartographic?.height,
      incumbentIds: active,
    });
    const kept = applyInfraEvictionGrace({
      selectedIds: selection.activeIds,
      builtIds: [...active],
      graceState: grace,
      nowMs: now,
      activeLimit: selection.budget.activeLimit,
    });
    active = new Set(kept.keepIds);
    grace = kept.graceState;
    budget = selection.budget.activeLimit;
    computed = true;
    // Travel for the motion probe counts from this selection.
    geo.cartesian3.clone(pose.position, lastLodCamera);
    lastProbeMs = now;
    const next = kept.keepIds.slice().sort().join('\n');
    if (next !== topology) {
      topology = next;
      buildFootprints();
    }
  }

  // The reference walk, on WALK_INTERVAL_MS: the LOD after a camera move,
  // shows, ground samples, tips and stems, and the card cohort.
  function walk() {
    if (!dataset) return;
    const now = performance.now();
    if (now - lastWalk < WALK_INTERVAL_MS) return;
    lastWalk = now;
    walkCount++;
    const pose = engine.camera.pose();
    const camera = pose.position;
    const size = engine.host.size();
    const view = { fov: frustumFov(pose), height: size.height || 1080 };
    // Motion without a moveEnd (a follow, Cockpit, a route flight).
    if (!dirty && computed && rows.size) {
      const probe = shouldRecomputeInfraLod({
        nowMs: now,
        lastProbeMs,
        movedSqM: geo.cartesian3.distanceSquared(camera, lastLodCamera),
        cameraHeightM: pose.cartographic?.height,
      });
      lastProbeMs = probe.lastProbeMs;
      if (probe.recompute) dirty = true;
    }
    const refresh = dirty;
    // Without sampling no retry is armed and no per-record work is spent.
    const canSample = engine.surface.supported === true;
    // Sampling that comes back re-opens a spent budget on a parked camera.
    if (canSample && lastCapability === false) retryArms = 0;
    lastCapability = canSample;
    let retryPending = false;
    let grounded = false;
    if (refresh && rows.size) selectLod(pose, now);
    let tipsChanged = false;
    let pinsChanged = false;
    const visible = [];
    for (const row of rows.values()) {
      const isActive = !computed || active.has(row.id);
      const isVisible = isActive && engine.projector.horizonVisible(row.base);
      if (row.show !== isVisible) {
        row.show = isVisible;
        tips.set(row.index, { show: isVisible });
        tipsChanged = true;
        if (row.pinIndex >= 0) {
          pins.set(row.pinIndex, { show: isVisible });
          pinsChanged = true;
        }
      }
      if (!isVisible) dropStem(row.id);
      if (!isActive) continue;
      const wasSampled = row.groundSampled;
      const floorChanged = refreshTerrainFloor(row, camera);
      if (refresh || floorChanged) sizeStem(row, now, pose, view);
      else if (
        canSample &&
        !row.groundSampled &&
        now - row.lastSample >= GROUND_SAMPLE_RETRY_MS
      ) {
        const distance = geo.cartesian3.distance(camera, row.base);
        if (distance < GROUND_SAMPLE_MAX_DISTANCE_M && sampleGround(row, now))
          sizeStem(row, now, pose, view, distance);
      }
      if (!wasSampled && row.groundSampled) grounded = true;
      // An ungrounded base in range and in view: the retry needs a frame
      // the idle governor would never produce.
      if (
        canSample &&
        !row.groundSampled &&
        !retryPending &&
        geo.cartesian3.distance(camera, row.base) <
          GROUND_SAMPLE_MAX_DISTANCE_M &&
        groundInView(row)
      )
        retryPending = true;
      if (row.tipMoved) {
        row.tipMoved = false;
        tips.set(row.index, { position: row.tip });
        tipsChanged = true;
      }
      if (row.baseMoved) {
        row.baseMoved = false;
        if (row.pinIndex >= 0) {
          pins.set(row.pinIndex, { position: row.base });
          pinsChanged = true;
        }
      }
      if (isVisible) {
        const stem = stems.get(row.id);
        if (!stem) stemOf(row);
        else if (
          !geo.cartesian3.equals(stem.tip, row.tip) ||
          !geo.cartesian3.equals(stem.base, row.base)
        ) {
          stem.line.setPositions([row.base, row.tip]);
          geo.cartesian3.clone(row.base, stem.base);
          geo.cartesian3.clone(row.tip, stem.tip);
        }
        if (row.entry) visible.push(row);
      }
    }
    dirty = false;
    if (tipsChanged) tips.commit();
    if (pinsChanged) pins.commit();
    // Real progress re-opens the budget for the records still waiting.
    if (grounded) retryArms = 0;
    if (retryPending) scheduleGroundRetry();
    publisher.publish(
      selectLocalInfrastructureOverlayCohort(visible, {
        maxEntries: labelMax,
        gridPx: labelGridPx,
        width: size.width || 0,
        height: size.height || 0,
        cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
        project: (row) =>
          engine.projector.worldToWindow(row.tip, scratchWindow),
      }),
    );
  }

  function select(featureId) {
    const row = rows.get(featureId);
    if (!row) return false;
    services.selectEntityContext?.(row);
    return true;
  }

  function flyTo(lon, lat) {
    // Camera input would cancel the flight.
    const restore = engine.input.suspendCameraInputs();
    engine.camera.flyTo({
      destination: geo.cartesian3.fromDegrees(lon, lat, FLY_HEIGHT_M),
      duration: FLY_SECONDS,
      complete: restore,
      cancel: restore,
    });
  }

  function onClick(event) {
    // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
    if (!isPointerFree()) return;
    const picked = event.picked;
    if (!dataset || !picked || !owners.has(picked.owner)) return;
    const featureId = String(picked.id).slice(id.length + 1);
    const row = rows.get(featureId);
    if (row) {
      select(featureId);
      flyTo(row.lon, row.lat);
      return;
    }
    const feature = lineFeatures.get(featureId);
    const [lon, lat] = feature?.geometry.coordinates[0] ?? [];
    if (finite(lon) && finite(lat)) flyTo(lon, lat);
  }

  function hide() {
    const shown = Boolean(dataset);
    services.hideOsmCredit?.(engine, id);
    clearGroundRetry();
    for (const remove of removers.splice(0)) remove();
    for (const rowId of [...stems.keys()]) dropStem(rowId);
    for (const set of [tips, pins, footprints, corridors]) set?.destroy();
    tips = pins = footprints = corridors = null;
    exclude = [];
    owners.clear();
    if (shown) services.removeEntityContextsForLayer?.(id);
    rows.clear();
    lineFeatures.clear();
    dataset = null;
    active = new Set();
    grace = new Map();
    budget = 0;
    computed = false;
    topology = null;
    lastProbeMs = Number.NEGATIVE_INFINITY;
    dirty = true;
    lastWalk = Number.NEGATIVE_INFINITY;
    publisher.hide();
    services.clearSelectedEntityContextForLayer?.(id);
    if (shown) wake(`${id}-hide`);
  }

  function build(next) {
    let pinCount = 0;
    const corridorItems = [];
    for (const feature of next.features)
      if (feature.geometry?.type === 'LineString') {
        lineFeatures.set(feature.id, feature);
        corridorItems.push({
          positions: feature.geometry.coordinates.map(lonLat),
          color: rgba,
          widthPx: LINE_PX,
          pickId: key(feature.id),
        });
      }
    for (const input of next.records) {
      const carto = geo.cartographic.fromDegrees(input.lon, input.lat);
      const base = geo.cartesian3.fromDegrees(input.lon, input.lat);
      const tip = geo.cartesian3.fromDegrees(
        input.lon,
        input.lat,
        INITIAL_TIP_M,
      );
      const priority = labelPriorityFromProperties(input.properties, id);
      const geometry = input.geometry;
      const row = {
        ...input,
        index: rows.size,
        pinIndex: geometry?.type === 'Point' ? pinCount++ : -1,
        rings:
          geometry?.type === 'Polygon'
            ? geometry.coordinates.map((ring) => ring.map(lonLat))
            : null,
        pickId: key(input.id),
        carto,
        base,
        tip,
        nextTip: geo.cartesian3.clone(tip),
        priority,
        groundHeight: 0,
        groundSampled: false,
        lastSample: Number.NEGATIVE_INFINITY,
        // As a Cesium entity's: shown until the first walk decides; the
        // context store reads it (isContextRecordActive).
        show: true,
        tipMoved: false,
        baseMoved: false,
        entry: labels
          ? createLocalInfrastructureOverlayEntry({
              id: input.id,
              layerId: id,
              position: tip,
              properties: input.properties,
              priority,
              accent: color,
            })
          : null,
      };
      rows.set(row.id, row);
      services.registerEntityContext?.(row, {
        id: row.pickId,
        layerId: id,
        layerName: name,
        source,
        label: localInfrastructureOverlayCopy(row.properties, id).title,
        properties: row.properties,
        latitude: Number(row.lat.toFixed(6)),
        longitude: Number(row.lon.toFixed(6)),
      });
    }
    corridors = engine.ground.createSet({
      id: `${id}-lines`,
      kind: 'corridor',
      order: 1,
      pickable: true,
    });
    owners.add(corridors.id);
    corridors.replace(corridorItems);
    corridors.commit();
    footprints = engine.ground.createSet({
      id: `${id}-footprints`,
      kind: 'polygon',
      pickable: true,
    });
    owners.add(footprints.id);
    tips = engine.movers.createSet({
      id: `${id}-tips`,
      kind: 'point',
      capacity: Math.max(1, rows.size),
      pickable: true,
      // Never hidden by the scene: the horizon is the walk's.
      depthTest: 'always',
      point: {
        sizePx: TIP_PX,
        outlinePx: TIP_OUTLINE_PX,
        outlineColor: [0, 0, 0, 1],
      },
    });
    owners.add(`${id}-tips`);
    for (const row of rows.values())
      tips.set(row.index, {
        position: row.tip,
        color: rgba,
        show: true,
        pickId: row.pickId,
      });
    tips.setCount(rows.size);
    tips.commit();
    exclude = [tips];
    if (pinCount) {
      pins = engine.movers.createSet({
        id: `${id}-pins`,
        kind: 'point',
        capacity: pinCount,
        pickable: true,
        point: { sizePx: PIN_PX, outlinePx: 0 },
      });
      owners.add(`${id}-pins`);
      for (const row of rows.values())
        if (row.pinIndex >= 0)
          pins.set(row.pinIndex, {
            position: row.base,
            color: rgba,
            show: true,
            pickId: row.pickId,
          });
      pins.setCount(pinCount);
      pins.commit();
      exclude.push(pins);
    }
  }

  return {
    /** Draws a dataset; the first walk runs on the next frame. */
    show(next) {
      if (destroyed || next === dataset) return;
      if (dataset) hide();
      try {
        dataset = next;
        build(next);
        removers.push(
          engine.frames.preRender.addEventListener(walk),
          engine.camera.moveEnd.addEventListener(() => {
            dirty = true;
            lastWalk = Number.NEGATIVE_INFINITY;
            // A camera move is a fresh situation with free frames.
            retryArms = 0;
            wake();
          }),
          engine.input.on('click', onClick, { pick: true }),
        );
        publisher.show();
        if (osmDerived && next.features.length)
          services.showOsmCredit?.(engine, id);
        wake();
      } catch (error) {
        hide();
        throw error;
      }
    },
    select,
    hide,
    destroy() {
      if (destroyed) return;
      hide();
      publisher.destroy();
      destroyed = true;
    },
    /**
     * Globe-LOD state for QA (scripts/qa-infra-lod.mjs) and tests: `total`
     * records, `active` the ones the LOD keeps, `budgetLimit` the last
     * camera-height band's cap, `computed` false until the first walk.
     */
    lod: () => ({
      total: rows.size,
      active: active.size,
      budgetLimit: budget,
      computed,
    }),
  };
}
