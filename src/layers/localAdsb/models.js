import * as geo from '../../geo/index.js';
import { selectModelEligible } from '../../data/modelEligibility.js';
import { civilAircraftModelSpec } from '../flights/modelSpec.js';
import {
  FLEET_DR_INTERVAL_MS,
  MODEL_ALL_ADD_M,
  MODEL_ALL_KEEP_M,
  MODEL_ALT_CEIL_M,
  MODEL_MAX,
  MODEL_MAX_ALL,
  MODEL_MIN_PX,
  MODEL_PROX_ADD_M,
  MODEL_PROX_KEEP_M,
} from '../flights/policy.js';

const specKey = (spec) => `${spec.url}@${spec.scale}`;

/**
 * 3D models for Local ADS-B aircraft under the DISPLAY rail's 3D toggle.
 *
 * Mirrors the public Flights fleet: models only below the altitude ceiling,
 * the same proximity/all caps and add/keep radii, the same visible-first
 * eligibility (`selectModelEligible`), the same per-class asset and scale
 * (`civilAircraftModelSpec`) and the same tint path (a MIX colour blend, here
 * magenta, as Flights tints military amber). Each model owns its matrix. A
 * billboard stays the visual until its model is loaded AND placed; a grounded
 * aircraft's model rides the one-shot ground snap plus the class belly
 * offset, and without a resolved ground it stays a billboard. The models
 * are drawn by the layer's renderer (its `models`: the shared aircraft
 * renderer's model part) and read the camera through its `view`.
 * @param {object} options
 * @param {object} options.renderer The layer's display (render/display.js).
 * @param {object} options.color Model tint (a colour with red/green/blue/alpha).
 * @param {(url: string) => string} options.resolveAsset
 * @param {object|null} [options.groundSnap] `createGroundSnap()` instance.
 * @returns {object}
 */
