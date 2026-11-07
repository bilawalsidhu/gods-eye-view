/**
 * @module render/cesium/draw
 * @description The Cesium renderer's draw port
 * (`src/render/contract/draw.d.ts`): batched sets of items, each set one
 * primitive collection in the scene, rebuilt when its items change (icon
 * sets, and unclamped points restyled or moved, change in place). Every
 * item carries a pick id `{set, id, meta, lodGroup}`, which the query port
 * (`ports.js`) reads picks back through.
 *
 * Clamped items follow the ground as Cesium's own entities do: a clamped
 * point is a billboard of a drawn dot, a draped line a ground polyline, a
 * clamped fill a ground primitive (packed so no two fills in one overlap,
 * so overlapping translucent fills blend as they did). A rebuilt set keeps
 * drawing its last ground primitives until the new ones are ready, so a
 * refresh never blinks. `horizonCull` hides a set's points and icons past
 * the ellipsoid's horizon, each frame before it draws, tested at the
 * position each was given (not where clamping put it). The ground fills and
 * draped lines of a set made with `pickable: false` stay out of the pick
 * pass, so they never hide the ground geometry drawn under them from picks.
 *
 * Icon sets whose items move, glide, recede, pick by proxy or switch images
 * by size, or that take columns, draw on the GPU instead (`gpuIcons.js`).
 *
 * Built over a scene by `createCesiumPorts`, and on its own over a Cesium
 * viewer with no renderer bound, when code first asks
 * `findDraw` for one (`rendererOf.js`).
 */
import * as Cesium from 'cesium';
import { provideUnboundDraw } from '../rendererOf.js';
import { listenerList, toCartesian, uncaught } from './common.js';
import { createGpuIcons, GPU_ICON_CAPABILITIES } from './gpuIcons.js';

/** The contract's colour as Cesium's. */
export function toColor(color, alpha = 1) {
  if (color === undefined || color === null)
    return Cesium.Color.WHITE.withAlpha(alpha);
  const c =
    typeof color === 'string'
      ? Cesium.Color.fromCssColorString(color)
      : new Cesium.Color(color[0], color[1], color[2], color[3] ?? 1);
  return c.withAlpha(c.alpha * alpha);
}

/** An image reference as something a billboard takes. */
export function toImage(image) {
  if (typeof image === 'string') return image;
  if (image?.svg)
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  if (image?.canvas) return image.canvas;
  throw new Error('the Cesium renderer takes URL, SVG and canvas images only');
}

/** Cesium's height reference for an item's `height` and `clampTo`. */
export function heightReferenceOf(height, clampTo = 'both') {
  const H = Cesium.HeightReference;
  if (height === 'clampGround')
    return (
      { terrain: H.CLAMP_TO_TERRAIN, tiles: H.CLAMP_TO_3D_TILE }[clampTo] ??
      H.CLAMP_TO_GROUND
    );
  if (height === 'relativeGround')
    return (
      { terrain: H.RELATIVE_TO_TERRAIN, tiles: H.RELATIVE_TO_3D_TILE }[
        clampTo
      ] ?? H.RELATIVE_TO_GROUND
    );
  return H.NONE;
}

/** Cesium's classification for what clamped lines and fills drape onto. */
const classificationOf = (clampTo = 'both') =>
  ({
    terrain: Cesium.ClassificationType.TERRAIN,
    tiles: Cesium.ClassificationType.CESIUM_3D_TILE,
  })[clampTo] ?? Cesium.ClassificationType.BOTH;

/**
 * A distance curve as Cesium's, or undefined. Cesium's curves hold the same
 * end values but ease between them (not linearly, as the contract's do):
 * points and icons draw them as Cesium's own entities always have. A curve
 * whose far end is not past its near one is left out.
 */
const nearFarOf = (curve) =>
  // One that ends where it starts is no curve, which Cesium refuses.
  curve && curve.far > curve.near
    ? new Cesium.NearFarScalar(
        curve.near,
        curve.nearValue,
        curve.far,
        curve.farValue,
      )
    : undefined;

/** Whether a `displayRange` shows anything: `[near, far)` is not empty. */
const displayable = (range) => !range || range[1] > range[0];

/**
 * A `displayRange` as Cesium's, or undefined for none (or an empty one).
 * Cesium still shows an item at exactly its far distance.
 */
const displayConditionOf = (range) =>
  range && displayable(range)
    ? new Cesium.DistanceDisplayCondition(range[0], range[1])
    : undefined;

/** Cesium's point blending for a set's `blend`. */
const pointBlendOf = (blend) =>
  ({
    opaque: Cesium.BlendOption.OPAQUE,
    translucent: Cesium.BlendOption.TRANSLUCENT,
  })[blend] ?? Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT;

/**
 * Ground fills of a set that never takes part in picks (`pickable: false`).
 * `allowPicking: false` drops their ids, but a ground primitive still draws
 * its stencil in the pick pass, which would erase picks of ground geometry
 * under it; these skip the pick pass altogether.
 */
class UnpickableGroundPrimitive extends Cesium.GroundPrimitive {
  update(frameState) {
    if (!frameState.passes.pick) super.update(frameState);
  }
}

/**
 * Images an icon set's collection may hold, or twice those it draws when
 * that is more, before it is built anew holding only those it draws.
 */
const MAX_SPARE_IMAGES = 64;

const ANCHORS = {
  center: Cesium.VerticalOrigin.CENTER,
  bottom: Cesium.VerticalOrigin.BOTTOM,
  top: Cesium.VerticalOrigin.TOP,
};

/** The `flow` line material's type. */
const FLOW_MATERIAL = 'DrawFlowLine';

/**
 * Along the line (`st.s`, 0 at its start, 1 at its end) the pattern repeats
 * `repeat` times, each cell lit for its first `duty`, scrolled toward the
 * end by `time * speed` cells; between the dashes the line stays faintly
 * drawn, and the lit cells glow.
 */
