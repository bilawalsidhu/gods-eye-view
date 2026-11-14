import * as Cesium from 'cesium';
import { applyDisplayCourse, updatePlayback } from '../transit/movement.js';
import { HEIGHT_SAMPLE_MAX_ALTITUDE_M } from '../transit/policy.js';
import {
  COLD_CELL_FLUSH_MS,
  COLD_CELL_RETRY_MS,
  TRACK_MAX_GRADE,
  TRACK_PRIOR_ABOVE_M,
  TRACK_PRIOR_BELOW_M,
  TRACK_SAMPLE_GRID,
  TRACK_SAMPLE_MAX_CAMERA_M,
  TRACK_SAMPLE_MAX_AGE_MS,
  TRACK_SAMPLE_MAX_DIST_KM,
  TRACK_SAMPLE_REFRESH_MS,
  TRACK_SAMPLE_RETRY_MS,
  TRACK_SAMPLES_PER_FLUSH,
  TRACK_SETTLE_MPS,
  TRACK_SNAP_M,
  COLD_CELLS_PER_FLUSH,
  FLOOR_CELLS_BURST,
  FLOOR_CELLS_PER_MINUTE,
  FLOOR_WARM_MAX_DIST_KM,
  MARKER_PIXEL_SIZE,
  RAIL_CATEGORY_COLORS,
  SELECTED_PIXEL_SIZE,
  UNSELECTED_TRAIN_ALPHA,
} from './policy.js';
import { placeOnPath } from './pathBinding.js';
import {
  fleetModelSet,
  loadFleetModelSet,
  transitModelSpec,
} from '../../data/fleetModels.js';
import { createFleetModelLayer } from '../../data/fleetModelInstances.js';

/** How often the trains near enough for a model are gathered again (wall ms). */
const MODEL_CANDIDATES_MS = 500;
/** Each category's colour, painted where a train model marks it. */
const CATEGORY_TINTS = Object.fromEntries(
  Object.entries(RAIL_CATEGORY_COLORS).map(([category, css]) => [
    category,
    Cesium.Color.fromCssColorString(css),
  ]),
);

const SPRITE_PX = 64;
/** Billboard tints; the setter copies, so sharing one instance is safe. */
const FULL_TINT = Cesium.Color.WHITE;
const DIM_TINT = new Cesium.Color(1, 1, 1, UNSELECTED_TRAIN_ALPHA);

/**
 * Draw one category/mode sprite: a filled disc in the category colour with a
 * dark rim and a white glyph for what runs on the track (a train front, a
 * tram with its pantograph, or the metro "M"). Drawn once per pair and reused.
 * @param {string} category
 * @param {string} mode
 * @returns {HTMLCanvasElement}
 */
function drawSprite(category, mode) {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  const g = canvas.getContext('2d');
  const c = SPRITE_PX / 2;
  g.beginPath();
  g.arc(c, c, c - 3, 0, Math.PI * 2);
  g.fillStyle = RAIL_CATEGORY_COLORS[category] || RAIL_CATEGORY_COLORS.local;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(10, 14, 20, 0.85)';
  g.stroke();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#ffffff';
  if (mode === 'metro') {
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('M', c, c + 2);
    return canvas;
  }
  // Train front: body, windscreen cut out, two lamps.
  g.beginPath();
  g.roundRect(c - 13, c - 14, 26, 28, 6);
  g.fill();
  g.fillStyle = RAIL_CATEGORY_COLORS[category] || RAIL_CATEGORY_COLORS.local;
  g.fillRect(c - 9, c - 9, 18, 9);
  g.beginPath();
  g.arc(c - 7, c + 7, 2.5, 0, Math.PI * 2);
  g.arc(c + 7, c + 7, 2.5, 0, Math.PI * 2);
  g.fill();
  if (mode === 'tram') {
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(c - 6, c - 14);
    g.lineTo(c, c - 22);
    g.lineTo(c + 6, c - 14);
    g.stroke();
  }
  return canvas;
}

/**
 * Markers, ground height and the per-frame pass for one Rail layer.
 * @param {object} context
 * @returns {object}
 */
