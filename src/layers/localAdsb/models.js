import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { selectModelEligible } from '../../data/modelEligibility.js';
import { civilAircraftModelSpec } from '../flights/modelSpec.js';
import {
  FLEET_DR_INTERVAL_MS,
  MODEL_ALL_ADD_M,
  MODEL_ALL_KEEP_M,
  MODEL_ALT_CEIL_M,
  MODEL_HEADING_OFFSET_DEG,
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
 * offset, and without a resolved ground it stays a billboard.
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {Cesium.Color} options.color Model tint.
 * @param {(url: string) => string} options.resolveAsset
 * @param {object|null} [options.groundSnap] `createGroundSnap()` instance.
 * @param {(options: object) => Promise<object>} [options.loadModel]
 * @returns {object}
 */
export function createLocalAdsbModels({
  viewer,
  color,
  resolveAsset,
  groundSnap = null,
  loadModel = (options) => Cesium.Model.fromGltfAsync(options),
}) {
  const collection = new Cesium.PrimitiveCollection();
  viewer.scene.primitives.add(collection);
  /** @type {Map<string, object>} id -> admitted model */
  const models = new Map();
  /** @type {Map<string, number>} id -> generation of an in-flight load */
  const pending = new Map();
  let generation = 0;
  let destroyed = false;
  let lastEligibilityAt = 0;
  let eligible = new Set();
  const scratchHpr = new Cesium.HeadingPitchRoll();
  const scratchSphere = new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 1);
  const scratchCarto = new Cesium.Cartographic();
  const scratchGround = new Cesium.Cartesian3();

  function release(id) {
    pending.delete(id);
    const model = models.get(id);
    if (!model) return;
    models.delete(id);
    if (!collection.isDestroyed()) collection.remove(model);
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
      model = await loadModel({
        url: resolveAsset(spec.url),
        asynchronous: false,
        minimumPixelSize: MODEL_MIN_PX,
        scale: spec.scale,
        color,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: spec.blendAmount,
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
      model.destroy?.();
      return;
    }
    model.id = id;
    model._gevSpecKey = key;
    model._gevBellyM = spec.bellyM;
    // Admitted, not yet the visual: placement turns it on.
    model.show = false;
    collection.add(model);
    models.set(id, model);
  }

  function regime(preferences) {
    if (!preferences?.models3d) return false;
    const height = viewer.camera?.positionCartographic?.height ?? Infinity;
    return height < MODEL_ALT_CEIL_M;
  }

  function refreshEligibility(markers, preferences) {
    const all = preferences.models3dMode === 'all';
    const cap = all ? MODEL_MAX_ALL : MODEL_MAX;
    const addM = all ? MODEL_ALL_ADD_M : MODEL_PROX_ADD_M;
    const keepM = all ? MODEL_ALL_KEEP_M : MODEL_PROX_KEEP_M;
    const camera = viewer.camera;
    const cameraPosition = camera.positionWC;
    const cull = camera.frustum.computeCullingVolume(
      cameraPosition,
      camera.directionWC,
      camera.upWC,
    );
    const candidates = [];
    for (const [id, marker] of markers) {
      if (!marker.position) continue;
      const distanceSq = Cesium.Cartesian3.distanceSquared(
        cameraPosition,
        marker.position,
      );
      if (distanceSq > keepM * keepM) continue;
      Cesium.Cartesian3.clone(marker.position, scratchSphere.center);
      candidates.push([
        id,
        distanceSq,
        cull.computeVisibility(scratchSphere) !== Cesium.Intersect.OUTSIDE,
      ]);
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
    const height = groundSnap?.heightFor?.(viewer, id, marker.position, () =>
      [marker.entity, model].filter(Boolean),
    );
    if (!Number.isFinite(height)) return null;
    const carto = Cesium.Cartographic.fromCartesian(
      marker.position,
      Cesium.Ellipsoid.WGS84,
      scratchCarto,
    );
    return Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      height + (model?._gevBellyM || 0),
      Cesium.Ellipsoid.WGS84,
      scratchGround,
    );
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
      const occluder = horizonOccluder(viewer.camera);
      for (const [id, marker] of markers) {
        const model = models.get(id);
        marker.modelOwnsVisual = false;
        if (!model || !marker.position) continue;
        const position = placement(id, marker);
        if (!position || !occluder.isPointVisible(marker.position)) {
          model.show = false;
          continue;
        }
        scratchHpr.heading = Cesium.Math.toRadians(
          (marker.courseDeg || 0) + MODEL_HEADING_OFFSET_DEG,
        );
        scratchHpr.pitch = 0;
        scratchHpr.roll = 0;
        Cesium.Transforms.headingPitchRollToFixedFrame(
          position,
          scratchHpr,
          Cesium.Ellipsoid.WGS84,
          undefined,
          model.modelMatrix,
        );
        if (!model.ready) {
          model.show = false;
          continue;
        }
        model.show = true;
        marker.modelOwnsVisual = true;
      }
      for (const id of [...models.keys()]) if (!markers.has(id)) release(id);
    },

    /** Drop every model (3D off, layer disabled). */
    clear: releaseAll,

    /** Number of admitted models (tests and diagnostics). */
    get size() {
      return models.size;
    },

    destroy() {
      destroyed = true;
      releaseAll();
      groundSnap?.clear?.();
      if (!viewer.isDestroyed?.() && !collection.isDestroyed())
        viewer.scene.primitives.remove(collection);
    },
  };
}