const FLOW_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float s = materialInput.st.s;
  float flow = fract(s * repeat - time * speed);
  float on = smoothstep(duty + 0.08, duty - 0.08, flow);
  float a = max(on, 0.18);
  m.diffuse = color.rgb;
  m.emission = color.rgb * on * 0.9;
  m.alpha = color.a * a;
  return m;
}`;

/**
 * The `flow` lines' clock, seconds, for a line flowing at `speed` cells a
 * second: wrapped to one cell's time, which draws the same dashes, so the
 * single-precision uniform never runs out of digits over a long session.
 */
function flowTime(speed) {
  if (!speed) return 0;
  const cells = (performance.now() / 1000) * speed;
  return (cells - Math.floor(cells)) / speed;
}

/**
 * The draw port over `scene`, and what the other ports read of it: the live
 * sets by id, a version that changes with them, the scene's 3D tilesets and
 * the clamp-state watch the frame loop runs after each draw.
 * @param {{scene: object, report: (error: unknown) => void,
 *   capabilities?: ReadonlySet<string>,
 *   requestRender?: (reason: string) => void}} options `capabilities` gate
 *   the GPU icon sets' members (by default they all are); `requestRender`,
 *   the frame port's, asks for the frames a GPU icon set needs on its own
 *   (its images packed), under the reason `icons:<set id>` (by default the
 *   scene's, with no reason).
 */
export function createCesiumDraw({
  scene,
  report,
  capabilities = new Set(GPU_ICON_CAPABILITIES),
  requestRender: requestFrame = null,
}) {
  const sets = new Map();
  // Bumped on every change to the sets or what they hold.
  let setsVersion = 0;
  // A viewer can be destroyed before the layers drawing on it
  // let their sets go; those calls then have nothing left to do.
  const live = () => !scene.isDestroyed?.();
  const requestRender = () => {
    if (live()) scene.requestRender();
  };

  function makeSet(kind, spec, build) {
    if (sets.has(spec.id)) throw new Error(`a set with id ${spec.id} is live`);
    const items = new Map();
    const listeners = { ready: listenerList(report) };
    const record = {
      kind,
      spec,
      items,
      listeners,
      host: null,
      pickIds: [],
      // What it drew before its ground primitives were ready, still shown.
      retiring: null,
      pending: null,
      // The host's ground primitives, and the collection beside them.
      ground: null,
      own: null,
      // Each point or icon at its position, for the horizon cull.
      placed: [],
    };
    // Each build records its items' pick ids, for height queries to see
    // through.
    const rebuild = () => {
      record.pickIds = [];
      record.placed = [];
      record.patchable = null;
      record.lineParts = null;
      build(record);
      setsVersion += 1;
    };
    record.rebuild = rebuild;
    // Changed in place: what height queries see through may have changed.
    const patched = () => {
      setsVersion += 1;
      requestRender();
    };
    const handle = {
      id: spec.id,
      set(list) {
        if (onGpu(record, list, true)) {
          items.clear();
          for (const item of list) items.set(item.id, item);
          record.gpu.sync();
          return patched();
        }
        items.clear();
        for (const item of list) items.set(item.id, item);
        // Icons are changed where they are, when they can be.
        if (syncIcons(record, items.keys(), true)) return patched();
        rebuild();
        requestRender();
      },
      upsert(list) {
        if (onGpu(record, list)) {
          for (const item of list) items.set(item.id, item);
          record.gpu.write(list);
          return patched();
        }
        // Points restyled or moved, and lines that only change how they show
        // or where an undraped one runs, are changed where they are.
        if (patchPoints(record, list) || patchLines(record, list)) {
          for (const item of list) items.set(item.id, item);
          if (kind === 'lines') noteFlows(record);
          setsVersion += 1;
          requestRender();
          return;
        }
        for (const item of list) items.set(item.id, item);
        if (
          syncIcons(
            record,
            list.map((item) => item.id),
          )
        )
          return patched();
        rebuild();
        requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        if (record.gpu) {
          record.gpu.drop(ids);
          return patched();
        }
        if (syncIcons(record, [])) return patched();
        rebuild();
        requestRender();
      },
      clear() {
        items.clear();
        if (record.gpu) {
          record.gpu.sync();
          return patched();
        }
        if (syncIcons(record, [])) return patched();
        rebuild();
        requestRender();
      },
      setOptions(options) {
        const culled = spec.horizonCull;
        const clampTo = spec.clampTo;
        const blend = spec.blend;
        const pickable = spec.pickable !== false;
        Object.assign(spec, options);
        // What clamped items clamp to, how points blend, and whether ground
        // primitives pick, are built into them. Models clamp nothing, only
        // points and icons build in the blend, and only shapes and lines have ground
        // primitives: other kinds are not rebuilt for those (models would
        // load again).
        if (
          (kind !== 'models' && spec.clampTo !== clampTo) ||
          ((kind === 'points' || kind === 'icons') && spec.blend !== blend) ||
          ((kind === 'shapes' || kind === 'lines') &&
            (spec.pickable !== false) !== pickable)
        )
          rebuild();
        // A set that stops picking lets its old ground go now: still drawn
        // while the new builds, it would keep hiding the ground from picks.
        if (pickable && spec.pickable === false) retire(record);
        record.gpu?.restyle();
        setsVersion += 1;
        showHosts(record);
        // No longer culled: what the cull hid comes back.
        if (culled && !spec.horizonCull) uncull(record);
        requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        showHosts(record);
        requestRender();
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.() && live())
          scene.primitives.remove(record.host);
        record.host = null;
        retire(record);
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        setsVersion += 1;
        requestRender();
      },
    };
    // `columns`: column updates of an icon set, on the GPU.
    if (kind === 'icons' && capabilities.has('columns'))
      handle.setColumns = (columns) => {
        onGpu(record, [], false, true);
        record.gpu.columns(columns);
        patched();
      };
    sets.set(spec.id, record);
    setsVersion += 1;
    return handle;
  }

  const gpu = createGpuIcons({
    scene,
    capabilities,
    toColor,
    imageOf: (record, image) => iconImage(record, image),
    peekImage: (image) => atlases.get(image.atlas)?.[image.slot],
    requestRender: (reason) => {
      if (!live()) return;
      if (requestFrame) requestFrame(reason);
      else scene.requestRender();
    },
  });

  /**
   * Whether an icon set draws `list` on the GPU: it already does, or the
   * items (or `force`, for columns) need it to, when its billboards give way
   * to a GPU host in their place. Refuses, changing nothing, what the GPU
   * cannot draw: of `list`, and, unless `replacing` them, of the items the
   * set already holds.
   */
  function onGpu(record, list, replacing = false, force = false) {
    if (record.kind !== 'icons') return false;
    const wanted = record.gpu || force ? 'needs' : gpu.wants(list);
    if (!wanted) return false;
    if (wanted === 'prefers') {
      // Only a course blend: on the GPU if all of it can be, else billboards.
      try {
        gpu.check(list, record.spec);
        if (!replacing) gpu.check(record.items.values(), record.spec);
      } catch {
        return false;
      }
    }
    gpu.check(list, record.spec);
    if (record.gpu) return true;
    if (!replacing) gpu.check(record.items.values(), record.spec);
    record.gpu = gpu.attach(record);
    record.billboards = null;
    record.billboardHost = null;
    record.placed = [];
    // Icons on the GPU stay out of offscreen passes: height queries never
    // see them, so there is nothing to see through.
    record.pickIds = [];
    replaceHost(record, record.gpu.host);
    return true;
  }

  function pickId(record, item) {
    const id = {
      set: record.spec.id,
      id: item.id,
      meta: item.meta,
      lodGroup: item.lodGroup,
    };
    record.pickIds.push(id);
    return id;
  }

  /**
   * Draw `host` for the set in place of what it drew. With `ground` (its
   * ground primitives), the new host's ground primitives stay hidden and
   * the old host keeps drawing until every one is ready, then they swap in
   * one frame, as the entities' ground batches do; a host still waiting
   * when the next one comes is dropped.
   */
  function replaceHost(record, host, ground = null, own = null) {
    const old = record.host;
    const waiting = ground?.length ? ground : null;
    // The set keeps its place among the scene's primitives: a rebuild draws
    // where it drew, so stacking (and picks among overlapping items) does
    // not change with each update. Its place is under whatever was above
    // the host it replaces (indices shift as older hosts go).
    const slot = old ? slotOf(old) : -1;
    const above =
      slot >= 0 && slot + 1 < scene.primitives.length
        ? scene.primitives.get(slot + 1)
        : null;
    // Named for code that orders the scene's primitives (`spriteOrder.js`).
    host.drawSetId = record.spec.id;
    // Only old ground primitives wait for the new ones: the rest of the old
    // host goes now, as the new host's own parts draw at once.
    if (
      old &&
      waiting &&
      !record.retiring &&
      !record.pending &&
      record.ground
    ) {
      record.retiring = old;
      if (record.own) old.remove(record.own);
    } else if (old) scene.primitives.remove(old);
    if (!waiting) retire(record);
    // Hidden one by one: a hidden collection would not build them.
    if (waiting) for (const primitive of waiting) primitive.show = false;
    record.pending = waiting;
    record.ground = waiting;
    record.own = waiting ? own : null;
    record.host = host;
    const at = above ? slotOf(above) : -1;
    if (at >= 0) scene.primitives.add(host, at);
    else scene.primitives.add(host);
    showHosts(record);
  }

  /** Where `primitive` is among the scene's primitives, or -1. */
  function slotOf(primitive) {
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) if (primitives.get(i) === primitive) return i;
    return -1;
  }

  function showHosts(record) {
    const show = record.spec.show !== false;
    if (record.host) record.host.show = show;
    if (record.retiring) record.retiring.show = show;
  }

  function retire(record) {
    if (record.retiring && !record.retiring.isDestroyed?.() && live())
      scene.primitives.remove(record.retiring);
    record.retiring = null;
    record.retiringFlows = null;
  }

  /**
   * After a draw: a set whose ground primitives are all ready shows them,
   * and lets go of what drew in their place.
   */
  function swapReady() {
    for (const record of sets.values()) {
      const ground = record.pending;
      if (!ground || ground.some((p) => !p.isDestroyed() && !p.ready)) continue;
      showPending(record);
      for (const primitive of ground) primitive.show = true;
      record.pending = null;
      retire(record);
      requestRender();
    }
  }

  // The horizon cull: a point or icon past the ellipsoid's horizon from the
  // eye is hidden, as layers drawn without depth test used to do themselves.
  let occluder = null;
  function cullHorizon() {
    for (const record of sets.values()) {
      if (!record.spec.horizonCull || !record.placed.length) continue;
      const eye = scene.camera?.positionWC;
      // The eye is ECEF in 3D only.
      if (
        !eye ||
        (scene.mode ?? Cesium.SceneMode.SCENE3D) !== Cesium.SceneMode.SCENE3D
      )
        return;
      occluder ??= new Cesium.EllipsoidalOccluder(
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        eye,
      );
      occluder.cameraPosition = eye;
      for (const placed of record.placed) {
        const show = placed.shown && occluder.isPointVisible(placed.position);
        if (placed.primitive.show !== show) placed.primitive.show = show;
      }
    }
  }

  /** Each frame, before it draws: the flow lines' clock. */
  function runFlows() {
    for (const record of sets.values()) {
      for (const material of record.flowMaterials ?? [])
        material.uniforms.time = flowTime(material.uniforms.speed);
      for (const material of record.retiringFlows ?? [])
        material.uniforms.time = flowTime(material.uniforms.speed);
    }
  }

  /** Whether a shown set shows flow lines, which draw on in later frames. */
  const flowing = () =>
    [...sets.values()].some(
      (record) => record.spec.show !== false && record.flowShown,
    );

  /** Note whether a line set shows any flow line, once its lines change. */
  function noteFlows(record) {
    record.flowShown = false;
    if (!record.flowMaterials?.length) return;
    for (const item of record.items.values())
      if (item.style?.kind === 'flow' && item.show !== false) {
        record.flowShown = true;
        return;
      }
  }

  function uncull(record) {
    for (const placed of record.placed) placed.primitive.show = placed.shown;
  }

  /** Remember a drawn point or icon for the horizon cull. */
  function place(record, primitive, position, shown) {
    const placed = { primitive, position, shown };
    record.placed.push(placed);
    return placed;
  }

  // Atlases icons name images from, by id: `{atlas, slot}` reads the slot
  // when its icon is drawn, and registering an atlas again swaps the images
  // of the icons that drew from it.
  const atlases = new Map();

  /**
   * An icon's image: an atlas slot read through its atlas, or undefined
   * while its atlas or slot is not registered (it draws once it is).
   */
  function iconImage(record, image) {
    if (typeof image?.atlas !== 'string') return image;
    record.atlases.add(image.atlas);
    return atlases.get(image.atlas)?.[image.slot];
  }

  function buildIcons(record) {
    // A GPU host keeps drawing: what a rebuild changes, it reads live.
    if (record.gpu) return;
    const host = new Cesium.BillboardCollection({
      scene,
      blendOption: pointBlendOf(record.spec.blend),
    });
    record.atlases = new Set();
    // Each drawn icon's billboard, in the order the collection draws them.
    record.billboards = new Map();
    record.billboardHost = host;
    // Every image loaded into the collection's texture atlas, which keeps
    // each until the collection goes.
    record.imageKeys = new Set();
    for (const item of record.items.values()) {
      const image = iconImage(record, item.image);
      if (image !== undefined) addIcon(record, item, image);
    }
    replaceHost(record, host);
  }

  /** A generated image, drawn as one texture under its key. */
  const isKeyed = (image) => image?.canvas && typeof image.key === 'string';

  /** What tells one image from another, for an icon whose image changes. */
  function imageKeyOf(image) {
    if (typeof image === 'string') return image;
    if (typeof image?.svg === 'string') return `\u0000svg\u0000${image.svg}`;
    if (isKeyed(image)) return `\u0000key\u0000${image.key}`;
    return image?.canvas ?? image;
  }

  /** How a billboard draws an icon item at `position`, but its image and id. */
  function iconLook(record, item, position) {
    const look = {
      position,
      width: item.size[0] * (item.scale ?? 1),
      height: item.size[1] * (item.scale ?? 1),
      // Focus emphasis as the GPU icons draw it: a fade, at most to none.
      color: toColor(
        item.color,
        (item.alpha ?? 1) * Math.min(1, Math.max(0, item.focus ?? 1)),
      ),
      verticalOrigin: ANCHORS[item.anchor ?? 'center'],
      disableDepthTestDistance: item.disableDepthTest ?? 0,
      heightReference: heightReferenceOf(item.height, record.spec.clampTo),
      // An empty range shows it nowhere.
      show: item.show !== false && displayable(item.displayRange),
      scaleByDistance: nearFarOf(item.scaleByDistance),
      translucencyByDistance: nearFarOf(item.fadeByDistance),
      distanceDisplayCondition: displayConditionOf(item.displayRange),
      // The defaults, so a restyle in place puts back what an item dropped.
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
    };
    if (item.rotationMode === 'screen') look.rotation = item.rotation ?? 0;
    if (item.rotationMode === 'course') {
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
      look.alignedAxis = Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        Cesium.Cartesian3.UNIT_Y,
        new Cesium.Cartesian3(),
      );
      look.rotation = -Cesium.Math.toRadians(item.course ?? 0);
    }
    return look;
  }

  /** Give a billboard its image: a generated one under its key. */
  function setIconImage(record, billboard, image) {
    if (isKeyed(image)) billboard.setImage(image.key, image.canvas);
    else billboard.image = toImage(image);
    record.imageKeys.add(imageKeyOf(image));
  }

  /** Draw an icon item as a new billboard, after the set's others. */
  function addIcon(record, item, image) {
    const position = toCartesian(item.pos);
    const options = {
      ...iconLook(record, item, position),
      id: pickId(record, item),
    };
    const billboard = record.billboardHost.add(options);
    setIconImage(record, billboard, image);
    const placed = place(record, billboard, position, options.show);
    record.billboards.set(item.id, {
      billboard,
      placed,
      image: imageKeyOf(image),
      canvas: image?.canvas,
    });
  }

  /**
   * Draw a drawn icon as its item now is, on the billboard it has: its
   * image is loaded again only when it changes, so restyled icons never
   * blink. An SVG drawn at a new size keeps the raster it was loaded at, as
   * Cesium's entities do.
   */
  function patchIcon(record, entry, item, image) {
    const { billboard, placed } = entry;
    const position = toCartesian(item.pos);
    const look = iconLook(record, item, position);
    // Sized first: a new SVG image rasterises at the billboard's size.
    Object.assign(billboard, look);
    const key = imageKeyOf(image);
    if (key !== entry.image) {
      setIconImage(record, billboard, image);
      entry.image = key;
      entry.canvas = image?.canvas;
    }
    // Picks and height queries hold this id object: changed, not replaced.
    billboard.id.meta = item.meta;
    billboard.id.lodGroup = item.lodGroup;
    placed.position = position;
    // As a rebuild would; the horizon cull, where it runs, hides it again
    // past the horizon before the next frame draws.
    placed.shown = look.show;
  }

  /**
   * Bring an icon set's billboards in line with its items without a
   * rebuild: those of items gone (or whose image is gone) are removed, the
   * items `touched` are drawn as they now are, and new ones are added. A
   * collection draws in the order its billboards were added, so this is
   * done only when that stays the items' order: new icons come after every
   * one kept and, with `reordered` (a `set`), the kept ones keep their
   * order. A collection keeps every image it loaded, so it is also rebuilt
   * (anew, holding only what it draws) when it would hold many more images
   * than it draws, when it is emptied, and when a generated image under a
   * key it has comes as a new canvas (its key's texture would not change).
   * False, changing nothing, otherwise, and when the set has no live
   * collection of its own.
   * @param {object} record
   * @param {Iterable<string>} touched Ids of items that may have changed.
   * @param {boolean} [reordered] The items were replaced, in a new order.
   */
  function syncIcons(record, touched, reordered = false) {
    const drawn = record.billboards;
    const host = record.billboardHost;
    if (
      record.kind !== 'icons' ||
      !drawn ||
      !host ||
      record.host !== host ||
      host.isDestroyed()
    )
      return false;
    const images = new Map();
    for (const id of touched) {
      const item = record.items.get(id);
      if (item) images.set(id, iconImage(record, item.image));
    }
    if (record.items.size === 0) return false;
    const keeps = (id) =>
      record.items.has(id) && (!images.has(id) || images.get(id) !== undefined);
    const adds = (id) =>
      !drawn.has(id) && images.has(id) && images.get(id) !== undefined;
    let adding = false;
    const kept = [];
    for (const id of record.items.keys()) {
      if (adds(id)) adding = true;
      else if (drawn.has(id) && keeps(id)) {
        if (adding) return false;
        kept.push(id);
      }
    }
    if (reordered) {
      let at = 0;
      for (const id of drawn.keys())
        if (keeps(id) && kept[at++] !== id) return false;
    }
    // The images drawn once this is done, and those it would load.
    const drawing = new Set();
    let loading = 0;
    for (const id of kept) {
      const entry = drawn.get(id);
      if (!images.has(id)) {
        drawing.add(entry.image);
        continue;
      }
      const image = images.get(id);
      const key = imageKeyOf(image);
      if (
        isKeyed(image) &&
        key === entry.image &&
        image.canvas !== entry.canvas
      )
        return false;
      drawing.add(key);
    }
    for (const [id, image] of images)
      if (image !== undefined && !drawn.has(id)) drawing.add(imageKeyOf(image));
    for (const key of drawing) if (!record.imageKeys.has(key)) loading += 1;
    if (
      record.imageKeys.size + loading >
      Math.max(MAX_SPARE_IMAGES, 2 * drawing.size)
    )
      return false;
    const gone = new Set();
    for (const [id, entry] of drawn)
      if (!keeps(id)) {
        host.remove(entry.billboard);
        drawn.delete(id);
        gone.add(entry.billboard);
      }
    if (gone.size) {
      record.placed = record.placed.filter((p) => !gone.has(p.primitive));
      const ids = new Set([...gone].map((billboard) => billboard.id));
      record.pickIds = record.pickIds.filter((id) => !ids.has(id));
    }
    for (const [id, item] of record.items) {
      const image = images.get(id);
      if (image === undefined) continue;
      const entry = drawn.get(id);
      if (entry) patchIcon(record, entry, item, image);
      else addIcon(record, item, image);
    }
    return true;
  }

  function buildPoints(record) {
    let points = null;
    let dots = null;
    for (const item of record.items.values()) {
      const position = toCartesian(item.pos);
      // An empty range shows it nowhere.
      const show = item.show !== false && displayable(item.displayRange);
      const heightReference = heightReferenceOf(
        item.height,
        record.spec.clampTo,
      );
      let primitive;
      if (heightReference === Cesium.HeightReference.NONE) {
        points ??= new Cesium.PointPrimitiveCollection({
          blendOption: pointBlendOf(record.spec.blend),
        });
        primitive = points.add({
          position,
          ...pointLook(item),
          show,
          id: pickId(record, item),
        });
        const placed = place(record, primitive, position, show);
        record.patchable ??= new Map();
        record.patchable.set(item.id, {
          primitive,
          placed,
          at: placeOf(item),
          lodGroup: item.lodGroup,
        });
        continue;
      } else {
        // Point primitives cannot follow the ground.
        dots ??= new Cesium.BillboardCollection({ scene });
        primitive = addDot(dots, item, {
          position,
          heightReference,
          show,
          distanceDisplayCondition: displayConditionOf(item.displayRange),
          id: pickId(record, item),
        });
      }
      place(record, primitive, position, show);
    }
    let host = points ?? dots ?? new Cesium.PointPrimitiveCollection();
    if (points && dots) {
      host = new Cesium.PrimitiveCollection();
      host.add(points);
      host.add(dots);
    }
    replaceHost(record, host);
  }

  /** How a point primitive draws an unclamped point item. */
  function pointLook(item) {
    return {
      pixelSize: item.pixelSize,
      color: toColor(item.color),
      outlineColor: toColor(item.outlineColor ?? [0, 0, 0, 0]),
      outlineWidth: item.outlineWidth ?? 0,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
      scaleByDistance: nearFarOf(item.scaleByDistance),
      translucencyByDistance: nearFarOf(item.fadeByDistance),
      distanceDisplayCondition: displayConditionOf(item.displayRange),
    };
  }

  const PLACE_KEYS = ['x', 'y', 'z', 'lon', 'lat', 'height'];

  /**
   * Where an item is, as its values when drawn: a caller may change the
   * position object it passes and send the same one again.
   */
  const placeOf = (item) =>
    PLACE_KEYS.map((key) => item.pos?.[key]).concat(item.height);

  /**
   * Upsert unclamped points in place, without a rebuild, when every item
   * is one the set draws as a point primitive now and stays unclamped in
   * the same LOD group: then how it looks, where it is, its `meta` and
   * whether it shows change on the point it has. False, changing nothing,
   * otherwise.
   */
  function patchPoints(record, list) {
    const patchable = record.patchable;
    if (record.kind !== 'points' || !patchable) return false;
    for (const item of list) {
      const was = patchable.get(item.id);
      if (
        !was ||
        heightReferenceOf(item.height, record.spec.clampTo) !==
          Cesium.HeightReference.NONE ||
        item.lodGroup !== was.lodGroup
      )
        return false;
    }
    for (const item of list) {
      const was = patchable.get(item.id);
      const show = item.show !== false && displayable(item.displayRange);
      const at = placeOf(item);
      if (at.some((value, i) => !Object.is(value, was.at[i]))) {
        const position = toCartesian(item.pos);
        was.primitive.position = position;
        was.placed.position = position;
        was.at = at;
      }
      Object.assign(was.primitive, pointLook(item));
      was.primitive.id.meta = item.meta;
      was.placed.shown = show;
      // As a rebuild would; the horizon cull, where it runs, hides it again
      // past the horizon before the next frame draws.
      was.primitive.show = show;
    }
    return true;
  }

  /**
   * A clamped point as Cesium's entity points draw one: a billboard of a
   * dot drawn at its pixel size, one texture per look.
   */
  function addDot(collection, item, options) {
    const color = toColor(item.color);
    const outlineColor = toColor(item.outlineColor ?? [0, 0, 0, 0]);
    const outlineWidth = Math.round(item.outlineWidth ?? 0);
    let pixelSize = Math.max(1, Math.round(item.pixelSize));
    let scale = 1;
    if (outlineWidth <= 0) {
      // Drawn large and scaled down, as the entity points are.
      scale = pixelSize / 50;
      pixelSize = 50;
    }
    const css = color.toCssColorString();
    const cssOutline = outlineColor.toCssColorString();
    const billboard = collection.add({
      ...options,
      scale,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
    });
    billboard.setImage(
      JSON.stringify([css, pixelSize, cssOutline, outlineWidth]),
      Cesium.createBillboardPointCallback(
        color.alpha,
        css,
        cssOutline,
        outlineWidth,
        pixelSize,
      ),
    );
    return billboard;
  }

  /**
   * A `flow` line's material: dashes that run toward the line's end, over a
   * faint line between them, at `speed` cells a second (`flowTime` keeps
   * its clock). The dash pattern of the route annotations, which drew their
   * routes before the draw port.
   */
  function flowMaterial(style) {
    return new Cesium.Material({
      fabric: {
        type: FLOW_MATERIAL,
        uniforms: {
          color: toColor(style.color),
          time: flowTime(style.speed),
          repeat: style.repeat,
          duty: style.duty,
          speed: style.speed,
        },
        source: FLOW_SOURCE,
      },
    });
  }

  function lineMaterial(style) {
    switch (style.kind) {
      case 'flow':
        return flowMaterial(style);
      case 'solid':
        return Cesium.Material.fromType('Color', {
          color: toColor(style.color),
        });
      case 'glow':
        return Cesium.Material.fromType('PolylineGlow', {
          color: toColor(style.color),
          glowPower: style.power,
          taperPower: style.taper ?? 1,
        });
      case 'dash':
        return Cesium.Material.fromType('PolylineDash', {
          color: toColor(style.color),
          gapColor: toColor(style.gapColor ?? [0, 0, 0, 0]),
          dashLength: style.length,
          ...(style.pattern16 !== undefined
            ? { dashPattern: style.pattern16 }
            : {}),
        });
      case 'arrow':
        return Cesium.Material.fromType('PolylineArrow', {
          color: toColor(style.color),
        });
      default:
        throw new Error(`the Cesium renderer has no ${style.kind} lines`);
    }
  }

  function linePositions(item) {
    const flat = item.positions instanceof Float64Array;
    const points = [];
    const n = flat ? item.positions.length / 3 : item.positions.length;
    for (let i = 0; i < n; i++)
      points.push(
        flat
          ? new Cesium.Cartesian3(
              item.positions[i * 3],
              item.positions[i * 3 + 1],
              item.positions[i * 3 + 2],
            )
          : toCartesian(item.positions[i]),
      );
    if (item.mode !== 'geodesic') return points;
    const dense = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = Cesium.Cartographic.fromCartesian(points[i]);
      const b = Cesium.Cartographic.fromCartesian(points[i + 1]);
      const geodesic = new Cesium.EllipsoidGeodesic(a, b);
      for (let k = 0; k < 64; k++) {
        const s = k / 64;
        const at = geodesic.interpolateUsingFraction(s);
        dense.push(
          Cesium.Cartesian3.fromRadians(
            at.longitude,
            at.latitude,
            a.height + (b.height - a.height) * s,
          ),
        );
      }
    }
    dense.push(points.at(-1));
    return dense;
  }

  /**
   * Whether `positions` make a line: two or more of them, not all at one
   * place.
   */
  const drawable = (positions) =>
    positions.length >= 2 &&
    positions.some((p) => !Cesium.Cartesian3.equals(p, positions[0]));

  /**
   * A line not draped that has a `depthFailColor`: a primitive of its own,
   * drawn in that colour where the surface hides it. Built at once, so one
   * built anew where it moves draws in the frame it replaces the old one.
   * Null when its positions make no line.
   */
  function depthFailLine(record, item, id) {
    const positions = linePositions(item);
    if (!drawable(positions)) return null;
    const material = lineMaterial(item.style);
    if (item.style.kind === 'flow') record.flowMaterials.push(material);
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions,
          width: item.widthPx,
          vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
          // Straight between the positions, as the collection's lines are
          // (geodesic ones come densified).
          arcType: Cesium.ArcType.NONE,
        }),
        id,
      }),
      appearance: new Cesium.PolylineMaterialAppearance({ material }),
      depthFailAppearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', {
          color: toColor(item.depthFailColor),
        }),
      }),
      show: item.show !== false,
      asynchronous: false,
    });
  }

  function buildLines(record) {
    // Refused before anything changes, so the set keeps drawing as it was.
    for (const item of record.items.values())
      if (
        item.mode === 'draped' &&
        item.style.kind !== 'solid' &&
        item.style.kind !== 'flow'
      )
        throw new Error('the Cesium renderer drapes solid and flow lines only');
    const polylines = new Cesium.PolylineCollection();
    const draped = new Map();
    const flows = [];
    // Each line as drawn, for upserts that change it in place.
    const parts = new Map();
    record.lineParts = parts;
    // What the old host's flow lines run on, while it still draws; a host
    // already retiring keeps drawing in its place, with its own.
    if (!record.retiring) record.retiringFlows = record.flowMaterials ?? null;
    record.flowMaterials = [];
    // Lines with a depth-fail colour, beside the collection.
    let deep = null;
    for (const item of record.items.values()) {
      if (item.mode === 'draped') {
        const kind = item.style.kind;
        const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
        const id = pickId(record, item);
        const part = {
          look: lineLook(item),
          positions: flatPositions(item.positions),
          clampTo,
          id,
          ground: null,
        };
        parts.set(item.id, part);
        const show = new Cesium.ShowGeometryInstanceAttribute(
          item.show !== false,
        );
        const instance = new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: linePositions(item),
            width: item.widthPx,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes:
            kind === 'solid'
              ? {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    toColor(item.style.color),
                  ),
                  show,
                }
              : { show },
          id,
        });
        if (kind === 'flow') {
          // A material for the whole primitive: one primitive each.
          const material = flowMaterial(item.style);
          record.flowMaterials.push(material);
          flows.push({ clampTo, instance, material, part });
          continue;
        }
        if (!draped.has(clampTo)) draped.set(clampTo, []);
        draped.get(clampTo).push(instance);
        continue;
      }
      if (item.depthFailColor) {
        deep ??= new Cesium.PrimitiveCollection();
        const id = pickId(record, item);
        const primitive = depthFailLine(record, item, id);
        if (primitive) deep.add(primitive);
        parts.set(item.id, { look: lineLook(item), id, deep: primitive });
        continue;
      }
      const material = lineMaterial(item.style);
      if (item.style.kind === 'flow') record.flowMaterials.push(material);
      const polyline = polylines.add({
        positions: linePositions(item),
        width: item.widthPx,
        material,
        show: item.show !== false,
        id: pickId(record, item),
      });
      parts.set(item.id, { look: lineLook(item), polyline });
    }
    let own = polylines;
    if (deep) {
      own = new Cesium.PrimitiveCollection();
      own.add(polylines);
      own.add(deep);
    }
    record.deepLines = deep;
    noteFlows(record);
    if (!draped.size && !flows.length) return replaceHost(record, own);
    // Draped lines drape as the entities' clamped polylines do.
    const byClamp = new Map();
    const ground = [...draped].map(([clampTo, geometryInstances]) => {
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: classificationOf(clampTo),
        allowPicking: record.spec.pickable !== false,
      });
      byClamp.set(clampTo, primitive);
      return primitive;
    });
    for (const part of parts.values())
      if (part.clampTo) part.ground = byClamp.get(part.clampTo) ?? null;
    for (const { clampTo, instance, material, part } of flows) {
      part.ground = new Cesium.GroundPolylinePrimitive({
        geometryInstances: [instance],
        appearance: new Cesium.PolylineMaterialAppearance({ material }),
        classificationType: classificationOf(clampTo),
        allowPicking: record.spec.pickable !== false,
      });
      ground.push(part.ground);
    }
    replaceHost(record, collect(own, ground), ground, own);
  }

  /**
   * How a line draws, but for where it runs and whether it shows: lines
   * that keep it can be changed in place.
   */
  const lineLook = (item) =>
    JSON.stringify([
      item.mode,
      item.widthPx,
      item.clampTo,
      item.style,
      item.depthFailColor,
      item.segmentColors,
      item.segmentShow,
      item.revealFraction,
      item.frame,
    ]);

  /** A line's positions as one flat array of numbers, to compare. */
  function flatPositions(positions) {
    if (positions instanceof Float64Array) return Array.from(positions);
    const flat = [];
    for (const p of positions)
      if ('x' in p) flat.push(p.x, p.y, p.z);
      else flat.push(p.lon, p.lat, p.height ?? 0, NaN);
    return flat;
  }

  const samePositions = (a, b) =>
    a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  /**
   * Upsert lines in place, without a rebuild, when every item is drawn now
   * and looks the same: then only whether it shows, its `meta`, and where
   * a line not draped runs change (one with a depth-fail colour is built
   * anew, alone). A draped line keeps its positions, and
   * its ground primitive must be ready. False, changing nothing, otherwise.
   */
  function patchLines(record, list) {
    const parts = record.lineParts;
    if (record.kind !== 'lines' || !parts) return false;
    for (const item of list) {
      const was = parts.get(item.id);
      if (!was || was.look !== lineLook(item)) return false;
      if (was.deep !== undefined && record.deepLines?.isDestroyed())
        return false;
      if (
        was.ground &&
        (was.ground.isDestroyed() ||
          (!was.ground.ready && !record.pending?.includes(was.ground)) ||
          !samePositions(flatPositions(item.positions), was.positions))
      )
        return false;
    }
    for (const item of list) {
      const was = parts.get(item.id);
      const show = item.show !== false;
      if (was.polyline) {
        was.polyline.positions = linePositions(item);
        was.polyline.show = show;
        was.polyline.id.meta = item.meta;
        continue;
      }
      if (was.deep !== undefined) {
        was.id.meta = item.meta;
        // Built anew where it now runs, under the same pick id.
        const deep = record.deepLines;
        const old = was.deep;
        if (old)
          record.flowMaterials = record.flowMaterials.filter(
            (material) => material !== old.appearance.material,
          );
        was.deep = depthFailLine(record, item, was.id);
        if (was.deep) deep.add(was.deep);
        if (old) deep.remove(old);
        continue;
      }
      was.id.meta = item.meta;
      // A ground primitive still building takes its show once it is ready
      // (`swapReady`), so a show change never restarts the build.
      // A show queued while it built is stale once a newer one is applied.
      if (was.ground.ready) {
        showPart(was, show);
        was.pendingShow = undefined;
      } else was.pendingShow = show;
    }
    return true;
  }

  /** A draped line part's show, on its ready ground primitive. */
  function showPart(part, show) {
    const attributes = part.ground.getGeometryInstanceAttributes(part.id);
    attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
      show,
      attributes.show,
    );
  }

  /** The shows patched in while a set's ground primitives were building. */
  function showPending(record) {
    for (const part of record.lineParts?.values() ?? [])
      if (part.pendingShow !== undefined && !part.ground.isDestroyed()) {
        showPart(part, part.pendingShow);
        part.pendingShow = undefined;
      }
  }

  /** One host for a set's own collection and its ground primitives. */
  function collect(own, ground) {
    const host = new Cesium.PrimitiveCollection();
    if (own) host.add(own);
    for (const primitive of ground) host.add(primitive);
    return host;
  }

  const heightOf = (pos) =>
    'x' in pos
      ? Cesium.Cartographic.fromCartesian(toCartesian(pos)).height
      : (pos.height ?? 0);

  function shapeGeometry(item) {
    const g = item.geometry;
    const extrudedHeight = item.extrudeHeight;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        const hierarchy = new Cesium.PolygonHierarchy(
          outer,
          holes.map((h) => new Cesium.PolygonHierarchy(h)),
        );
        return {
          fill: new Cesium.PolygonGeometry({
            polygonHierarchy: hierarchy,
            height: g.perPositionHeight ? undefined : heightOf(g.rings[0][0]),
            extrudedHeight,
            perPositionHeight: g.perPositionHeight,
          }),
          ring: outer,
        };
      }
      case 'ellipse': {
        const ellipse = {
          center: toCartesian(g.center),
          semiMajorAxis: g.semiMajor,
          semiMinorAxis: g.semiMinor,
          rotation: g.rotation ?? 0,
          height: heightOf(g.center),
          extrudedHeight,
        };
        return {
          fill: new Cesium.EllipseGeometry(ellipse),
          // Its outline is an outline geometry, as the entities' ellipses draw it.
          outline: item.outline
            ? new Cesium.EllipseOutlineGeometry(ellipse)
            : undefined,
        };
      }
      case 'rectangle':
        return {
          fill: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(
              g.rect.west,
              g.rect.south,
              g.rect.east,
              g.rect.north,
            ),
            height: g.height ?? 0,
            extrudedHeight,
          }),
        };
      case 'box': {
        const d = g.dimensions;
        return {
          fill: Cesium.BoxGeometry.fromDimensions({
            dimensions: new Cesium.Cartesian3(d.x, d.y, d.z),
          }),
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            toCartesian(g.center),
          ),
        };
      }
      default:
        throw new Error(`the Cesium renderer has no ${g.kind} shapes`);
    }
  }

  /** A clamped shape's fill geometry, on the ellipsoid for draping. */
  function groundGeometry(item) {
    const g = item.geometry;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        return new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            outer,
            holes.map((h) => new Cesium.PolygonHierarchy(h)),
          ),
        });
      }
      case 'ellipse':
        if (typeof g.semiMajor !== 'number' || typeof g.semiMinor !== 'number')
          throw new Error('the Cesium renderer takes fixed ellipse radii only');
        return new Cesium.EllipseGeometry({
          center: toCartesian(g.center),
          semiMajorAxis: g.semiMajor,
          semiMinorAxis: g.semiMinor,
          rotation: g.rotation ?? 0,
        });
      case 'rectangle':
        return new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(
            g.rect.west,
            g.rect.south,
            g.rect.east,
            g.rect.north,
          ),
        });
      default:
        throw new Error(`the Cesium renderer cannot clamp ${g.kind} shapes`);
    }
  }

  /**
   * A set's clamped fills as ground primitives, packed as the entities'
   * ground batches are: a fill goes in the first batch it overlaps nothing
   * in, so overlapping translucent fills blend over each other.
   */
  function groundFills(record, items) {
    const batches = [];
    for (const item of items) {
      if (item.outline)
        throw new Error('the Cesium renderer has no clamped outlines yet');
      if (!item.fill || item.outlineOnly) continue;
      if (typeof item.fill === 'object' && !Array.isArray(item.fill))
        throw new Error('the Cesium renderer fills shapes with colours only');
      if (item.extrudeHeight !== undefined)
        throw new Error('the Cesium renderer cannot clamp extruded shapes');
      const instance = new Cesium.GeometryInstance({
        geometry: groundGeometry(item),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            toColor(item.fill),
          ),
        },
        id: pickId(record, item),
      });
      const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
      const rectangle = instance.geometry.rectangle;
      let batch = batches.find(
        (b) => b.clampTo === clampTo && !b.rectangles.collides(rectangle),
      );
      if (!batch) {
        batch = {
          clampTo,
          instances: [],
          rectangles: new Cesium.RectangleCollisionChecker(),
        };
        batches.push(batch);
      }
      batch.rectangles.insert(String(batch.instances.length), rectangle);
      batch.instances.push(instance);
    }
    const pickable = record.spec.pickable !== false;
    const Ground = pickable
      ? Cesium.GroundPrimitive
      : UnpickableGroundPrimitive;
    return batches.map(
      (batch) =>
        new Ground({
          geometryInstances: batch.instances,
          classificationType: classificationOf(batch.clampTo),
          allowPicking: pickable,
        }),
    );
  }

  function buildShapes(record) {
    const host = new Cesium.PrimitiveCollection();
    const outlines = new Cesium.PolylineCollection();
    const clamped = [];
    // Image fills' materials hold their textures, which primitives leave
    // alone: the host destroys them as it goes.
    const materials = [];
    const ownMaterial = (material) => {
      if (!materials.length) {
        const destroyHost = host.destroy.bind(host);
        host.destroy = () => {
          for (const owned of materials.splice(0))
            if (!owned.isDestroyed()) owned.destroy();
          return destroyHost();
        };
      }
      materials.push(material);
      return material;
    };
    for (const item of record.items.values()) {
      if (item.show === false) continue;
      if (item.height === 'clampGround') {
        clamped.push(item);
        continue;
      }
      const imageFill =
        item.fill && typeof item.fill === 'object' && !Array.isArray(item.fill)
          ? item.fill
          : null;
      if (imageFill && !imageFill.image)
        throw new Error('the Cesium renderer fills shapes with colours only');
      const shape = shapeGeometry(item);
      const id = pickId(record, item);
      const solid =
        item.extrudeHeight !== undefined || item.geometry.kind === 'box';
      if (imageFill && !item.outlineOnly) {
        const material = ownMaterial(
          Cesium.Material.fromType('Image', {
            image: toImage(imageFill.image),
            repeat: new Cesium.Cartesian2(...(imageFill.repeat ?? [1, 1])),
          }),
        );
        host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              id,
            }),
            appearance: new Cesium.MaterialAppearance({
              material,
              materialSupport:
                Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
              translucent: true,
              closed: solid,
              flat: !solid,
              faceForward: !solid,
            }),
            asynchronous: false,
          }),
        );
      } else if (item.fill && !item.outlineOnly) {
        const color = toColor(item.fill);
        host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: color.alpha < 1,
              closed: solid,
              // Flat shapes unlit: lit, their two triangles shade apart.
              flat: !solid,
            }),
            asynchronous: false,
          }),
        );
      }
      if (item.outline && shape.outline) {
        const color = toColor(item.outline);
        host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.outline,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              flat: true,
              translucent: color.alpha < 1,
              renderState: {
                // Clamped to what the context draws, as entities do.
                lineWidth:
                  typeof scene.clampLineWidth === 'function'
                    ? scene.clampLineWidth(item.outlineWidth ?? 1)
                    : Math.min(
                        item.outlineWidth ?? 1,
                        scene.maximumAliasedLineWidth ?? 1,
                      ),
              },
            }),
            asynchronous: false,
          }),
        );
      } else if (item.outline && shape.ring)
        outlines.add({
          positions: [...shape.ring, shape.ring[0]],
          width: item.outlineWidth ?? 1,
          material: Cesium.Material.fromType('Color', {
            color: toColor(item.outline),
          }),
          id,
        });
    }
    host.add(outlines);
    const ground = groundFills(record, clamped);
    if (!ground.length) return replaceHost(record, host);
    replaceHost(record, collect(host, ground), ground, host);
  }

  function buildModels(record) {
    const host = new Cesium.PrimitiveCollection();
    replaceHost(record, host);
    // A model counts as loading until it is ready or fails, not when added;
    // each model settles once, and a failure is kept for `whenSettled`.
    host.loading = record.items.size;
    host.failed = 0;
    for (const item of record.items.values()) {
      let settled = false;
      const settle = (failed) => {
        if (settled) return;
        settled = true;
        host.loading -= 1;
        if (failed) host.failed += 1;
        scene.requestRender();
      };
      const o = item.orientation;
      const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
        toCartesian(item.pos),
        new Cesium.HeadingPitchRoll(o.heading, o.pitch, o.roll),
      );
      Cesium.Model.fromGltfAsync({
        url: item.url,
        modelMatrix,
        scale: item.scale ?? 1,
        minimumPixelSize: item.minPixelSize ?? 0,
        // All textures before ready, so a settled capture is the whole model.
        incrementallyLoadTextures: false,
        id: pickId(record, item),
      }).then(
        (model) => {
          // Rebuilt, disposed, or the renderer is gone.
          if (record.host !== host || host.isDestroyed())
            return model.destroy();
          host.add(model);
          model.readyEvent.addEventListener(() => {
            settle(false);
            record.listeners.ready.fire(item.id);
          });
          model.errorEvent.addEventListener(() => settle(true));
          scene.requestRender();
        },
        () => settle(true),
      );
    }
  }

  /** The 3D tilesets in the scene, shown or not. */
  function tilesets() {
    const found = [];
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }

  /**
   * The Cesium port draws clamped items where it is given them; it does not
   * drape them onto 3D tiles yet, so over shown tiles it is `overlay`.
   * Terrain and the ellipsoid always take draped items.
   */
  const clampState = () =>
    tilesets().some((tileset) => tileset.show) ? 'overlay' : 'draped';
  const clampListeners = listenerList(report);
  // The state last told, while anyone listens; measured after each drawn
  // frame, when what the base holds can have changed.
  let toldClamp = null;
  function watchClamp() {
    if (clampListeners.size === 0) return;
    const state = clampState();
    if (state === toldClamp) return;
    toldClamp = state;
    clampListeners.fire(state);
  }

  const draw = {
    icons: (spec) => makeSet('icons', { ...spec }, buildIcons),
    points: (spec) => makeSet('points', { ...spec }, buildPoints),
    lines: (spec) => makeSet('lines', { ...spec }, buildLines),
    shapes: (spec) => makeSet('shapes', { ...spec }, buildShapes),
    models: (spec) => makeSet('models', { ...spec }, buildModels),
    clampState,
    on(event, cb) {
      if (event !== 'clampState') return () => {};
      if (clampListeners.size === 0) toldClamp = clampState();
      return clampListeners.on(cb);
    },
    atlas(id, images) {
      atlases.set(id, { ...images });
      let changed = false;
      for (const record of [...sets.values()])
        if (record.kind === 'icons' && record.atlases?.has(id)) {
          if (record.gpu) {
            record.gpu.reatlas(id);
            setsVersion += 1;
            changed = true;
            continue;
          }
          // Its icons that draw from the atlas take their new images where
          // they are; a set that cannot is rebuilt.
          const drawing = [];
          for (const [itemId, item] of record.items)
            if (item.image?.atlas === id) drawing.push(itemId);
          if (syncIcons(record, drawing)) setsVersion += 1;
          else record.rebuild();
          changed = true;
        }
      if (changed) scene.requestRender();
    },
  };

  return {
    port: draw,
    sets,
    version: () => setsVersion,
    tilesets,
    /** Whether a set's ground primitives are still being built. */
    building: () => [...sets.values()].some((record) => record.pending),
    /** Each frame, before it draws: the horizon cull. */
    beforeRender() {
      cullHorizon();
      runFlows();
    },
    /** Each frame, after it drew: clamp state, and ground swaps. */
    afterRender() {
      watchClamp();
      swapReady();
      // Rows moving on a live clock, and flowing lines, draw on in the
      // frames that follow.
      if (
        [...sets.values()].some((record) => record.gpu?.animating()) ||
        flowing()
      )
        requestRender();
    },
    /**
     * Let go of the sets; with `removeHosts`, take what they draw out of
     * the scene too (a scene the port does not own outlives it).
     */
    dispose({ removeHosts = false } = {}) {
      clampListeners.clear();
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) {
        if (removeHosts && !scene.isDestroyed?.()) {
          if (record.host) scene.primitives.remove(record.host);
          retire(record);
        }
        record.host = null;
      }
      sets.clear();
    },
  };
}

/** The parts of the draw ports built for viewers with no renderer, by port. */
const unboundParts = new WeakMap();

/**
 * The draw port part (its sets) behind a port built for a viewer with no
 * renderer, for that viewer's query port to pick and see through; null for
 * any other port.
 * @param {object|null|undefined} port
 */
export const unboundDrawPart = (port) =>
  (port && unboundParts.get(port)) ?? null;

// A Cesium viewer with no renderer bound to it gets a
// draw port over its scene when code first asks `findDraw` for one. A
// renderer bound later supersedes it: released, its sets keep drawing until
// their owners dispose them; gone with the viewer, it lets them go.
provideUnboundDraw((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    typeof scene?.primitives?.add !== 'function' ||
    typeof scene.postRender?.addEventListener !== 'function' ||
    typeof scene.requestRender !== 'function'
  )
    return null;
  const part = createCesiumDraw({ scene, report: uncaught });
  unboundParts.set(part.port, part);
  const offs = [
    scene.preRender?.addEventListener?.(() => part.beforeRender()),
    scene.postRender.addEventListener(() => part.afterRender()),
  ];
  const off = () => offs.splice(0).forEach((remove) => remove?.());
  return {
    port: part.port,
    dispose() {
      off();
      part.dispose({ removeHosts: true });
    },
    // Released, its sets still draw, culled and swapped as before; the
    // hooks go with the scene.
    release() {},
  };
});
