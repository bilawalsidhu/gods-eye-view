import { selectModelEligible } from './modelEligibility.js';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';
import { fleetModelSet, fleetPartTable } from './fleetModels.js';
import { findCamera, findDraw } from '../render/rendererOf.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { horizonFrom } from '../geo/horizon.js';
import {
  distanceSquared,
  dot,
  RADIANS_PER_DEGREE,
  sub,
} from '../geo/vector.js';

/**
 * Models of the procedural fleet set (`fleetModels.js`) drawn through the
 * renderer's draw port, and the icon-to-model handoff the Vessels, Transit
 * and Rail layers share.
 */

/** Every fleet GLB is nose -X: opposite the draw contract's heading 0. */
export const FLEET_HEADING_OFFSET_DEG = 180;

/** How long (ms) a model whose load failed waits before it loads again. */
const RETRY_MS = 5000;

/** A white tint: what a model under the NVG/FLIR styles draws with. */
const WHITE = Object.freeze([1, 1, 1, 1]);

/**
 * A colour as the draw contract takes it: a CSS string or `[r, g, b, a]`
 * as given, `{red, green, blue, alpha}` as an array; null for none.
 */
export function fleetColor(color) {
  if (color === undefined || color === null) return null;
  if (typeof color === 'string' || Array.isArray(color)) return color;
  if (typeof color.red === 'number')
    return [color.red, color.green, color.blue, color.alpha ?? 1];
  return null;
}

/**
 * The per-axis stretch a fleet spec draws with on top of its length scale,
 * along the model's glTF axes (`x` its length, `y` its height, `z` its
 * beam), or undefined when it keeps its proportions.
 * @param {object} spec `fleetModelSpec`.
 * @returns {[number, number, number]|undefined}
 */
export function fleetAxisScale(spec) {
  const [length, beam, height] = spec?.scaleXYZ ?? [];
  if (!(length > 0) || (beam === length && height === length)) return;
  return [1, height / length, beam / length];
}

