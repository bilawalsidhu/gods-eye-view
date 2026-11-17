/**
 * @module render/cesium/drawModels
 * @description The Cesium draw port's `models` sets: one `Cesium.Model` per
 * item in the set's collection, changed where it is. An update that keeps an
 * item's `url` re-poses and restyles its model in place (position,
 * orientation, scale, `axisScale` and pixel bounds, `shading`, `tint`,
 * `colorBlend`, `maskColor`, `clip`, `environmentMap`, `displayRange`,
 * `show`); only a new `url` loads again, and the old model keeps drawing
 * until the new one is ready, so a swap never blinks. `ready` fires once per
 * load, when the model has loaded and is posed. An item with its `gltf`
 * bytes is built from them; its url is then not fetched.
 *
 * What Cesium has no option for runs each frame before the scene draws:
 * `maxPixelSize` (the scale capped so the bounding sphere spans at most that
 * many drawing-buffer pixels at its distance from the eye, as Cesium
 * measures `minPixelSize`), `scaleByDistance`, `fadeByDistance` (the tint's
 * alpha), the set's `horizonCull`, and its `recede`: the tint's alpha times
 * the focus and haze (`render/recession.js`), written again once that moves
 * by more than `RECEDE_WRITE_EPSILON`. A model of a set that does not
 * recede draws at its tint's alpha times its `focus`.
 *
 * A failed load fires `loadFailed` (after the frame Cesium reported it in,
 * so a listener may change the set), and is tried again when its item is
 * next updated, once `MODEL_RETRY_MS` has passed.
 *
 * `shading: 'thermal'` draws the model unlit and white-hot (its texture
 * left out), then tinted as asked: a hot target, as the thermal views draw
 * them. Heights are absolute: models clamp nothing.
 */
import * as Cesium from 'cesium';
import {
  recedeFactors,
  recedeFrame,
  recedeParams,
  recededAlpha,
} from '../recession.js';

const BLEND_MODES = {
  highlight: Cesium.ColorBlendMode.HIGHLIGHT,
  replace: Cesium.ColorBlendMode.REPLACE,
  mix: Cesium.ColorBlendMode.MIX,
};

/**
 * How long a failed load waits before an update of its item tries the url
 * again (a fleet updates every frame; a dropped request or a server
 * hiccup should not leave the item without its model for good).
 */
export const MODEL_RETRY_MS = 5000;

/**
 * How far a receding model's emphasis (focus and haze) moves before its
 * colour is written again: an eye in motion would otherwise write every
 * model's colour every frame.
 */
export const RECEDE_WRITE_EPSILON = 0.005;

/** Cesium's own blend amount, for a `mix` that names none. */
const DEFAULT_MIX = 0.5;

let unlitShader = null;
let thermalShader = null;

/** Mask shaders by shading and colour: one per pair, shared by its models. */
const maskShaders = new Map();

/**
 * The custom shader that paints `mask` where a model's `_TINT` vertex
 * attribute marks it: drawn colour = colour × mix(1, mask, _TINT), unlit
 * under `unlit` shading.
 */