export function createRendering({ state, services, parts }) {
  const {
    governorRequestRender,
    holdContinuousRender,
    releaseContinuousRender,
  } = services.render;
  const {
    cachedGroundFloor,
    warmGroundFloor,
    GROUND_FLOOR_LIFT_M,
    neighborFloorM = null,
    coarseFloorCoord = null,
  } = services.ground;
  const sprites = new Map();
  const terrainPoint = new Cesium.Cartographic();
  const scratchPosition = new Cesium.Cartesian3();
  /** Scratch for the on-line position; place() runs every frame. */
  const pathPoint = { lat: NaN, lon: NaN, bearingDeg: NaN };

  function spriteFor(category, mode) {
    const id = `${category}:${mode}`;
    if (!sprites.has(id)) sprites.set(id, drawSprite(category, mode));
    return sprites.get(id);
  }

  /** Whether ground matters at this camera (Transit's gate, shared). */
  function nearGround() {
    const height = state._viewer?.camera?.positionCartographic?.height;
    return !Number.isFinite(height) || height <= HEIGHT_SAMPLE_MAX_ALTITUDE_M;
  }

  /** Kilometres from the camera's subpoint, or Infinity without a camera. */
  function cameraKm(lat, lon) {
    const carto = state._viewer?.camera?.positionCartographic;
    if (!carto) return Infinity;
    const camLat = Cesium.Math.toDegrees(carto.latitude);
    const camLon = Cesium.Math.toDegrees(carto.longitude);
    const kLon = Math.cos((camLat * Math.PI) / 180);
    return Math.hypot(lat - camLat, (lon - camLon) * kLon) * 111.32;
  }

  /**
   * A number naming the cell of 1/`perDegree` degree that holds a point. A
   * string key would be built for every moving train on every frame.
   */
  function cellKey(lat, lon, perDegree) {
    return (
      Math.round(lat * perDegree) * (362 * perDegree) +
      Math.round(lon * perDegree)
    );
  }

  /**
   * Cells rail may still ask the floor service for: refilled at
   * FLOOR_CELLS_PER_MINUTE, never holding more than FLOOR_CELLS_BURST.
   */
  const floorBudget = { cells: FLOOR_CELLS_BURST, at: Date.now() };
  function takeFloorBudget(wanted) {
    const now = Date.now();
    floorBudget.cells = Math.min(
      FLOOR_CELLS_BURST,
      floorBudget.cells +
        ((now - floorBudget.at) / 60_000) * FLOOR_CELLS_PER_MINUTE,
    );
    floorBudget.at = now;
    const granted = Math.max(
      0,
      Math.min(wanted, Math.floor(floorBudget.cells)),
    );
    floorBudget.cells -= granted;
    return granted;
  }
  /**
   * Floor cells a train (or a stop of the selected trip) reached while they
   * were cold, warmed in small batches off the frame path. `asked`
   * remembers when a cell was last requested, so a frame loop over a cold
   * cell does not re-request it.
   */
  const coldCells = new Map();
  const asked = new Map();
  let coldTimer = null;
  // Track heights on photorealistic tiles, sampled from the rendered mesh at
  // points on the train's own line: the mesh under a draped line is the
  // track bed or the deck. A floor cell's height is taken at the cell's
  // centre, which can be a roof, a cutting's rim or a hillside well above
  // the rails, so it is only the fallback. Keyed by bucket of
  // 1/TRACK_SAMPLE_GRID degree; each sample keeps the camera height it was
  // read from (`camM`, above the floor), when (`at`), and when it was last
  // read again (`readAt`).
  const trackSamples = new Map();
  const trackQueue = new Map();
  const trackAsked = new Map();
  const trackProbe = new Cesium.Cartographic();
  function cameraCartographic() {
    return state._viewer?.camera?.positionCartographic ?? null;
  }
  /**
   * Whether the photorealistic tiles have finished streaming for this view:
   * there is a shown tileset, and every shown one reports its tiles loaded.
   */
  function tilesLoaded(scene) {
    const primitives = scene.primitives;
    let found = false;
    for (let i = 0; i < (primitives?.length || 0); i++) {
      const primitive = primitives.get(i);
      if (!primitive?.show || typeof primitive.tilesLoaded !== 'boolean')
        continue;
      if (!primitive.tilesLoaded) return false;
      found = true;
    }
    return found;
  }
  function queueTrackSample(lat, lon, key, priority) {
    const now = Date.now();
    if (now - (trackAsked.get(key) ?? -Infinity) < TRACK_SAMPLE_RETRY_MS)
      return;
    // The floor under it is the gross check against coarse tiles; with no
    // floor yet, wait (the cold-cell queue is warming it). From higher up,
    // the tiles near the camera are coarse.
    const prior = cachedGroundFloor(lat, lon);
    const height = cameraCartographic()?.height;
    if (
      !Number.isFinite(prior) ||
      !Number.isFinite(height) ||
      height - prior > TRACK_SAMPLE_MAX_CAMERA_M
    )
      return;
    if (trackAsked.size > 8192) trackAsked.clear();
    trackAsked.set(key, now);
    trackQueue.set(key, { lat, lon, priority });
    coldTimer ??= setTimeout(flushColdCells, COLD_CELL_FLUSH_MS);
  }
  function flushTrackSamples() {
    const scene = state._viewer?.scene;
    const carto = cameraCartographic();
    if (
      !trackQueue.size ||
      typeof scene?.sampleHeight !== 'function' ||
      !Number.isFinite(carto?.height) ||
      !tilesLoaded(scene)
    ) {
      trackQueue.clear();
      return;
    }
    const camLat = Cesium.Math.toDegrees(carto.latitude);
    const camLon = Cesium.Math.toDegrees(carto.longitude);
    const kLon = Math.cos((camLat * Math.PI) / 180);
    const excludeObjects = state._markers ? [state._markers] : [];
    const now = performance.now();
    // The selected train first, then the rest in the order they asked.
    const items = [...trackQueue].sort(
      (a, b) => Number(b[1].priority) - Number(a[1].priority),
    );
    trackQueue.clear();
    let sampled = 0;
    for (const [key, point] of items) {
      if (sampled >= TRACK_SAMPLES_PER_FLUSH) break;
      const dKm =
        Math.hypot(point.lat - camLat, (point.lon - camLon) * kLon) * 111.32;
      if (dKm > TRACK_SAMPLE_MAX_DIST_KM) continue;
      const prior = cachedGroundFloor(point.lat, point.lon);
      if (!Number.isFinite(prior)) continue;
      const camM = carto.height - prior;
      if (camM > TRACK_SAMPLE_MAX_CAMERA_M) continue;
      let height;
      try {
        sampled += 1;
        Cesium.Cartographic.fromDegrees(point.lon, point.lat, 0, trackProbe);
        height = scene.sampleHeight(trackProbe, excludeObjects);
      } catch {
        continue;
      }
      const kept = trackSamples.get(key);
      if (kept) kept.readAt = now;
      if (
        !Number.isFinite(height) ||
        height < prior - TRACK_PRIOR_BELOW_M ||
        height > prior + TRACK_PRIOR_ABOVE_M
      )
        continue;
      // A reading from higher up saw coarser tiles: it replaces one read
      // from lower down only once that one is old.
      if (kept) {
        if (camM > kept.camM && now - kept.at < TRACK_SAMPLE_MAX_AGE_MS)
          continue;
        kept.h = height;
        kept.camM = camM;
        kept.at = now;
      } else trackSamples.set(key, { h: height, camM, at: now, readAt: now });
    }
    if (trackSamples.size > 50_000) trackSamples.clear();
    if (sampled) governorRequestRender('rail-track-height');
  }
  function flushColdCells() {
    coldTimer = null;
    const queued = [...coldCells.values()].sort(
      (a, b) => Number(b.priority) - Number(a.priority) || a.km - b.km,
    );
    coldCells.clear();
    const granted = takeFloorBudget(
      Math.min(queued.length, COLD_CELLS_PER_FLUSH),
    );
    // Cells left over are asked for again after COLD_CELL_RETRY_MS.
    if (granted) warmGroundFloor(queued.slice(0, granted));
    flushTrackSamples();
  }
  /**
   * Queue a cold floor cell for warming. Only cells within
   * FLOOR_WARM_MAX_DIST_KM of the camera are, unless `anyDistance` (the
   * selected trip's stops, which are drawn wherever the camera is).
   */
  function queueColdCell(lat, lon, priority = false, anyDistance = false) {
    if (!nearGround()) return;
    const km = cameraKm(lat, lon);
    if (km > FLOOR_WARM_MAX_DIST_KM && !anyDistance) return;
    const key = cellKey(lat, lon, 1000);
    const now = Date.now();
    if (now - (asked.get(key) ?? -Infinity) < COLD_CELL_RETRY_MS) return;
    if (asked.size > 4096) asked.clear();
    asked.set(key, now);
    coldCells.set(key, { lat, lon, km, priority });
    coldTimer ??= setTimeout(flushColdCells, COLD_CELL_FLUSH_MS);
  }

  /** Layer disabled: drop the queued work and the samples taken so far. */
  function reset() {
    clearTimeout(coldTimer);
    coldTimer = null;
    coldCells.clear();
    asked.clear();
    trackQueue.clear();
    trackAsked.clear();
    trackSamples.clear();
  }

  /** floorHeight's answer, reused by every call: read it before the next. */
  const floorAnswer = { h: 0, q: 0 };
  function answer(h, q) {
    floorAnswer.h = h;
    floorAnswer.q = q;
    return floorAnswer;
  }

  /**
   * Height to draw a train at: the rendered terrain under it on a terrain
   * globe, else the shared ground floor (which tracks the photorealistic mesh
   * where one is loaded). Where that cell is not warm yet, a neighbouring
   * cell's floor, else the floor this train last stood on, while the cell is
   * warmed: a train running onto unsampled ground keeps its height instead of
   * dropping to the ellipsoid, which lies tens to hundreds of metres under
   * the photorealistic mesh (about 150 m around Chicago). Only a train with
   * no floor yet, or a stop, stands on the ellipsoid, until its cell is warm.
   * @param {number} lat
   * @param {number} lon
   * @param {{floorM?: number, key?: string}|null} [entry] the train, which
   *   keeps its floor
   * @param {boolean} [stop] a stop of the selected trip: its cell is warmed
   *   first, however far from the camera
   * @returns {{h: number, q: number}} The height, and how good it is: 3 the
   *   rendered terrain, 2 the cell's floor, 1 a neighbouring cell's or the
   *   train's last floor, 0 the ellipsoid. The same object every call.
   */
  /** The last coarse cell asked for a stop (stops have no entry). */
  const stopCell = { kLat: NaN, kLon: NaN, cell: null };

  /**
   * The point's coarse floor cell, kept on the train (and once for stops)
   * while the point stays in the same 0.001° cell: a train gliding across a
   * cold cell asks the floor service for it once, not every frame.
   * @param {number} lat
   * @param {number} lon
   * @param {object|null} entry
   * @returns {{lat: number, lon: number}}
   */
  function coarseCellOf(lat, lon, entry) {
    const memo = entry
      ? (entry.coarseCell ??= { kLat: NaN, kLon: NaN, cell: null })
      : stopCell;
    const kLat = Math.round(lat * 1000);
    const kLon = Math.round(lon * 1000);
    if (memo.kLat !== kLat || memo.kLon !== kLon) {
      memo.kLat = kLat;
      memo.kLon = kLon;
      memo.cell = coarseFloorCoord(lat, lon);
    }
    return memo.cell;
  }

  function floorHeight(lat, lon, entry = null, stop = false) {
    const globe = state._viewer?.scene?.globe;
    if (globe?.show === true) {
      Cesium.Cartographic.fromDegrees(lon, lat, 0, terrainPoint);
      const rendered = globe.getHeight?.(terrainPoint);
      if (Number.isFinite(rendered))
        return answer(rendered + GROUND_FLOOR_LIFT_M, 3);
    }
    const floor = cachedGroundFloor(lat, lon);
    if (Number.isFinite(floor)) {
      if (entry) entry.floorM = floor;
      return answer(floor + GROUND_FLOOR_LIFT_M, 2);
    }
    queueColdCell(
      lat,
      lon,
      stop || (entry !== null && entry.key === state._selectedKey),
      stop,
    );
    const near =
      neighborFloorM && coarseFloorCoord
        ? neighborFloorM(coarseCellOf(lat, lon, entry))
        : null;
    if (Number.isFinite(near)) return answer(near + GROUND_FLOOR_LIFT_M, 1);
    return Number.isFinite(entry?.floorM)
      ? answer(entry.floorM + GROUND_FLOOR_LIFT_M, 1)
      : answer(0, 0);
  }
  function heightFor(lat, lon, entry = null) {
    return floorHeight(lat, lon, entry).h;
  }

  /**
   * Where a stop of the selected trip stands, and how good that height is
   * (floorHeight's quality): a stop read before its cell was warm is read
   * again until it stands on a real floor (routeDisplay.js).
   * @param {number} lat
   * @param {number} lon
   * @returns {{h: number, q: number}}
   */
  function stopHeight(lat, lon) {
    const { h, q } = floorHeight(lat, lon, null, true);
    return { h, q };
  }

  /**
   * The height a train is drawn at. Its target is the track sample under it
   * on photorealistic tiles (else the floor chain of heightFor), and the
   * drawn height moves toward it no faster than a railway climbs:
   * TRACK_MAX_GRADE of the distance moved, plus TRACK_SETTLE_MPS over time.
   * A single high sample (a roof, an overpass) is a bump, cell steps are
   * ramps, and a followed camera rides smoothly. The drawn height snaps when
   * a better source replaces a fallback (quality 0-1 to 2-3, or any floor
   * replacing the ellipsoid, 0 to 1), and after a jump of more than
   * TRACK_SNAP_M.
   * @param {object} entry The train.
   * @param {number} lat
   * @param {number} lon
   * @returns {number}
   */
  function displayHeightFor(entry, lat, lon) {
    const globe = state._viewer?.scene?.globe;
    const now = performance.now();
    let targetH = NaN;
    let targetQ = 0;
    if (globe?.show !== true && nearGround()) {
      const key = cellKey(lat, lon, TRACK_SAMPLE_GRID);
      const sampled = trackSamples.get(key);
      if (sampled) {
        targetH = sampled.h + GROUND_FLOOR_LIFT_M;
        targetQ = 3;
      }
      // A sample is read again now and then: from a lower camera, it
      // replaces one read from coarser tiles.
      if (!sampled || now - sampled.readAt >= TRACK_SAMPLE_REFRESH_MS)
        queueTrackSample(lat, lon, key, entry.key === state._selectedKey);
    }
    if (!Number.isFinite(targetH)) {
      const floor = floorHeight(lat, lon, entry);
      targetH = floor.h;
      targetQ = floor.q;
    }
    const prev = entry.drawnHeight;
    let h = targetH;
    if (prev && Number.isFinite(prev.h)) {
      const kLon = Math.cos((lat * Math.PI) / 180);
      const moved =
        Math.hypot(lat - prev.lat, (lon - prev.lon) * kLon) * 111_320;
      const better =
        (prev.q === 0 && targetQ > 0) || (prev.q <= 1 && targetQ >= 2);
      if (moved <= TRACK_SNAP_M && !better) {
        const dt = Math.max(0, (now - prev.at) / 1000);
        const step = TRACK_MAX_GRADE * moved + TRACK_SETTLE_MPS * dt;
        h = prev.h + Math.max(-step, Math.min(step, targetH - prev.h));
      }
    }
    // Written in place: this runs for every moving train on every frame.
    if (prev) {
      prev.h = h;
      prev.q = targetQ;
      prev.lat = lat;
      prev.lon = lon;
      prev.at = now;
    } else entry.drawnHeight = { h, q: targetQ, lat, lon, at: now };
    return h;
  }

  /** Ask the floor service for the cells under one feed's trains; off the frame path. */
  function warmFloors(feedId) {
    for (const entry of state._trains.values()) {
      if (entry.feedId !== feedId) continue;
      // A parked train's height was read when it was placed; floors warmed
      // since (or finer terrain tiles) land on it here, once per poll. Moving
      // trains re-read their height every frame already.
      if (entry.marker && !state._moving.has(entry)) place(entry);
      const { lat, lon } = entry.record;
      if (!Number.isFinite(cachedGroundFloor(lat, lon)))
        queueColdCell(lat, lon, entry.key === state._selectedKey);
    }
  }

  /**
   * Whether a train is drawn: its category is on, and it is not a copy of a
   * train another feed draws better (dedupe.js).
   */
  function categoryShown(entry) {
    return (
      state._categories[entry.category] !== false && entry.duplicate !== true
    );
  }

  /**
   * Whether a train's icon is drawn: shown, not drawn by its model, and no
   * first-person view rides it (cockpitSubject.js). A held train keeps its
   * playback; only its icon and model hide.
   */
  function markerShown(entry) {
    return (
      categoryShown(entry) &&
      !entry.modelOwnsVisual &&
      entry.key !== state._cockpitSubjectKey
    );
  }

  /**
   * Whether the train's playback runs: it is drawn, or a first-person view
   * rides it, which keeps it moving, hidden, in a category turned off.
   */
  function playing(entry) {
    return categoryShown(entry) || entry.key === state._cockpitSubjectKey;
  }

  /**
   * A train bound to its railway line is drawn on the line, at the arc its
   * playback has reached; any other train (or a bound train whose reports do
   * not fit the line) is drawn on the time-interpolated straight-line point.
   */
  function place(entry) {
    const sample = entry.sample;
    const onPath =
      entry.path && placeOnPath(entry.path, sample, entry.segment, pathPoint);
    const lat = onPath
      ? pathPoint.lat
      : Number.isFinite(sample?.lat)
        ? sample.lat
        : entry.record.lat;
    const lon = onPath
      ? pathPoint.lon
      : Number.isFinite(sample?.lon)
        ? sample.lon
        : entry.record.lon;
    // Write into scratch, never into `marker.position`: the getter returns the
    // billboard's own vector, so filling it in place makes the setter see an
    // unchanged position and skip the update that actually moves the sprite.
    entry.marker.position = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      displayHeightFor(entry, lat, lon),
      undefined,
      scratchPosition,
    );
    entry.marker.show = markerShown(entry);
  }

  /** While a train is selected, every other train is drawn see-through. */
  function tintFor(entry) {
    return state._selectedKey !== null && entry.key !== state._selectedKey
      ? DIM_TINT
      : FULL_TINT;
  }

  function paint(entry) {
    if (!entry.marker) return;
    const selected = entry.key === state._selectedKey;
    const size = selected ? SELECTED_PIXEL_SIZE : MARKER_PIXEL_SIZE;
    entry.marker.image = spriteFor(entry.category, entry.railMode);
    entry.marker.width = size;
    entry.marker.height = size;
    entry.marker.color = tintFor(entry);
    entry.marker.show = markerShown(entry);
  }

  /** Re-tint every train after the selection appeared, moved or cleared. */
  function paintAll() {
    for (const entry of state._trains.values()) paint(entry);
  }

  function addMarker(entry) {
    const marker = state._markers.add({
      id: entry.key,
      position: Cesium.Cartesian3.ZERO,
      image: spriteFor(entry.category, entry.railMode),
      width: MARKER_PIXEL_SIZE,
      height: MARKER_PIXEL_SIZE,
      color: tintFor(entry),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    entry.marker = marker;
    place(entry);
    return marker;
  }

  function cancelWake(entry) {
    if (entry?.wakeTimer) clearTimeout(entry.wakeTimer);
    if (entry) entry.wakeTimer = null;
  }

  /**
   * Track whether a train is mid-glide, so the frame pass walks only those. A
   * train parked at a fix whose next segment starts later is woken by a timer
   * at that boundary, not by polling every frame.
   */
  function schedulePlayback(entry) {
    cancelWake(entry);
    if (!entry.marker) return;
    place(entry);
    const sample = entry.sample;
    const moving =
      playing(entry) &&
      sample?.phase === 'playing' &&
      sample.segmentSpeedMps > 0;
    if (moving) {
      state._moving.add(entry);
      return;
    }
    state._moving.delete(entry);
    if (playing(entry) && Number.isFinite(sample?.nextWakeMonoMs)) {
      entry.wakeTimer = setTimeout(
        () => {
          entry.wakeTimer = null;
          if (!state._enabled || !state._trains.has(entry.key)) return;
          updatePlayback(entry, Date.now(), performance.now());
          schedulePlayback(entry);
          syncRenderHold();
          governorRequestRender('rail-motion-boundary');
        },
        Math.max(1, sample.nextWakeMonoMs - performance.now()),
      );
    }
  }

  function syncRenderHold() {
    const working = state._enabled && state._moving.size > 0;
    if (working && !state._renderHeld) {
      holdContinuousRender('rail');
      state._renderHeld = true;
    } else if (!working && state._renderHeld) {
      releaseContinuousRender('rail');
      state._renderHeld = false;
      governorRequestRender('rail-settled');
    }
  }

  const horizon = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  const surfaceScratch = new Cesium.Cartesian3();

  /** Whether a point on the Earth is on the camera's side of it. */
  function facesCamera(position) {
    const viewer = state._viewer;
    const cameraPosition = viewer?.camera?.positionWC;
    if (
      !position ||
      !cameraPosition ||
      viewer.scene?.mode !== Cesium.SceneMode.SCENE3D
    )
      return true;
    const surface = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
      position,
      surfaceScratch,
    );
    if (!surface) return true;
    horizon.cameraPosition = cameraPosition;
    return horizon.isPointVisible(surface);
  }

  /**
   * Markers are drawn over the terrain, never behind it, and the selected
   * train is drawn at any distance (viewport.js): from far out, the globe
   * would not hide it on its far side, so this pass does, with its stops.
   */
  function cullSelected() {
    const entry = state._trains.get(state._selectedKey);
    if (!entry?.marker) return;
    const shown = markerShown(entry) && facesCamera(entry.marker.position);
    if (entry.marker.show !== shown) entry.marker.show = shown;
    parts.routes.cullStops(facesCamera);
  }

  function onPreRender() {
    advanceMoving();
    if (state._enabled && state._selectedKey !== null) cullSelected();
    if (state._enabled) updateModels();
  }

  // Under the DISPLAY rail's 3D toggle, trains near the camera are drawn as
  // the project's procedural fleet models, chosen by category and mode,
  // painted in their category colour where the model marks it, on the
  // aircraft layers' icon-to-model rules (services.fleet). The fleet set
  // loads once, up front, when the layer starts.
  let fleetModels = null;
  /** Items drawn last frame, and the map the next frame's are gathered into. */
  let modelItems = new Map();
  let spareItems = new Map();
  let modelCandidatesAtMs = -Infinity;

  /** Load the fleet set and create the layer's models (on enable). */
  function startModels() {
    const fleet = services.fleet;
    if (!fleet?.policy || !state._viewer) return;
    loadFleetModelSet({ resolveAsset: fleet.resolveAsset }).catch(() => {
      /* models stay off; trains keep their icons */
    });
    fleetModels ||= createFleetModelLayer({
      viewer: state._viewer,
      display: fleet.display,
      policy: fleet.policy,
      resolveAsset: fleet.resolveAsset,
    });
  }

  /** Hand a train's visual back to its icon. */
  function handBack(entry) {
    if (!entry.modelOwnsVisual) return;
    entry.modelOwnsVisual = false;
    if (entry.marker) entry.marker.show = markerShown(entry);
  }

  function modelItem(entry, set) {
    let item = modelItems.get(entry.key);
    if (!item || item.entry !== entry)
      item = {
        entry,
        pickId: entry.key,
        modelOwnsVisual: false,
        // Markers are drawn this far above the track; a model stands on it.
        groundLiftM: GROUND_FLOOR_LIFT_M,
      };
    const specKey = `${entry.category}|${entry.railMode}`;
    if (item.specKey !== specKey) {
      item.specKey = specKey;
      item.spec = transitModelSpec(set, {
        railCategory: entry.category,
        railMode: entry.railMode,
      });
      item.tint = CATEGORY_TINTS[entry.category] || CATEGORY_TINTS.local;
    }
    item.position = entry.marker.position;
    item.headingDeg = Number.isFinite(entry.courseDeg) ? entry.courseDeg : 0;
    // A train a first-person view rides draws no model: the camera is inside
    // it (cockpitSubject.js).
    item.show = categoryShown(entry) && entry.key !== state._cockpitSubjectKey;
    return item;
  }

  function updateModels() {
    if (!fleetModels) return;
    if (!fleetModels.active() || state._trains.size === 0) {
      if (modelItems.size) {
        for (const item of modelItems.values()) handBack(item.entry);
        modelItems.clear();
        fleetModels.frame(modelItems, performance.now());
      }
      return;
    }
    const set = fleetModelSet();
    const now = performance.now();
    const next = spareItems;
    next.clear();
    if (now - modelCandidatesAtMs >= MODEL_CANDIDATES_MS) {
      modelCandidatesAtMs = now;
      const camera = state._viewer?.camera;
      const policy = services.fleet.policy;
      const keepM =
        services.fleet.display?.()?.models3dMode === 'all'
          ? policy.keepAllM
          : policy.keepM;
      const limitSq = keepM * keepM * 1.44;
      if (camera?.positionWC)
        for (const entry of state._trains.values()) {
          if (!entry.marker || !categoryShown(entry)) continue;
          if (
            Cesium.Cartesian3.distanceSquared(
              camera.positionWC,
              entry.marker.position,
            ) > limitSq
          )
            continue;
          next.set(entry.key, modelItem(entry, set));
        }
    } else {
      for (const [key, item] of modelItems)
        if (state._trains.get(key) === item.entry && item.entry.marker)
          next.set(key, modelItem(item.entry, set));
    }
    for (const [key, item] of modelItems)
      if (next.get(key) !== item) handBack(item.entry);
    spareItems = modelItems;
    modelItems = next;
    fleetModels.frame(modelItems, now);
    for (const item of modelItems.values()) {
      const entry = item.entry;
      if (item.modelOwnsVisual) {
        entry.modelOwnsVisual = true;
        entry.marker.show = false;
      } else handBack(entry);
    }
    if (fleetModels.settling) governorRequestRender('rail-models');
  }

  /** Drop every model (layer disabled); `destroy` also removes the collection. */
  function stopModels(destroy = false) {
    for (const item of modelItems.values()) item.entry.modelOwnsVisual = false;
    modelItems.clear();
    spareItems.clear();
    modelCandidatesAtMs = -Infinity;
    if (destroy) {
      fleetModels?.destroy();
      fleetModels = null;
    } else fleetModels?.clear();
  }

  function advanceMoving() {
    if (!state._enabled || state._moving.size === 0) {
      syncRenderHold();
      return;
    }
    if (globalThis.document?.visibilityState === 'hidden') return;
    const now = Date.now();
    const monoNow = performance.now();
    for (const entry of state._moving) {
      if (!entry.marker) {
        state._moving.delete(entry);
        continue;
      }
      updatePlayback(entry, now, monoNow);
      applyDisplayCourse(entry, monoNow);
      place(entry);
      if (
        entry.sample.phase !== 'playing' ||
        entry.sample.segmentSpeedMps === 0
      )
        schedulePlayback(entry);
    }
    syncRenderHold();
  }

  /** Re-apply category visibility to every marker after a toggle. */
  function applyCategoryVisibility() {
    for (const entry of state._trains.values()) {
      if (!entry.marker) continue;
      entry.marker.show = markerShown(entry);
      schedulePlayback(entry);
    }
    syncRenderHold();
    parts.routes.applyNetwork();
    governorRequestRender('rail-categories');
  }

  return {
    addMarker,
    paint,
    paintAll,
    heightFor,
    stopHeight,
    displayHeightFor,
    cancelWake,
    schedulePlayback,
    syncRenderHold,
    onPreRender,
    warmFloors,
    applyCategoryVisibility,
    categoryShown,
    reset,
    startModels,
    stopModels,
  };
}
