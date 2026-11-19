import { selectModelEligible } from '../../data/modelEligibility.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import {
  distanceSquared,
  dot,
  RADIANS_PER_DEGREE,
  sub,
} from '../../geo/vector.js';
import { aircraftLayerModelSpec } from '../flights/modelSpec.js';
import {
  fleetModelSet,
  fleetPartTable,
  loadFleetModelSet,
} from '../../data/fleetModels.js';
import { aircraftLayerPartState } from '../../data/modelPartDrivers.js';
import { KNOT_MPS } from '../../data/units.js';
import {
  FLEET_DR_INTERVAL_MS,
  MODEL_ADD_M,
  MODEL_ALT_CEIL_M,
  MODEL_HEADING_OFFSET_DEG,
  MODEL_KEEP_M,
  MODEL_MAX,
  MODEL_MAX_ALL,
} from '../flights/policy.js';
import {
  AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
  aircraftModelBlend,
} from '../../data/aircraftModelLighting.js';

const WHITE = Object.freeze([1, 1, 1, 1]);

/** Whether `point` is inside the eye's view cone (`pose`), a metre's slack. */
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

/** The fleet model an aircraft draws with: its adsbdb type, else its emitter category. */
const specOf = (marker) =>
  aircraftLayerModelSpec({
    typeCode: marker?.typeCode,
    category: marker?.category,
    callsign: marker?.record?.callsign,
  });

/**
 * 3D models for Local ADS-B aircraft under the DISPLAY rail's 3D toggle,
 * drawn as one `models` set of the renderer's draw port.
 *
 * Mirrors the public Flights fleet: models only below the altitude ceiling,
 * the same proximity/all caps and add/keep radii, the same visible-first
 * eligibility (`selectModelEligible`), the same fleet model per type, life
 * size (`aircraftLayerModelSpec`) and the same colours: the mesh's own
 * (`aircraftModelBlend`). A billboard stays the
 * visual until its model is ready (the set's `ready`) AND placed; a grounded
 * aircraft's model rides the one-shot ground snap plus the model's clearance,
 * and without a resolved ground it stays a billboard. Models move and turn in
 * place each frame; only a type change loads another model. Every fleet
 * model loads once, up front, when the layer starts (`loadFleetModelSet`),
 * and models are drawn from those bytes.
 * @param {object} options
 * @param {object} options.viewer The viewer the layer draws on; the ground
 *   snap samples through it.
 * @param {object} options.draw Draw port (`drawOf(viewer)`).
 * @param {object} options.camera Camera port (`findCamera(viewer)`).
 * @param {string} options.setId The models set's id.
 * @param {string[]} [options.seeThrough] The layer's other set ids ground
 *   samples see through (its markers).
 * @param {(url: string) => string} options.resolveAsset
 * @param {object|null} [options.groundSnap] `createGroundSnap()` instance.
 * @returns {object|null} Null where the renderer draws no models.
 */