function maskShaderOf(shading, mask) {
  const key = `${shading === 'unlit' ? 'unlit' : 'pbr'}|${mask.toCssHexString()}`;
  let shader = maskShaders.get(key);
  if (!shader) {
    shader = new Cesium.CustomShader({
      mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
      ...(shading === 'unlit'
        ? { lightingModel: Cesium.LightingModel.UNLIT }
        : {}),
      uniforms: {
        u_maskColor: {
          type: Cesium.UniformType.VEC3,
          value: new Cesium.Cartesian3(mask.red, mask.green, mask.blue),
        },
      },
      fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 mask = czm_srgbToLinear(u_maskColor);
  material.diffuse *= mix(vec3(1.0), mask, fsInput.attributes.tint);
}`,
    });
    maskShaders.set(key, shader);
  }
  return shader;
}

/**
 * The custom shader an entry's item draws with: its mask colour's (but under
 * `thermal`), else its `shading`'s.
 */
function entryShader(entry) {
  const shading = entry.item.shading;
  // Kept while its shading and mask colour are: a fleet re-poses every
  // frame with the same look.
  if (entry.shaderShading === shading && entry.shaderMask === entry.mask)
    return entry.shader;
  entry.shader =
    entry.mask && shading !== 'thermal'
      ? maskShaderOf(shading, entry.mask)
      : shaderOf(shading);
  entry.shaderShading = shading;
  entry.shaderMask = entry.mask;
  return entry.shader;
}

/**
 * A clipping plane through the model's origin, keeping what is above it:
 * the planes sit in the model matrix's frame, whose origin is the item's
 * position and whose Z axis is the local vertical. One per model: a
 * collection belongs to the model it clips.
 */
function belowOriginClip() {
  return new Cesium.ClippingPlaneCollection({
    planes: [new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_Z, 0)],
    edgeWidth: 0,
  });
}

/** The custom shader a `shading` draws with; undefined for `pbr`. */
function shaderOf(shading) {
  if (shading === 'unlit')
    return (unlitShader ??= new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
    }));
  if (shading === 'thermal')
    return (thermalShader ??= new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
      fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  material.diffuse = vec3(1.0);
}`,
    }));
  return undefined;
}

/** A contract distance curve's value at `distance`: linear, clamped. */
export function nearFarValue(curve, distance) {
  if (!curve) return 1;
  const { near, nearValue, far, farValue } = curve;
  if (!(far > near)) return distance <= near ? nearValue : farValue;
  const t = Math.min(1, Math.max(0, (distance - near) / (far - near)));
  return nearValue + (farValue - nearValue) * t;
}

/**
 * The scale that caps a model's bounding sphere (radius `radiusM` at scale
 * 1) at `maxPixelSize` pixels, `metresPerPixel` at its distance; `scale`
 * when it is under the cap already.
 */
export function cappedScale(scale, radiusM, metresPerPixel, maxPixelSize) {
  if (
    !(maxPixelSize > 0) ||
    !(radiusM > 0) ||
    !(metresPerPixel > 0) ||
    !Number.isFinite(metresPerPixel)
  )
    return scale;
  const cap = (maxPixelSize * metresPerPixel) / (2 * radiusM);
  return Math.min(scale, cap);
}

const scratchHpr = new Cesium.HeadingPitchRoll();
const scratchAxes = new Cesium.Cartesian3();
const scratchMatrix = new Cesium.Matrix4();
const scratchSphere = new Cesium.BoundingSphere();
const scratchColor = new Cesium.Color();
const scratchFactors = { scale: 1, alpha: 1, limbRatio: null };
const scratchFrame = { active: false, limbM: 1, strength: 0 };
/** The colour last written to each model. */
const writtenColors = new WeakMap();
/** Written to a model drawn in its own colours: no colour at all. */
const NO_COLOR = Symbol('drawModels.noColor');
/** What the per-frame pass found, for a model it does not run on. */
const STILL = Object.freeze({ scale: 1, alpha: 1, shown: true });

/** An item's position as Cesium's, into `result`. */
function positionOf(pos, result) {
  if ('x' in pos)
    return Cesium.Cartesian3.fromElements(pos.x, pos.y, pos.z, result);
  return Cesium.Cartesian3.fromDegrees(
    pos.lon,
    pos.lat,
    pos.height ?? 0,
    Cesium.Ellipsoid.WGS84,
    result,
  );
}

/** A tint as a key: a CSS string as it is, an RGBA array joined. */
const tintKey = (tint) =>
  tint === undefined || tint === null
    ? null
    : typeof tint === 'string'
      ? tint
      : tint.join(',');

/** Why a load failed, as `loadFailed` reports it. */
function failureMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = error === undefined || error === null ? '' : String(error);
  return text && text !== '[object Object]' ? text : 'the model did not load';
}

/** Whether an item needs the per-frame pass. */
const needsFrame = (item, spec) =>
  item.maxPixelSize > 0 ||
  Boolean(item.scaleByDistance) ||
  Boolean(item.fadeByDistance) ||
  Boolean(spec.horizonCull) ||
  Boolean(spec.recede);

/** An item's focus, 0..1. */
const focusOf = (item) =>
  Number.isFinite(item.focus) ? Math.min(1, Math.max(0, item.focus)) : 1;

