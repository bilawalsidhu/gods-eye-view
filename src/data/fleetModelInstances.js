import * as Cesium from 'cesium';
import { horizonOccluder } from './iconOrientation.js';
import { selectModelEligible } from './modelEligibility.js';
import { AIRCRAFT_ENVIRONMENT_MAP_OPTIONS } from './aircraftModelLighting.js';
import { fleetModelSet } from './fleetModels.js';

/**
 * Cesium models of the procedural fleet set (`fleetModels.js`), and the
 * icon-to-model handoff the Vessels, Transit and Rail layers share.
 */

/** Every fleet GLB is nose -X: opposite Cesium's heading 0. */
export const FLEET_HEADING_OFFSET_DEG = 180;

/**
 * Create a Cesium Model of `spec` from the up-front loaded bytes, so no model
 * is fetched mid-session. Each model keeps its own URL as its base path: the
 * glTF cache keys by it, and two models sharing one would share geometry.
 * Rejects when the set is not loaded or the model's GLB failed to load.
 * @param {object} spec `fleetModelSpec`.
 * @param {object} options Cesium `Model.fromGltfAsync` options.
 * @param {{resolveAsset?: (url: string) => string, set?: object|null,
 *   load?: (options: object) => Promise<object>}} [context]
 * @returns {Promise<object>} Cesium Model.
 */
export function createFleetModel(
  spec,
  options,
  {
    resolveAsset = (url) => url,
    set = fleetModelSet(),
    // Looked up when called, so a replaced `fromGltfAsync` (tests) is the one used.
    load = (o) => Cesium.Model.fromGltfAsync(o),
  } = {},
) {
  const bytes = set?.bytes?.get(spec?.model);
  if (!bytes)
    return Promise.reject(new Error(`fleet model ${spec?.model} not loaded`));
  return load({
    environmentMapOptions: AIRCRAFT_ENVIRONMENT_MAP_OPTIONS,
    ...options,
    gltf: bytes,
    basePath: resolveAsset(spec.url),
  });
}

const tintShaders = new Map();

/** Models under the NVG/FLIR styles render unlit, as aircraft models do. */
const IR_UNLIT_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.UNLIT,
});

/**
 * The custom shader that paints a route colour where a transit model's
 * `_TINT` vertex attribute marks it: drawn colour = vertex colour ×
 * mix(1, colour, _TINT). One shader per colour, shared by every model drawn in
 * it (Cesium compiles the program once; uniforms are per shader).
 * @param {Cesium.Color} color
 * @returns {Cesium.CustomShader}
 */
export function fleetTintShader(color) {
  const key = color.toCssHexString();
  let shader = tintShaders.get(key);
  if (!shader) {
    shader = new Cesium.CustomShader({
      mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
      uniforms: {
        u_routeColor: {
          type: Cesium.UniformType.VEC3,
          value: new Cesium.Cartesian3(color.red, color.green, color.blue),
        },
      },
      fragmentShaderText: `
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          vec3 route = czm_srgbToLinear(u_routeColor);
          material.diffuse *= mix(vec3(1.0), route, fsInput.attributes.tint);
        }
      `,
    });
    tintShaders.set(key, shader);
  }
  return shader;
}

/**
 * Write the world matrix of a fleet model standing at `position` heading
 * `headingDeg` (clockwise from north) into `result`, stretched by the spec's
 * beam and height scales relative to its length scale (a Model's own `scale`
 * carries the length scale, so its minimum pixel size still applies).
 * @param {Cesium.Cartesian3} position
 * @param {number} headingDeg
 * @param {object} spec `fleetModelSpec`.
 * @param {Cesium.Matrix4} result
 * @param {Cesium.HeadingPitchRoll} scratchHpr
 * @returns {Cesium.Matrix4}
 */
export function fleetModelMatrix(
  position,
  headingDeg,
  spec,
  result,
  scratchHpr,
) {
  scratchHpr.heading = Cesium.Math.toRadians(
    (headingDeg || 0) + FLEET_HEADING_OFFSET_DEG,
  );
  scratchHpr.pitch = 0;
  scratchHpr.roll = 0;
  Cesium.Transforms.headingPitchRollToFixedFrame(
    position,
    scratchHpr,
    Cesium.Ellipsoid.WGS84,
    undefined,
    result,
  );
  const [sx, sy, sz] = spec.scaleXYZ;
  if (sx > 0 && (sy !== sx || sz !== sx)) {
    // Cesium's glTF axis correction puts the model's length on local Y, its
    // beam on local X and its height on local Z.
    scratchScale.x = sy / sx;
    scratchScale.y = 1;
    scratchScale.z = sz / sx;
    Cesium.Matrix4.multiplyByScale(result, scratchScale, result);
  }
  return result;
}
const scratchScale = new Cesium.Cartesian3();