export function createLocalAdsbModels({
  viewer,
  draw,
  camera,
  setId,
  seeThrough = [],
  resolveAsset,
  groundSnap = null,
}) {
  if (typeof draw?.models !== 'function' || !camera) return null;
  void loadFleetModelSet({ resolveAsset }).catch(() => {
    /* aircraft stay billboards */
  });
  const set = draw.models({ id: setId, show: false });
  /** What ground samples see through, by set id (with every set not drawn as ground). */
  const groundSets = [setId, ...seeThrough];
  /**
   * id -> admitted model. `bellyM` is the offset of the model drawn;
   * `nextBellyM` a new asset's, taken once that model is ready (the old one
   * draws, at its own offset, until then). `sentUrl` is the asset last
   * asked for, `drawnUrl` the one whose model is ready.
   * @type {Map<string, {bellyM: number,
   *   nextBellyM: number|null, sentUrl: string|null,
   *   drawnUrl: string|null, ready: boolean}>}
   */
  const models = new Map();
  let destroyed = false;
  let lastEligibilityAt = 0;
  let eligible = new Set();
  const offReady = set.on('ready', (id) => {
    const record = models.get(id);
    if (!record) return;
    record.ready = true;
    record.drawnUrl = record.sentUrl;
    if (record.nextBellyM !== null) {
      record.bellyM = record.nextBellyM;
      record.nextBellyM = null;
    }
  });

  function release(ids) {
    const gone = [];
    for (const id of ids) {
      if (!models.delete(id)) continue;
      gone.push(id);
      groundSnap?.forget?.(id);
    }
    if (gone.length && !destroyed) set.remove(gone);
  }

  function releaseAll() {
    for (const id of models.keys()) groundSnap?.forget?.(id);
    if (models.size && !destroyed) set.clear();
    models.clear();
  }

  /**
   * Admit a model for `id`. One admitted keeps its slot through a type
   * change: the frame pass asks for the new model, loaded in place. Until
   * the fleet model set has loaded the aircraft stays a billboard.
   */
  function admit(id, marker, cap) {
    if (models.has(id) || models.size >= cap) return;
    const spec = specOf(marker);
    if (!spec.url) return;
    models.set(id, {
      bellyM: spec.bellyM,
      nextBellyM: null,
      sentUrl: null,
      drawnUrl: null,
      ready: false,
    });
  }

  /**
   * The asset `record` is about to ask for: the same model (a scale-only
   * class change, or none) takes the offset now; another waits for its
   * model's `ready`.
   */
  function noteAsset(record, url, bellyM) {
    record.sentUrl = url;
    if (!record.ready || url === record.drawnUrl) {
      record.bellyM = bellyM;
      record.nextBellyM = null;
    } else {
      record.nextBellyM = bellyM;
    }
  }

  /**
   * The moving parts an aircraft's model is posed with, from its record
   * (`aircraftLayerPartState`). The receiver knows no ground height, so its gear
   * follows the approach rule by its reported altitude, climb and speed. An
   * airport vehicle is a road vehicle (`groundVehiclePartState`): its wheels
   * roll with its speed.
   */
  function partsOf(marker, spec) {
    const table = fleetPartTable(fleetModelSet(), spec.model);
    if (!table) return undefined;
    const record = marker.record ?? {};
    const finite = (v) => (Number.isFinite(v) ? v : null);
    const speedMps =
      finite(record.groundSpeedKt) === null
        ? null
        : record.groundSpeedKt * KNOT_MPS;
    return aircraftLayerPartState(table, {
      klass: marker.klass,
      onGround: marker.onGround === true,
      heightAboveGroundM: null,
      altitudeM:
        finite(record.altitudeFt) === null ? null : record.altitudeFt * 0.3048,
      verticalRateMps:
        finite(record.verticalRateFpm) === null
          ? null
          : (record.verticalRateFpm * 0.3048) / 60,
      speedMps,
    });
  }

  function regime(preferences, pose) {
    if (!preferences?.models3d) return false;
    return pose.height < MODEL_ALT_CEIL_M;
  }

  function refreshEligibility(markers, preferences, pose) {
    const all = preferences.models3dMode === 'all';
    const cap = all ? MODEL_MAX_ALL : MODEL_MAX;
    const candidates = [];
    for (const [id, marker] of markers) {
      if (!marker.position) continue;
      const distanceSq = distanceSquared(pose.position, marker.position);
      if (distanceSq > MODEL_KEEP_M * MODEL_KEEP_M) continue;
      candidates.push([id, distanceSq, inView(pose, marker.position)]);
    }
    candidates.sort((a, b) => a[1] - b[1]);
    eligible = selectModelEligible(candidates, {
      cap,
      addDistSq: MODEL_ADD_M * MODEL_ADD_M,
      isModeled: (id) => models.has(id),
    });
    release([...models.keys()].filter((id) => !eligible.has(id)));
    for (const id of eligible) admit(id, markers.get(id), cap);
  }

  function placement(id, marker) {
    if (!marker.onGround) return marker.position;
    const record = models.get(id);
    // Height samples see through the draw sets (this set and the markers):
    // the vertical sample hits the tile skin, not this aircraft.
    const height = groundSnap?.heightFor?.(viewer, id, marker.position, {
      sets: groundSets,
    });
    if (!Number.isFinite(height)) return null;
    const at = toLonLatH(marker.position);
    if (!at) return null;
    return fromDegrees(at.lon, at.lat, height + (record?.bellyM || 0));
  }

  return {
    /** Ids whose model admission is current; the layer enriches these. */
    get eligible() {
      return eligible;
    },

    /**
     * Per-frame pass: re-derive eligibility at the fleet cadence, then place
     * every admitted model and hand each marker's visual to its model only
     * once the model is ready and placed.
     * @param {Map<string, object>} markers Layer markers (position, courseDeg,
     *   typeCode, category, onGround); `modelOwnsVisual` is written back.
     * @param {object} preferences `{ models3d, models3dMode }`.
     * @param {number} nowMs
     */
    frame(markers, preferences, nowMs) {
      if (destroyed) return;
      const pose = camera.pose();
      if (!regime(preferences, pose)) {
        if (models.size) releaseAll();
        eligible = new Set();
        for (const marker of markers.values()) marker.modelOwnsVisual = false;
        return;
      }
      if (nowMs - lastEligibilityAt >= FLEET_DR_INTERVAL_MS) {
        lastEligibilityAt = nowMs;
        refreshEligibility(markers, preferences, pose);
      }
      const horizon = horizonFrom(pose.position);
      const items = [];
      for (const [id, marker] of markers) {
        const record = models.get(id);
        marker.modelOwnsVisual = false;
        if (!record || !marker.position) continue;
        const spec = specOf(marker);
        if (!spec.url) continue;
        const url = resolveAsset(spec.url);
        const gltf = fleetModelSet()?.bytes?.get(spec.model);
        noteAsset(record, url, spec.bellyM);
        const position = placement(id, marker);
        const parts = partsOf(marker, spec);
        const shown =
          Boolean(position) && horizon.isPointVisible(marker.position);
        items.push({
          id,
          // Unplaced, it waits hidden where it last was (or at the marker).
          pos: position ?? marker.position,
          url,
          // Built from the bytes loaded up front: never fetched mid-session.
          ...(gltf ? { gltf } : {}),
          orientation: {
            heading:
              ((marker.courseDeg || 0) + MODEL_HEADING_OFFSET_DEG) *
              RADIANS_PER_DEGREE,
            pitch: 0,
            roll: 0,
          },
          scale: spec.scale,
          // The mesh's own colours (white, multiplied).
          tint: WHITE,
          colorBlend: aircraftModelBlend(false),
          environmentMap: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS.enabled,
          ...(parts ? { parts } : {}),
          show: shown,
        });
        if (shown && record.ready) marker.modelOwnsVisual = true;
      }
      if (items.length) set.upsert(items);
      release([...models.keys()].filter((id) => !markers.has(id)));
    },

    /**
     * Drop the model of every aircraft that is no longer a marker. The
     * layer calls this whenever markers expire: the per-frame pass does not
     * run once the last marker is gone.
     * @param {Map<string, object>|Set<string>} live Current marker ids.
     */
    retain(live) {
      if (destroyed) return;
      const gone = [...models.keys()].filter((id) => !live.has(id));
      if (!gone.length) return;
      release(gone);
      eligible = new Set([...eligible].filter((id) => live.has(id)));
    },

    /** Drop every model (3D off, layer disabled). */
    clear: releaseAll,

    /** Number of admitted models (tests and diagnostics). */
    get size() {
      return models.size;
    },

    /** The models set's id, for picks and height queries. */
    setId,

    /** Whether the set draws (with the layer). */
    get show() {
      return set.show;
    },
    set show(value) {
      if (!destroyed) set.show = value;
    },

    destroy() {
      releaseAll();
      destroyed = true;
      offReady();
      groundSnap?.clear?.();
      set.dispose();
    },
  };
}