/**
 * The models part of a Cesium draw port.
 * @param {{scene: object, toColor: Function, pickId: Function,
 *   replaceHost: Function, horizonNow: () => object|null,
 *   requestRender: () => void}} options From the draw port: its colour
 *   conversion, pick ids, host swap, horizon and render request.
 */
export function createModelSets({
  scene,
  toColor,
  pickId,
  replaceHost,
  horizonNow,
  requestRender,
}) {
  /** The set's host, made once: its models are changed where they are. */
  function hostOf(record) {
    if (record.host && !record.host.isDestroyed?.()) return record.host;
    const host = new Cesium.PrimitiveCollection();
    host.loading = 0;
    host.failed = 0;
    record.models = new Map();
    replaceHost(record, host);
    return host;
  }

  /** Each live entry's pick id, for height queries to see through. */
  function notePickIds(record) {
    record.pickIds = [];
    for (const entry of record.models.values())
      record.pickIds.push(entry.pickId);
  }

  function drop(record, id) {
    const entry = record.models.get(id);
    if (!entry) return;
    record.models.delete(id);
    unload(record, entry);
  }

  /** Let go of an entry's models and its load. */
  function unload(record, entry) {
    const host = record.host;
    cancel(record, entry);
    if (entry.model && host && !host.isDestroyed()) host.remove(entry.model);
    entry.model = null;
    entry.modelUrl = null;
  }

  /** Start loading `entry`'s url; the model it draws now stays until ready. */
  function load(record, entry) {
    const host = hostOf(record);
    cancel(record, entry);
    const token = {};
    entry.token = token;
    entry.url = entry.item.url;
    const url = entry.url;
    // A load counts until it is ready, fails or is superseded; once.
    host.loading += 1;
    let settled = false;
    const item = entry.item;
    const current = () =>
      entry.token === token && record.host === host && !host.isDestroyed();
    const settleLoad = () => settle(false);
    const settle = (failed, error) => {
      if (settled) return;
      settled = true;
      if (entry.settleLoad === settleLoad) entry.settleLoad = null;
      host.loading -= 1;
      if (failed && entry.token === token) {
        entry.failed = true;
        entry.failedAt = Date.now();
        host.failed += 1;
        // Told once Cesium is done with the frame it raised this in; not
        // when the item has moved on to another load meanwhile.
        const message = failureMessage(error);
        queueMicrotask(() => {
          if (current() && entry.failed)
            record.listeners.loadFailed.fire(item.id, message);
        });
      }
      requestRender();
    };
    entry.settleLoad = settleLoad;
    // Bytes loaded already are drawn from: the url is then only the base
    // path (Cesium's glTF cache keys by it, so each model keeps its own).
    const source = item.gltf
      ? { gltf: item.gltf, basePath: item.url }
      : { url: item.url };
    Cesium.Model.fromGltfAsync({
      ...source,
      modelMatrix: matrixOf(entry, new Cesium.Matrix4()),
      scale: item.scale ?? 1,
      minimumPixelSize: item.minPixelSize ?? 0,
      maximumScale: item.maxScale,
      customShader: entryShader(entry),
      clippingPlanes:
        item.clip === 'belowOrigin' ? belowOriginClip() : undefined,
      environmentMapOptions: { enabled: item.environmentMap !== false },
      // Shown once ready and placed: the pass below shows it.
      show: false,
      // All textures before ready, so a settled capture is the whole model.
      incrementallyLoadTextures: false,
      // Off the frame-spread job queue that photoreal tiles contend for, so
      // a model's readiness stays bounded while tiles stream.
      asynchronous: false,
      id: entry.pickId,
    }).then(
      (model) => {
        if (!current()) {
          settle(false);
          return model.destroy();
        }
        entry.next = model;
        entry.styled = null;
        style(record, entry, model, true);
        host.add(model);
        model.readyEvent.addEventListener(() => {
          if (!current() || entry.next !== model) return settle(false);
          // The old model goes as the new one draws.
          if (entry.model) host.remove(entry.model);
          entry.model = model;
          entry.modelUrl = url;
          entry.next = null;
          entry.radius = 0;
          entry.styled = null;
          style(record, entry, model, true);
          settle(false);
          record.listeners.ready.fire(item.id);
        });
        // A failed load is let go (Cesium would keep drawing frames for
        // it); the failure stays for `whenSettled` until the item changes.
        model.errorEvent.addEventListener((error) => {
          if (current() && entry.next === model) {
            entry.next = null;
            // Cesium raises this inside the model's update: removing it
            // (which destroys it) waits until that is done.
            queueMicrotask(() => {
              if (!host.isDestroyed() && host.contains(model))
                host.remove(model);
            });
          }
          settle(true, error);
        });
        requestRender();
      },
      (error) => settle(true, error),
    );
  }

  function matrixOf(entry, result) {
    const o = entry.item.orientation ?? {};
    scratchHpr.heading = o.heading ?? 0;
    scratchHpr.pitch = o.pitch ?? 0;
    scratchHpr.roll = o.roll ?? 0;
    Cesium.Transforms.headingPitchRollToFixedFrame(
      entry.at,
      scratchHpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      result,
    );
    const axes = entry.item.axisScale;
    if (axes && (axes[0] !== 1 || axes[1] !== 1 || axes[2] !== 1)) {
      // Cesium's glTF axis correction (Y up to Z up, then Z forward to X
      // forward) puts the model's own Z on local X, its X on local Y and
      // its Y on local Z.
      scratchAxes.x = axes[2];
      scratchAxes.y = axes[0];
      scratchAxes.z = axes[1];
      Cesium.Matrix4.multiplyByScale(result, scratchAxes, result);
    }
    return result;
  }

  /**
   * Pose and style `model` as its entry's item says. What the per-frame
   * pass sets (scale, colour alpha, show) is set here from what it found
   * last, so an update between frames draws the same.
   */
  function style(record, entry, model, force = false) {
    const item = entry.item;
    matrixOf(entry, scratchMatrix);
    Cesium.Matrix4.clone(scratchMatrix, model.modelMatrix);
    const was = force ? null : entry.styled;
    const minimum = item.minPixelSize ?? 0;
    if (model.minimumPixelSize !== minimum) model.minimumPixelSize = minimum;
    if (model.maximumScale !== item.maxScale)
      model.maximumScale = item.maxScale;
    const shader = entryShader(entry);
    if (model.customShader !== shader) model.customShader = shader;
    const clip = item.clip === 'belowOrigin';
    if (Boolean(model.clippingPlanes) !== clip)
      model.clippingPlanes = clip ? belowOriginClip() : undefined;
    const environment = item.environmentMap !== false;
    const manager = model.environmentMapManager;
    if (manager && manager.enabled !== environment)
      manager.enabled = environment;
    const range = item.displayRange;
    const rangeKey = range ? `${range[0]},${range[1]}` : '';
    if (!was || was.range !== rangeKey)
      model.distanceDisplayCondition =
        range && range[1] > range[0]
          ? new Cesium.DistanceDisplayCondition(range[0], range[1])
          : undefined;
    // Without a tint there is nothing to blend in: the model's own colour.
    const blend = entry.tint ? item.colorBlend : undefined;
    const mode = BLEND_MODES[blend?.mode] ?? Cesium.ColorBlendMode.HIGHLIGHT;
    if (model.colorBlendMode !== mode) model.colorBlendMode = mode;
    const amount = blend?.mode === 'mix' ? (blend.amount ?? DEFAULT_MIX) : 0.5;
    if (model.colorBlendAmount !== amount) model.colorBlendAmount = amount;
    // An empty `displayRange` shows nothing.
    const hidden = range && !(range[1] > range[0]);
    if (entry.styled?.range !== rangeKey) entry.styled = { range: rangeKey };
    entry.dynamic = needsFrame(item, record.spec);
    apply(entry, model, entry.frame ?? STILL, hidden);
  }

  /**
   * The parts the per-frame pass computes: the scale (by distance and the
   * pixel cap), the tint's alpha (fade) and whether it shows (cull).
   */
  function apply(entry, model, frame, hidden = false) {
    const item = entry.item;
    const scale = (item.scale ?? 1) * frame.scale;
    if (model.scale !== scale) model.scale = scale;
    const color = Cesium.Color.clone(
      entry.tint ?? Cesium.Color.WHITE,
      scratchColor,
    );
    color.alpha *= frame.alpha * (entry.emphasis ?? focusOf(item));
    // An untinted model at full opacity is drawn without a colour: a colour
    // adds a colour stage to every draw of the model.
    const plain = !entry.tint && color.alpha === 1;
    // Written only when what is asked changes, so a theme's own write to a
    // model's colour stands until then.
    const written = writtenColors.get(model);
    if (plain) {
      if (written !== NO_COLOR) {
        writtenColors.set(model, NO_COLOR);
        model.color = undefined;
      }
    } else if (
      !written ||
      written === NO_COLOR ||
      !Cesium.Color.equals(written, color)
    ) {
      writtenColors.set(
        model,
        Cesium.Color.clone(color, written === NO_COLOR ? undefined : written),
      );
      model.color = color;
    }
    const show =
      item.show !== false && frame.shown && !hidden && model.ready === true;
    if (model.show !== show) model.show = show;
  }

  /**
   * Add or change items, by id. Whether any was added: models moved or
   * restyled keep their pick ids, so only one added changes what height
   * queries see through.
   */
  function upsert(record, list) {
    hostOf(record);
    let added = false;
    for (const item of list) if (put(record, item)) added = true;
    if (added) notePickIds(record);
    requestRender();
    return added;
  }

  /** Draw `item` on its entry, made when it has none; true when made. */
  function put(record, item) {
    let entry = record.models.get(item.id);
    const made = !entry;
    if (!entry) {
      entry = {
        item,
        url: null,
        modelUrl: null,
        model: null,
        at: new Cesium.Cartesian3(),
        tint: null,
        tintKey: undefined,
        mask: null,
        maskKey: undefined,
        radius: 0,
        next: null,
        token: null,
        failed: false,
        failedAt: 0,
        settleLoad: null,
        styled: null,
        // The custom shader drawn with, for the shading and mask it is of
        // (`entryShader`).
        shader: undefined,
        shaderShading: null,
        shaderMask: null,
        dynamic: false,
        frame: null,
        // Focus and haze in a set that recedes, else null (focus alone).
        emphasis: null,
        pickId: pickId(record, item),
      };
      record.models.set(item.id, entry);
    } else {
      entry.item = item;
      // The pick id is the model's own object: changed where it is.
      entry.pickId.meta = item.meta;
    }
    positionOf(item.pos, entry.at);
    // A fleet re-poses every frame with the same tint: parsed when it changes.
    const tint = tintKey(item.tint);
    if (entry.tintKey !== tint) {
      entry.tintKey = tint;
      entry.tint = tint === null ? null : toColor(item.tint);
    }
    const mask = tintKey(item.maskColor);
    if (entry.maskKey !== mask) {
      entry.maskKey = mask;
      entry.mask = mask === null ? null : toColor(item.maskColor);
    }
    if (entry.url !== item.url && item.url === entry.modelUrl) {
      // Back to the url it draws: the load in between is not wanted.
      cancel(record, entry);
      entry.url = entry.modelUrl;
    }
    // The model it draws keeps up while another loads.
    for (const model of [entry.model, entry.next])
      if (model) style(record, entry, model);
    const retry = entry.failed && Date.now() - entry.failedAt >= MODEL_RETRY_MS;
    if (entry.url !== item.url || retry) load(record, entry);
    return made;
  }

  /** Stop the entry's load in flight, keeping the model it draws. */
  function cancel(record, entry) {
    const host = record.host;
    entry.settleLoad?.();
    entry.token = null;
    if (entry.next && host && !host.isDestroyed()) host.remove(entry.next);
    entry.next = null;
    if (entry.failed && host) host.failed -= 1;
    entry.failed = false;
  }

  /**
   * The set's items as they are now (after a `set`, `remove` or `clear`):
   * models of items gone are dropped, the rest kept or changed in place.
   */
  function build(record) {
    hostOf(record);
    for (const id of [...record.models.keys()])
      if (!record.items.has(id)) drop(record, id);
    for (const item of record.items.values()) put(record, item);
    notePickIds(record);
  }

  /** Each frame, before it draws: distance curves, pixel caps and the cull. */
  function beforeRender(sets) {
    const eye = scene.camera?.positionWC;
    if (!eye) return;
    const width = scene.drawingBufferWidth ?? scene.canvas?.width ?? 0;
    const height = scene.drawingBufferHeight ?? scene.canvas?.height ?? 0;
    let horizon;
    const eyeHeight = scene.camera.positionCartographic?.height;
    for (const record of sets) {
      if (record.kind !== 'models' || !record.models) continue;
      if (record.recedeFrom !== record.spec.recede) {
        record.recedeFrom = record.spec.recede;
        record.recede = recedeParams(record.spec.recede);
      }
      const recede = record.recede;
      const recedeNow = recede
        ? recedeFrame(eyeHeight, recede, scratchFrame)
        : null;
      for (const entry of record.models.values()) {
        if (!entry.dynamic) {
          if (entry.frame) {
            entry.frame = null;
            for (const model of [entry.model, entry.next])
              if (model) style(record, entry, model);
          }
          continue;
        }
        const item = entry.item;
        const at = entry.at;
        const distance = Cesium.Cartesian3.distance(eye, at);
        const frame = (entry.frame ??= { scale: 1, alpha: 1, shown: true });
        frame.alpha = item.fadeByDistance
          ? Math.min(
              1,
              Math.max(0, nearFarValue(item.fadeByDistance, distance)),
            )
          : 1;
        if (recede) {
          const haze = recedeFactors(
            distance,
            recedeNow,
            recede,
            scratchFactors,
          ).alpha;
          const emphasis = recededAlpha(focusOf(item), haze, recede);
          if (
            entry.emphasis === null ||
            Math.abs(entry.emphasis - emphasis) > RECEDE_WRITE_EPSILON
          )
            entry.emphasis = emphasis;
        } else entry.emphasis = null;
        let shown = frame.alpha > 0;
        if (record.spec.horizonCull) {
          horizon ??= horizonNow();
          if (horizon && !horizon.isPointVisible(at)) shown = false;
        }
        frame.shown = shown;
        let scale = item.scaleByDistance
          ? nearFarValue(item.scaleByDistance, distance)
          : 1;
        const model = entry.model;
        const itemScale = item.scale ?? 1;
        if (
          item.maxPixelSize > 0 &&
          itemScale > 0 &&
          model?.ready &&
          width > 0 &&
          height > 0
        ) {
          const radius = radiusOf(entry, model);
          // Pixels at the model's centre: a sphere around the eye has none.
          scratchSphere.center = at;
          scratchSphere.radius = 0;
          const metresPerPixel = scene.camera.getPixelSize(
            scratchSphere,
            width,
            height,
          );
          if (radius > 0)
            scale =
              cappedScale(
                itemScale * scale,
                radius,
                metresPerPixel,
                item.maxPixelSize,
              ) / itemScale;
        }
        frame.scale = scale;
        const hidden =
          item.displayRange && !(item.displayRange[1] > item.displayRange[0]);
        for (const m of [entry.model, entry.next])
          if (m) apply(entry, m, frame, hidden);
      }
    }
  }

  /**
   * The model's bounding radius at scale 1, read once it is drawn at a
   * scale (Cesium's sphere is at its scale, capped by `maximumScale`); 0
   * until then.
   */
  function radiusOf(entry, model) {
    if (entry.radius > 0) return entry.radius;
    const own = Math.min(model.scale, model.maximumScale ?? Infinity);
    if (!(own > 0)) return 0;
    entry.radius = model.boundingSphere.radius / own;
    return entry.radius;
  }

  /** The set's options changed: whether models need the frame pass. */
  function restyle(record) {
    if (!record.models) return;
    for (const entry of record.models.values()) {
      entry.dynamic = needsFrame(entry.item, record.spec);
      if (!record.spec.recede) entry.emphasis = null;
    }
  }

  return { build, upsert, beforeRender, restyle };
}