/**
 * 3D models for one layer's vehicles under the DISPLAY rail's 3D toggle (the
 * Flights layer's `models3d`/`models3dMode`), on the same rules the aircraft
 * layers follow: models only below the camera altitude ceiling, for the
 * nearest `cap` vehicles in the add/keep band, on-screen first. A vehicle's
 * icon stays the visual until its model is loaded and placed; the layer reads
 * `modelOwnsVisual` back from each item and hides that icon.
 *
 * Each frame the layer passes its vehicles as items:
 * `{position, headingDeg, spec, tint, pickId, show, groundLiftM}`,
 * `position` the point the model's origin stands on (the waterline, the road
 * or rail top; the spec's `elevationM` is added here), `groundLiftM` any lift
 * the layer's icon carries above that point (taken off again), `tint` a
 * Cesium.Color for a tinted model's route colour (or null), `show` false to
 * keep it hidden.
 *
 * Under the luminance-mapped NVG/FLIR styles (`irBoost`) models render
 * unlit flat white, as aircraft models do. With `waterline`, each model is
 * clipped at its origin's horizontal plane and only the part above it is
 * drawn: a ship's hull below the waterline would otherwise show through a
 * plain globe, which Cesium does not depth-test models against.
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {() => object|null} [options.display] `{models3d, models3dMode,
 *   irBoost}`.
 * @param {object} options.policy `{altitudeCeilingM, minimumPixelSize,
 *   cap, capAll, addM, addAllM, keepM, keepAllM, intervalMs}`.
 * @param {(url: string) => string} [options.resolveAsset]
 * @param {(spec: object, options: object) => Promise<object>} [options.createModel]
 * @param {boolean} [options.waterline] Clip each model at its waterline.
 * @returns {object}
 */