export function createLocalAdsbModels({
  renderer,
  color,
  resolveAsset,
  groundSnap = null,
}) {
  const draw = renderer.models;
  const view = renderer.view;
  /** @type {Map<string, object>} id -> admitted model */
  const models = new Map();
  /** @type {Map<string, number>} id -> generation of an in-flight load */
  const pending = new Map();
  let generation = 0;
  let destroyed = false;
  let lastEligibilityAt = 0;
  let eligible = new Set();
  const scratchCarto = geo.cartographic.create();
  const scratchGround = geo.cartesian3.create();

  function release(id) {
    pending.delete(id);
    const model = models.get(id);
    if (!model) return;
    models.delete(id);
    draw.remove(model);
    groundSnap?.forget?.(id);
  }

  function releaseAll() {
    for (const id of [...models.keys()]) release(id);
    pending.clear();
    generation += 1;
  }

  async function ensure(id, marker, cap) {
    const spec = civilAircraftModelSpec(marker.klass);
    const key = specKey(spec);
    const current = models.get(id);
    if (current && current._gevSpecKey === key) return;
    if (current) release(id);
    if (pending.has(id) || models.size + pending.size >= cap) return;
    const loadGeneration = generation;
    pending.set(id, loadGeneration);
    let model;
    try {
      model = await draw.loadFleet({
        url: resolveAsset(spec.url),
        minimumPixelSize: MODEL_MIN_PX,
        scale: spec.scale,
        // Bounding radius per scale unit (an engine that keeps
        // minimumPixelSize on the CPU reports the drawn scale with it).
        radiusM: spec.nativeRadiusM,
        color,
        blendAmount: spec.blendAmount,
        id,
      });
    } catch {
      if (pending.get(id) === loadGeneration) pending.delete(id);
      return;
    }
    const stale =
      destroyed ||
      pending.get(id) !== loadGeneration ||
      generation !== loadGeneration ||
      !eligible.has(id) ||
      models.has(id) ||
      specKey(civilAircraftModelSpec(marker.klass)) !== key;
    if (pending.get(id) === loadGeneration) pending.delete(id);
    if (stale) {
      draw.destroy(model);
      return;
    }
    model.id = id;
    model._gevSpecKey = key;
    model._gevBellyM = spec.bellyM;
    // Admitted, not yet the visual: placement turns it on.
    model.show = false;
    draw.add(model);
    models.set(id, model);
  }

  function regime(preferences) {
    if (!preferences?.models3d) return false;
    const height = view.camera?.positionCartographic?.height ?? Infinity;
    return height < MODEL_ALT_CEIL_M;
  }

  function refreshEligibility(markers, preferences) {
    const all = preferences.models3dMode === 'all';
    const cap = all ? MODEL_MAX_ALL : MODEL_MAX;
    const addM = all ? MODEL_ALL_ADD_M : MODEL_PROX_ADD_M;
    const keepM = all ? MODEL_ALL_KEEP_M : MODEL_PROX_KEEP_M;
    const cameraPosition = view.camera.positionWC;
    const inFrustum = view.frustumTester();
    const candidates = [];
    for (const [id, marker] of markers) {
      if (!marker.position) continue;
      const distanceSq = geo.cartesian3.distanceSquared(
        cameraPosition,
        marker.position,
      );
      if (distanceSq > keepM * keepM) continue;
      candidates.push([id, distanceSq, inFrustum(marker.position)]);
    }
    candidates.sort((a, b) => a[1] - b[1]);
    eligible = selectModelEligible(candidates, {
      cap,
      addDistSq: addM * addM,
      isModeled: (id) => models.has(id),
    });
    for (const id of [...models.keys(), ...pending.keys()])
      if (!eligible.has(id)) release(id);
    for (const id of eligible) void ensure(id, markers.get(id), cap);
  }

  function placement(id, marker) {
    if (!marker.onGround) return marker.position;
    const model = models.get(id);
    // The vertical sample must hit the tile skin, not this aircraft's own
    // billboard or model.
    const height = groundSnap?.heightFor?.(
      view.engine,
      id,
      marker.position,
      () => [id],
    );
    if (!Number.isFinite(height)) return null;
    const carto = geo.cartographic.fromCartesian(
      marker.position,
      geo.ellipsoid.WGS84,
      scratchCarto,
    );
    return geo.cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      height + (model?._gevBellyM || 0),
      geo.ellipsoid.WGS84,
      scratchGround,
    );
  }

  return {
    ...(import.meta.env?.DEV ? { qaModels: () => models } : {}),
    /** Ids whose model admission is current; the layer enriches these. */
    get eligible() {
      return eligible;
    },

    /**
     * Per-frame pass: re-derive eligibility at the fleet cadence, then place
     * every admitted model and hand each marker's visual to its model only
     * once the model is ready and placed.
     * @param {Map<string, object>} markers Layer markers (position, courseDeg,
     *   klass, onGround); `modelOwnsVisual` is written back.
     * @param {object} preferences `{ models3d, models3dMode }`.
     * @param {number} nowMs
     */
    frame(markers, preferences, nowMs) {
      if (destroyed) return;
      if (!regime(preferences)) {
        if (models.size || pending.size) releaseAll();
        eligible = new Set();
        for (const marker of markers.values()) marker.modelOwnsVisual = false;
        return;
      }
      if (nowMs - lastEligibilityAt >= FLEET_DR_INTERVAL_MS) {
        lastEligibilityAt = nowMs;
        refreshEligibility(markers, preferences);
      }
      const occluder = view.horizon();
      for (const [id, marker] of markers) {
        const model = models.get(id);
        marker.modelOwnsVisual = false;
        if (!model || !marker.position) continue;
        const position = placement(id, marker);
        if (!position || !occluder.isPointVisible(marker.position)) {
          model.show = false;
          continue;
        }
        // The renderer's pose: course + the Flights models' nose offset,
        // into the model's own matrix.
        draw.setPose(model, position, marker.courseDeg || 0);
        if (!model.ready) {
          model.show = false;
          continue;
        }
        model.show = true;
        marker.modelOwnsVisual = true;
      }
      for (const id of [...models.keys()]) if (!markers.has(id)) release(id);
    },

    /**
     * Drop the model, and any load still in flight, of every aircraft that
     * is no longer a marker. The layer calls this whenever markers expire:
     * the per-frame pass does not run once the last marker is gone.
     * @param {Map<string, object>|Set<string>} live Current marker ids.
     */
    retain(live) {
      if (destroyed) return;
      let dropped = false;
      for (const id of [...models.keys(), ...pending.keys()]) {
        if (live.has(id)) continue;
        release(id);
        eligible.delete(id);
        dropped = true;
      }
      if (dropped) eligible = new Set(eligible);
    },

    /** Drop every model (3D off, layer disabled). */
    clear: releaseAll,

    /** Number of admitted models (tests and diagnostics). */
    get size() {
      return models.size;
    },

    /** Drop every model; the renderer removes the collection (detach). */
    destroy() {
      destroyed = true;
      releaseAll();
      groundSnap?.clear?.();
    },
  };
}