/**
 * Whether `point` is inside the eye's view cone (`pose`), a metre's slack.
 * @param {object} pose The camera port's pose.
 * @param {{x:number,y:number,z:number}} point
 * @returns {boolean}
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

/** Two colours as `fleetColor` gives them, alike (arrays element by element). */
function sameColor(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let instances = 0;

/**
 * 3D models for one layer's vehicles under the DISPLAY rail's 3D toggle (the
 * Flights layer's `models3d`/`models3dMode`), on the same rules the aircraft
 * layers follow: models only below the camera altitude ceiling, for the
 * nearest `cap` vehicles in the add/keep band, on-screen first. A vehicle's
 * icon stays the visual until its model is loaded and placed; the layer reads
 * `modelOwnsVisual` back from each item and hides that icon.
 *
 * The models are one `models` set of the viewer's draw port, built from the
 * fleet set's bytes loaded up front (`gltf`), so none is fetched
 * mid-session. Without a draw port that draws models the layer stays icons.
 *
 * Each frame the layer passes its vehicles as items:
 * `{position, headingDeg, spec, tint, pickId, show, groundLiftM}`,
 * `position` the ECEF point the model's origin stands on (the waterline,
 * the road or rail top; the spec's `elevationM` is added here),
 * `groundLiftM` any lift the layer's icon carries above that point (taken
 * off again), `tint` the route colour a tinted model paints where its
 * `_TINT` attribute marks it (a CSS colour or `[r, g, b, a]`, or null),
 * `pickId` what a pick on the model hands back (the item's `meta`), `show`
 * false to keep it hidden.
 *
 * Under the luminance-mapped NVG/FLIR styles (`irBoost`) models draw unlit
 * flat white, as aircraft models do. With `waterline`, each model is clipped
 * at its origin's horizontal plane and only the part above it is drawn: a
 * ship's hull below the waterline would otherwise show through a plain
 * globe, which models are not depth-tested against.
 * @param {object} options
 * @param {object} options.viewer The scene host.
 * @param {() => object|null} [options.display] `{models3d, models3dMode,
 *   irBoost}`.
 * @param {object} options.policy `{altitudeCeilingM, cap, capAll, addM,
 *   keepM, intervalMs}`: both 3D modes share the add/keep radii and differ
 *   by their caps. Models are drawn at their true size.
 * @param {(url: string) => string} [options.resolveAsset]
 * @param {boolean} [options.waterline] Clip each model at its waterline.
 * @param {(item: object, table: object) => object|undefined} [options.partState]
 *   The moving parts a vehicle's model is posed with (`ModelItem.parts`),
 *   from its item and its model's part table (`modelPartDrivers.js`); asked
 *   only for a model that has a part table.
 * @param {object} [options.draw] Stands in for the viewer's draw port (tests).
 * @returns {object}
 */
export function createFleetModelLayer({
  viewer,
  display = () => null,
  policy,
  waterline = false,
  resolveAsset = (url) => url,
  partState = null,
  draw,
}) {
  const port = draw ?? findDraw(viewer);
  const set =
    typeof port?.models === 'function'
      ? port.models({ id: `fleet-models:${++instances}` })
      : null;
  /** @type {Map<string, object>} id -> admitted model */
  const models = new Map();
  let destroyed = false;
  let lastEligibilityAt = -Infinity;
  let eligible = new Set();
  let settling = 0;
  const offs = set
    ? [
        set.on('ready', (id) => {
          const record = models.get(id);
          if (!record) return;
          record.ready = true;
          record.failedAt = 0;
        }),
        set.on('loadFailed', (id) => {
          const record = models.get(id);
          if (record) record.failedAt = Date.now();
        }),
      ]
    : [];

  function release(id) {
    if (!models.delete(id)) return;
    set?.remove([id]);
  }

  function releaseAll() {
    if (models.size) set?.clear();
    models.clear();
  }

  function preferences() {
    return display?.() || null;
  }

  function pose() {
    try {
      return findCamera(viewer)?.pose() ?? null;
    } catch {
      return null;
    }
  }

  function regime(prefs, eye = pose()) {
    if (!set || !prefs?.models3d || !fleetModelSet()) return false;
    const height = eye?.height ?? Infinity;
    return height < policy.altitudeCeilingM;
  }

  function admit(id, item, cap) {
    const fleet = fleetModelSet();
    const gltf = fleet?.bytes?.get(item.spec.model);
    // A model whose GLB did not load draws nothing: the icon stays.
    if (!gltf) return;
    const current = models.get(id);
    if (current && current.specKey === item.spec.key) return;
    if (current) release(id);
    if (models.size >= cap) return;
    models.set(id, {
      specKey: item.spec.key,
      url: resolveAsset(item.spec.url),
      gltf,
      ready: false,
      failedAt: 0,
      sent: null,
    });
  }

  function refreshEligibility(items, prefs, eye) {
    const all = prefs.models3dMode === 'all';
    const cap = all ? policy.capAll : policy.cap;
    const { addM, keepM } = policy;
    const candidates = [];
    for (const [id, item] of items) {
      if (!item.position || item.show === false || !item.spec?.url) continue;
      const distanceSq = distanceSquared(eye.position, item.position);
      if (distanceSq > keepM * keepM) continue;
      candidates.push([id, distanceSq, inView(eye, item.position)]);
    }
    candidates.sort((a, b) => a[1] - b[1]);
    eligible = selectModelEligible(candidates, {
      cap,
      addDistSq: addM * addM,
      isModeled: (id) => models.has(id),
    });
    for (const id of [...models.keys()]) if (!eligible.has(id)) release(id);
    for (const id of eligible) admit(id, items.get(id), cap);
  }

  /** Where the model's origin stands: the item's point raised by the spec's elevation. */
  function placement(item) {
    const lift = (item.spec.elevationM || 0) - (item.groundLiftM || 0);
    if (!lift) return item.position;
    const at = toLonLatH(item.position);
    if (!at) return item.position;
    return fromDegrees(at.lon, at.lat, at.height + lift);
  }

  /** The part state an item's model is posed with, or undefined. */
  function partsOf(item) {
    if (!partState) return undefined;
    const table = fleetPartTable(fleetModelSet(), item.spec?.model);
    return table ? partState(item, table) : undefined;
  }

  /** The draw item for an admitted model, as the set draws it, at `at`. */
  function itemOf(id, record, item, show, boost, at, parts) {
    const mask = item.spec.tinted && !boost ? fleetColor(item.tint) : null;
    return {
      id,
      pos: { x: at.x, y: at.y, z: at.z },
      url: record.url,
      gltf: record.gltf,
      orientation: {
        heading:
          ((item.headingDeg || 0) + FLEET_HEADING_OFFSET_DEG) *
          RADIANS_PER_DEGREE,
        pitch: 0,
        roll: 0,
      },
      scale: item.spec.scale,
      ...(fleetAxisScale(item.spec)
        ? { axisScale: fleetAxisScale(item.spec) }
        : {}),
      environmentMap: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS.enabled,
      ...(boost
        ? {
            shading: 'unlit',
            tint: WHITE,
            colorBlend: { mode: 'mix', amount: 1 },
          }
        : { shading: 'pbr' }),
      ...(mask ? { maskColor: mask } : {}),
      ...(waterline ? { clip: 'belowOrigin' } : {}),
      ...(parts ? { parts } : {}),
      meta: item.pickId ?? id,
      show,
    };
  }

  /**
   * The item to write for a record, or null when nothing it draws changed:
   * what it was last written with is compared value by value, and the item
   * is built only when something did (a fleet passes every model each
   * frame, and most of what it draws stays).
   */
  function changed(id, record, item, show, boost) {
    const at = placement(item);
    const heading = item.headingDeg || 0;
    const mask = item.spec.tinted && !boost ? fleetColor(item.tint) : null;
    const meta = item.pickId ?? id;
    const parts = partsOf(item);
    const partsKey = parts ? JSON.stringify(parts) : '';
    const sent = record.sent;
    if (
      sent !== null &&
      sent.x === at.x &&
      sent.y === at.y &&
      sent.z === at.z &&
      sent.heading === heading &&
      sent.specKey === item.spec.key &&
      sameColor(sent.mask, mask) &&
      sent.boost === boost &&
      sent.show === show &&
      sent.meta === meta &&
      sent.partsKey === partsKey
    )
      return null;
    const next = (record.sent ??= {});
    next.x = at.x;
    next.y = at.y;
    next.z = at.z;
    next.heading = heading;
    next.specKey = item.spec.key;
    // A colour array is kept as a copy: the layer may change its own.
    next.mask = Array.isArray(mask) ? [...mask] : mask;
    next.boost = boost;
    next.show = show;
    next.meta = meta;
    next.partsKey = partsKey;
    return itemOf(id, record, item, show, boost, at, parts);
  }

  return {
    /** Ids whose model admission is current. */
    get eligible() {
      return eligible;
    },

    /**
     * Per-frame pass: re-derive eligibility at the policy's cadence, then
     * place every admitted model and hand each item's visual to its model
     * only once the model is ready and placed (`item.modelOwnsVisual`).
     * @param {Map<string, object>} items
     * @param {number} nowMs
     * @returns {boolean} Whether any model is drawn.
     */
    frame(items, nowMs) {
      if (destroyed) return false;
      const prefs = preferences();
      const eye = pose();
      if (!eye || !regime(prefs, eye)) {
        settling = 0;
        if (models.size) releaseAll();
        eligible = new Set();
        for (const item of items.values()) item.modelOwnsVisual = false;
        return false;
      }
      const boost = prefs.irBoost === true;
      if (nowMs - lastEligibilityAt >= policy.intervalMs) {
        lastEligibilityAt = nowMs;
        refreshEligibility(items, prefs, eye);
      }
      for (const item of items.values()) item.modelOwnsVisual = false;
      const horizon = horizonFrom(eye.position);
      const writes = [];
      let drawn = false;
      settling = 0;
      for (const [id, record] of models) {
        const item = items.get(id);
        if (!item) {
          release(id);
          continue;
        }
        if (item.spec?.key !== record.specKey) {
          // A new type or size: the next eligibility pass admits it.
          lastEligibilityAt = -Infinity;
          release(id);
          continue;
        }
        if (record.failedAt && Date.now() - record.failedAt >= RETRY_MS) {
          // Removed and added again, the set loads it again.
          record.failedAt = 0;
          record.sent = null;
          record.ready = false;
          set.remove([id]);
        }
        const visible =
          !!item.position &&
          item.show !== false &&
          horizon.isPointVisible(item.position);
        if (!visible) {
          if (record.sent !== null) {
            const write = changed(id, record, item, false, boost);
            if (write) writes.push(write);
          }
          continue;
        }
        // Placed before the readiness test: its first drawn frame is here.
        const show = record.ready;
        const write = changed(id, record, item, show, boost);
        if (write) writes.push(write);
        if (!show) {
          if (!record.failedAt) settling += 1;
          continue;
        }
        item.modelOwnsVisual = true;
        drawn = true;
      }
      if (writes.length) set.upsert(writes);
      return drawn;
    },

    /**
     * Models loading or not yet ready after the last frame: the layer keeps
     * frames coming while any are, so each one takes over as soon as it can.
     */
    get settling() {
      return settling;
    },

    /**
     * Whether models are drawn now: 3D on, the set loaded and the camera
     * below the altitude ceiling. A layer skips building items while not.
     * @returns {boolean}
     */
    active() {
      return !destroyed && regime(preferences());
    },

    /** The record of the model drawing `id`, if one is admitted. */
    modelFor(id) {
      return models.get(id) || null;
    },

    /** Show or hide every model (the layer's own visibility). */
    setVisible(show) {
      if (set) set.show = show;
    },

    /** Drop every model (3D off, layer disabled). */
    clear: releaseAll,

    /** Number of admitted models (tests and diagnostics). */
    get size() {
      return models.size;
    },

    /** The draw set's id, for picks and height queries to name it. */
    get setId() {
      return set?.id ?? null;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseAll();
      for (const off of offs) off();
      set?.dispose();
    },
  };
}