export function createFleetModelLayer({
  viewer,
  display = () => null,
  policy,
  waterline = false,
  resolveAsset = (url) => url,
  createModel = (spec, options) =>
    createFleetModel(spec, options, { resolveAsset }),
}) {
  const collection = new Cesium.PrimitiveCollection();
  viewer.scene.primitives.add(collection);
  /** @type {Map<string, object>} id -> admitted model */
  const models = new Map();
  /** @type {Map<string, number>} id -> generation of an in-flight load */
  const pending = new Map();
  let generation = 0;
  let destroyed = false;
  let lastEligibilityAt = -Infinity;
  let eligible = new Set();
  let settling = 0;
  /** Whether the models drawn now were built for the NVG/FLIR styles. */
  let irBoost = false;
  const scratchHpr = new Cesium.HeadingPitchRoll();
  const scratchSphere = new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 1);
  const scratchCarto = new Cesium.Cartographic();
  const scratchPosition = new Cesium.Cartesian3();

  function release(id) {
    pending.delete(id);
    const model = models.get(id);
    if (!model) return;
    models.delete(id);
    if (!collection.isDestroyed()) collection.remove(model);
  }

  function releaseAll() {
    for (const id of models.keys()) release(id);
    pending.clear();
    generation += 1;
  }

  function preferences() {
    return display?.() || null;
  }

  function regime(prefs) {
    if (!prefs?.models3d || !fleetModelSet()) return false;
    const height = viewer.camera?.positionCartographic?.height ?? Infinity;
    return height < policy.altitudeCeilingM;
  }

  function shaderFor(item) {
    if (irBoost) return IR_UNLIT_SHADER;
    return item.spec.tinted && item.tint
      ? fleetTintShader(item.tint)
      : undefined;
  }

  /** The clipping that keeps a model's part above its waterline. */
  function waterlineClipping() {
    return new Cesium.ClippingPlaneCollection({
      // The planes sit in the model matrix's frame: its origin is the
      // waterline and its Z axis the local vertical, so the plane z = 0 with
      // its normal up keeps the hull above the water.
      planes: [new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_Z, 0)],
      edgeWidth: 0,
    });
  }

  async function ensure(id, item, cap) {
    const key = item.spec.key;
    const current = models.get(id);
    if (current && current._gevSpecKey === key) return;
    if (current) release(id);
    if (pending.has(id) || models.size + pending.size >= cap) return;
    const loadGeneration = generation;
    pending.set(id, loadGeneration);
    let model;
    try {
      model = await createModel(item.spec, {
        asynchronous: false,
        minimumPixelSize: policy.minimumPixelSize,
        scale: item.spec.scale,
        customShader: shaderFor(item),
        ...(irBoost
          ? {
              color: Cesium.Color.WHITE,
              colorBlendMode: Cesium.ColorBlendMode.MIX,
              colorBlendAmount: 1,
            }
          : {}),
        ...(waterline ? { clippingPlanes: waterlineClipping() } : {}),
        id: item.pickId ?? id,
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
      models.has(id);
    if (pending.get(id) === loadGeneration) pending.delete(id);
    if (stale) {
      model.destroy?.();
      return;
    }
    model.id = item.pickId ?? id;
    model._gevSpecKey = key;
    model._gevTint = item.spec.tinted && !irBoost ? item.tint : null;
    model._gevIrBoost = irBoost;
    // Admitted, not yet the visual: placement turns it on.
    model.show = false;
    collection.add(model);
    models.set(id, model);
  }

  function refreshEligibility(items, prefs) {
    const all = prefs.models3dMode === 'all';
    const cap = all ? policy.capAll : policy.cap;
    const addM = all ? policy.addAllM : policy.addM;
    const keepM = all ? policy.keepAllM : policy.keepM;
    const camera = viewer.camera;
    const cameraPosition = camera.positionWC;
    const cull = camera.frustum.computeCullingVolume(
      cameraPosition,
      camera.directionWC,
      camera.upWC,
    );
    const candidates = [];
    for (const [id, item] of items) {
      if (!item.position || item.show === false || !item.spec) continue;
      const distanceSq = Cesium.Cartesian3.distanceSquared(
        cameraPosition,
        item.position,
      );
      if (distanceSq > keepM * keepM) continue;
      Cesium.Cartesian3.clone(item.position, scratchSphere.center);
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
    for (const id of models.keys()) if (!eligible.has(id)) release(id);
    for (const id of pending.keys()) if (!eligible.has(id)) release(id);
    for (const id of eligible) void ensure(id, items.get(id), cap);
  }

  /** Where the model's origin stands: the item's point raised by the spec's elevation. */
  function placement(item) {
    const lift = (item.spec.elevationM || 0) - (item.groundLiftM || 0);
    if (!lift) return item.position;
    const carto = Cesium.Cartographic.fromCartesian(
      item.position,
      Cesium.Ellipsoid.WGS84,
      scratchCarto,
    );
    if (!carto) return item.position;
    return Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      carto.height + lift,
      Cesium.Ellipsoid.WGS84,
      scratchPosition,
    );
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
      if (!regime(prefs)) {
        settling = 0;
        if (models.size || pending.size) releaseAll();
        eligible = new Set();
        for (const item of items.values()) item.modelOwnsVisual = false;
        return false;
      }
      // A model's look under NVG/FLIR is set when it is built (a custom
      // shader on a ready model does not take), so a style change rebuilds.
      const boost = prefs.irBoost === true;
      if (boost !== irBoost) {
        releaseAll();
        irBoost = boost;
        lastEligibilityAt = -Infinity;
      }
      if (nowMs - lastEligibilityAt >= policy.intervalMs) {
        lastEligibilityAt = nowMs;
        refreshEligibility(items, prefs);
      }
      const occluder = horizonOccluder(viewer.camera);
      let drawn = false;
      settling = pending.size;
      for (const [id, item] of items) {
        const model = models.get(id);
        item.modelOwnsVisual = false;
        if (!model) continue;
        if (
          !item.position ||
          item.show === false ||
          !occluder.isPointVisible(item.position)
        ) {
          model.show = false;
          continue;
        }
        if (item.spec.key !== model._gevSpecKey) {
          // A new type or size: the next eligibility pass loads it.
          model.show = false;
          lastEligibilityAt = -Infinity;
          continue;
        }
        const tint = item.spec.tinted && !irBoost ? item.tint : null;
        if (tint && !Cesium.Color.equals(tint, model._gevTint)) {
          model.customShader = fleetTintShader(tint);
          model._gevTint = tint;
        }
        fleetModelMatrix(
          placement(item),
          item.headingDeg,
          item.spec,
          model.modelMatrix,
          scratchHpr,
        );
        if (!model.ready) {
          model.show = false;
          settling += 1;
          continue;
        }
        model.show = true;
        item.modelOwnsVisual = true;
        drawn = true;
      }
      for (const id of models.keys()) if (!items.has(id)) release(id);
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

    /** The model drawing `id`, if one is admitted. */
    modelFor(id) {
      return models.get(id) || null;
    },

    /** Show or hide every model (the layer's own visibility). */
    setVisible(show) {
      if (!collection.isDestroyed()) collection.show = show;
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
      if (!viewer.isDestroyed?.() && !collection.isDestroyed())
        viewer.scene.primitives.remove(collection);
    },
  };
}
