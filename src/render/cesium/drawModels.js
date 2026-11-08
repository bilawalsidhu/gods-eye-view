/**
 * @module render/cesium/drawModels
 * @description The Cesium draw port's `models` sets: one `Cesium.Model` per
 * item in the set's collection, changed where it is. An update that keeps an
 * item's `url` re-poses and restyles its model in place (position,
 * orientation, scale and pixel bounds, `shading`, `tint`, `colorBlend`,
 * `environmentMap`, `displayRange`, `show`); only a new `url` loads again,
 * and the old model keeps drawing until the new one is ready, so a swap
 * never blinks. `ready` fires once per load, when the model has loaded and
 * is posed.
 *
 * What Cesium has no option for runs each frame before the scene draws:
 * `maxPixelSize` (the scale capped so the bounding sphere spans at most that
 * many drawing-buffer pixels at its distance from the eye, as Cesium
 * measures `minPixelSize`), `scaleByDistance`, `fadeByDistance` (the tint's
 * alpha) and the set's `horizonCull`.
 *
 * A failed load is tried again when its item is next updated, once
 * `MODEL_RETRY_MS` has passed.
 *
 * `shading: 'thermal'` draws the model unlit and white-hot (its texture
 * left out), then tinted as asked: a hot target, as the thermal views draw
 * them. Heights are absolute: models clamp nothing.
 */
import * as Cesium from 'cesium';

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

/** Cesium's own blend amount, for a `mix` that names none. */
const DEFAULT_MIX = 0.5;

let unlitShader = null;
let thermalShader = null;

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
const scratchMatrix = new Cesium.Matrix4();
const scratchSphere = new Cesium.BoundingSphere();
const scratchColor = new Cesium.Color();
/** The colour last written to each model. */
const writtenColors = new WeakMap();
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

/** Whether an item needs the per-frame pass. */
const needsFrame = (item, spec) =>
  item.maxPixelSize > 0 ||
  Boolean(item.scaleByDistance) ||
  Boolean(item.fadeByDistance) ||
  Boolean(spec.horizonCull);

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
    const settleLoad = () => settle(false);
    const settle = (failed) => {
      if (settled) return;
      settled = true;
      if (entry.settleLoad === settleLoad) entry.settleLoad = null;
      host.loading -= 1;
      if (failed && entry.token === token) {
        entry.failed = true;
        entry.failedAt = Date.now();
        host.failed += 1;
      }
      requestRender();
    };
    entry.settleLoad = settleLoad;
    const item = entry.item;
    const current = () =>
      entry.token === token && record.host === host && !host.isDestroyed();
    Cesium.Model.fromGltfAsync({
      url: item.url,
      modelMatrix: matrixOf(entry, new Cesium.Matrix4()),
      scale: item.scale ?? 1,
      minimumPixelSize: item.minPixelSize ?? 0,
      maximumScale: item.maxScale,
      customShader: shaderOf(item.shading),
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
        model.errorEvent.addEventListener(() => {
          if (current() && entry.next === model) {
            entry.next = null;
            // Cesium raises this inside the model's update: removing it
            // (which destroys it) waits until that is done.
            queueMicrotask(() => {
              if (!host.isDestroyed() && host.contains(model))
                host.remove(model);
            });
          }
          settle(true);
        });
        requestRender();
      },
      () => settle(true),
    );
  }

  function matrixOf(entry, result) {
    const o = entry.item.orientation ?? {};
    scratchHpr.heading = o.heading ?? 0;
    scratchHpr.pitch = o.pitch ?? 0;
    scratchHpr.roll = o.roll ?? 0;
    return Cesium.Transforms.headingPitchRollToFixedFrame(
      entry.at,
      scratchHpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      result,
    );
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
    const shader = shaderOf(item.shading);
    if (model.customShader !== shader) model.customShader = shader;
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
    color.alpha *= frame.alpha;
    // Written only when what is asked changes, so a theme's own write to a
    // model's colour stands until then.
    const written = writtenColors.get(model);
    if (!written || !Cesium.Color.equals(written, color)) {
      writtenColors.set(model, Cesium.Color.clone(color, written));
      model.color = color;
    }
    const show =
      item.show !== false && frame.shown && !hidden && model.ready === true;
    if (model.show !== show) model.show = show;
  }

  /** Add or change items, by id; true once handled (always, for models). */
  function upsert(record, list) {
    hostOf(record);
    for (const item of list) put(record, item);
    notePickIds(record);
    requestRender();
    return true;
  }

  function put(record, item) {
    let entry = record.models.get(item.id);
    if (!entry) {
      entry = {
        item,
        url: null,
        modelUrl: null,
        model: null,
        at: new Cesium.Cartesian3(),
        tint: null,
        tintKey: undefined,
        radius: 0,
        next: null,
        token: null,
        failed: false,
        failedAt: 0,
        settleLoad: null,
        styled: null,
        dynamic: false,
        frame: null,
        pickId: pickId(record, item),
      };
      record.models.set(item.id, entry);
    } else {
      entry.item = item;
      // The pick id is the model's own object: changed where it is.
      entry.pickId.meta = item.meta;
      entry.pickId.lodGroup = item.lodGroup;
    }
    positionOf(item.pos, entry.at);
    // A fleet re-poses every frame with the same tint: parsed when it changes.
    const tint = tintKey(item.tint);
    if (entry.tintKey !== tint) {
      entry.tintKey = tint;
      entry.tint = tint === null ? null : toColor(item.tint);
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
    for (const record of sets) {
      if (record.kind !== 'models' || !record.models) continue;
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
    for (const entry of record.models.values())
      entry.dynamic = needsFrame(entry.item, record.spec);
  }

  return { build, upsert, beforeRender, restyle };
}
