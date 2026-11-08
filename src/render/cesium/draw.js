/**
 * @module render/cesium/draw
 * @description The Cesium renderer's draw port
 * (`src/render/contract/draw.d.ts`): batched sets of items, each set one
 * primitive collection in the scene, rebuilt when its items change (icon
 * sets, unclamped points restyled or moved, and models, change in place;
 * `drawModels.js`). Every
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
import { alongLength } from '../../geo/polyline.js';
import { provideUnboundDraw } from '../rendererOf.js';
import { listenerList, toCartesian, uncaught } from './common.js';
import { createGpuIcons, GPU_ICON_CAPABILITIES } from './gpuIcons.js';
import { createModelSets } from './drawModels.js';

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

/** The longest straight step of a geodesic line, metres: a degree of arc. */
const GEODESIC_STEP_M =
  Cesium.Ellipsoid.WGS84.maximumRadius * Cesium.Math.RADIANS_PER_DEGREE;
/** The fewest straight steps a geodesic line is drawn in. */
const GEODESIC_LINE_STEPS = 64;

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

/** The line styles the port drapes. */
const DRAPED_STYLES = new Set(['solid', 'glow', 'dash', 'flow']);

// Whether Cesium's approximate terrain heights have been asked for.
let terrainHeightsAsked = false;

/**
 * Whether a ground polyline can be built in the frame it is made: Cesium
 * needs its approximate terrain heights loaded for that. The first time
 * one is wanted they are asked for (as Cesium's entities ask, which then
 * build those lines the same way); until they load, false.
 */
function groundSyncs() {
  if (Cesium.ApproximateTerrainHeights.initialized) return true;
  if (!terrainHeightsAsked) {
    terrainHeightsAsked = true;
    try {
      Cesium.GroundPolylinePrimitive.initializeTerrainHeights().catch(() => {});
    } catch {
      // Nowhere to load them from: such lines are rebuilt as before.
    }
  }
  return false;
}

/** The prefix of a revealed line's material types, one per style kind. */
const REVEAL_MATERIAL = 'DrawRevealLine';

/**
 * A line drawn only up to `reveal` along its texture (`st.s`, 0 at its
 * start, 1 at its end), in its own style past that: the rest is discarded,
 * so it neither draws nor picks.
 */
const REVEAL_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  if (materialInput.st.s > reveal) discard;
  return revealed;
}`;

/**
 * Where along a drawn line's texture its first `fraction` of length ends,
 * for the reveal material. A ground polyline's texture runs along its
 * length; a polyline's runs evenly per vertex, so `positions` (as drawn)
 * map the length onto it. Nothing past 0, everything from 1.
 * @param {number} fraction
 * @param {Array<{x: number, y: number, z: number}>} [positions]
 */
export function revealUniform(fraction, positions) {
  if (!(fraction > 0)) return -1;
  if (fraction >= 1) return 2;
  if (!positions) return fraction;
  // As a polyline draws them: neighbours at one place are one vertex.
  positions = Cesium.arrayRemoveDuplicates(
    positions,
    Cesium.Cartesian3.equalsEpsilon,
  );
  const at = alongLength(positions, fraction);
  return at ? (at.index + at.t) / (positions.length - 1) : 2;
}

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

/** What `syncIcons` did: icons added or removed, or only changed in place. */
const ICONS_CHANGED = 'changed';
const ICONS_KEPT = 'kept';

/** What `patchPoints` did: points added too, or only changed in place. */
const POINTS_ADDED = 'added';
const POINTS_KEPT = 'kept';

/**
 * The draw port over `scene`, and what the other ports read of it: the live
 * sets by id, a version that changes with what height queries see through
 * in them, the scene's 3D tilesets and
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
  // Bumped whenever what height queries see through may have changed: a
  // set made, rebuilt, restyled or gone, or items added or removed (icons
  // changed in place keep their pick ids, so they do not bump it).
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
    const listeners = {
      ready: listenerList(report),
      loadFailed: listenerList(report),
    };
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
      record.pointHost = null;
      // The lines as the host this build replaces draws them.
      record.drawnParts = record.lineParts;
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
    // Icons changed in place: height queries see through the sets' pick
    // ids, which an icon keeps, so only icons added or gone change them.
    const iconsPatched = (synced) => {
      if (synced === ICONS_CHANGED) setsVersion += 1;
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
        const synced = syncIcons(record, items.keys(), true);
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      upsert(list) {
        if (onGpu(record, list)) {
          for (const item of list) items.set(item.id, item);
          record.gpu.write(list);
          return patched();
        }
        // Points restyled, moved or added keep the pick ids they had, so
        // only points added change what height queries see through.
        const points = patchPoints(record, list);
        if (points) {
          for (const item of list) items.set(item.id, item);
          if (points === POINTS_ADDED) setsVersion += 1;
          requestRender();
          return;
        }
        // Lines that only change how they show or where an undraped one
        // runs, and clamped shapes that only show or hide, are changed
        // where they are.
        if (
          patchLines(record, list) ||
          patchShapes(record, list) ||
          (kind === 'models' && modelSets.upsert(record, list))
        ) {
          for (const item of list) items.set(item.id, item);
          if (kind === 'lines') noteFlows(record);
          setsVersion += 1;
          requestRender();
          return;
        }
        for (const item of list) items.set(item.id, item);
        const synced = syncIcons(
          record,
          list.map((item) => item.id),
        );
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        if (removePoints(record, ids)) return patched();
        if (record.gpu) {
          record.gpu.drop(ids);
          return patched();
        }
        const synced = syncIcons(record, []);
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      clear() {
        items.clear();
        if (record.gpu) {
          record.gpu.sync();
          return patched();
        }
        const synced = syncIcons(record, []);
        if (synced) return iconsPatched(synced);
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
        if (kind === 'models') modelSets.restyle(record);
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
   * when the next one comes is dropped. With `groundShown` false, the new
   * ground primitives show nothing yet (all their items are hidden), so
   * the old host goes at once rather than wait for them.
   */
  function replaceHost(
    record,
    host,
    ground = null,
    own = null,
    groundShown = true,
  ) {
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
      groundShown &&
      !record.retiring &&
      !record.pending &&
      record.ground
    ) {
      record.retiring = old;
      if (record.own) old.remove(record.own);
    } else if (old) scene.primitives.remove(old);
    if (!waiting || !groundShown) retire(record);
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
    record.retiringParts = null;
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
      const horizon = horizonNow();
      if (!horizon) return;
      for (const placed of record.placed) {
        const show = placed.shown && horizon.isPointVisible(placed.position);
        if (placed.primitive.show !== show) placed.primitive.show = show;
      }
    }
  }

  /** The horizon from the eye as it is now; null where there is none (2D). */
  function horizonNow() {
    const eye = scene.camera?.positionWC;
    // The eye is ECEF in 3D only.
    if (
      !eye ||
      (scene.mode ?? Cesium.SceneMode.SCENE3D) !== Cesium.SceneMode.SCENE3D
    )
      return null;
    occluder ??= new Cesium.EllipsoidalOccluder(
      scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
      eye,
    );
    occluder.cameraPosition = eye;
    return occluder;
  }

  /**
   * Whether a point or icon updated in place shows now: past the horizon
   * of a culled set it stays hidden, even when the update comes after this
   * frame's cull (a frame listener that moves its items).
   */
  function shownNow(record, placed) {
    if (!placed.shown || !record.spec.horizonCull) return placed.shown;
    return horizonNow()?.isPointVisible(placed.position) ?? true;
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
    placed.shown = look.show;
    billboard.show = shownNow(record, placed);
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
   * collection of its own. When done, `ICONS_CHANGED` if icons were added
   * or removed (the set's pick ids changed), else `ICONS_KEPT`.
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
    let added = false;
    for (const [id, item] of record.items) {
      const image = images.get(id);
      if (image === undefined) continue;
      const entry = drawn.get(id);
      if (entry) patchIcon(record, entry, item, image);
      else {
        addIcon(record, item, image);
        added = true;
      }
    }
    return added || gone.size ? ICONS_CHANGED : ICONS_KEPT;
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
      if (heightReference === Cesium.HeightReference.NONE) {
        points ??= new Cesium.PointPrimitiveCollection({
          blendOption: pointBlendOf(record.spec.blend),
        });
        addPoint(record, points, item, position, show);
        continue;
      }
      // Point primitives cannot follow the ground.
      dots ??= new Cesium.BillboardCollection({ scene });
      const primitive = addDot(dots, item, {
        position,
        heightReference,
        show,
        distanceDisplayCondition: displayConditionOf(item.displayRange),
        id: pickId(record, item),
      });
      record.patchable ??= new Map();
      record.patchable.set(item.id, {
        primitive,
        placed: place(record, primitive, position, show),
        at: placeOf(item),
        lodGroup: item.lodGroup,
        dot: dotLook(item).key,
        heightReference,
      });
    }
    // With no clamped dots, its points are drawn by one collection that
    // takes points added later where it is.
    if (!dots)
      points ??= new Cesium.PointPrimitiveCollection({
        blendOption: pointBlendOf(record.spec.blend),
      });
    record.patchable ??= new Map();
    record.pointHost = dots ? null : points;
    let host = points ?? dots;
    if (points && dots) {
      host = new Cesium.PrimitiveCollection();
      host.add(points);
      host.add(dots);
    }
    replaceHost(record, host);
  }

  /** Draw an unclamped point item on `points`, the set's collection. */
  function addPoint(record, points, item, position, show) {
    const primitive = points.add({
      position,
      ...pointLook(item),
      show,
      id: pickId(record, item),
    });
    record.patchable ??= new Map();
    record.patchable.set(item.id, {
      primitive,
      placed: place(record, primitive, position, show),
      at: placeOf(item),
      lodGroup: item.lodGroup,
      look: pointLookOf(item),
    });
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

  // An unclamped point's look, by the item's members each primitive member
  // is drawn from: an upsert sets only the members whose values changed,
  // so a set moving every point each frame makes nothing new for the look.
  const LOOK = [
    ['pixelSize', (item) => item.pixelSize],
    ['color', (item) => toColor(item.color)],
    ['outlineColor', (item) => toColor(item.outlineColor ?? [0, 0, 0, 0])],
    ['outlineWidth', (item) => item.outlineWidth ?? 0],
    ['disableDepthTestDistance', (item) => item.disableDepthTest ?? 0],
    ['scaleByDistance', (item) => nearFarOf(item.scaleByDistance)],
    ['translucencyByDistance', (item) => nearFarOf(item.fadeByDistance)],
    [
      'distanceDisplayCondition',
      (item) => displayConditionOf(item.displayRange),
    ],
  ];
  const LOOK_FROM = [
    'pixelSize',
    'color',
    'outlineColor',
    'outlineWidth',
    'disableDepthTest',
    'scaleByDistance',
    'fadeByDistance',
    'displayRange',
  ];

  /**
   * What a point's look keeps of an item member: a frozen value of plain
   * members (a frozen colour or curve) as it is, since it cannot change and
   * is then told unchanged by identity; anything else as a `plainCopy`.
   */
  function lookCopy(value) {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value))
      return plainCopy(value);
    // Only plain data cannot change: no getters, nothing inherited.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype)
      return plainCopy(value);
    for (const key of Reflect.ownKeys(value)) {
      const member = Object.getOwnPropertyDescriptor(value, key);
      if (
        !('value' in member) ||
        (member.value !== null && typeof member.value === 'object')
      )
        return plainCopy(value);
    }
    return value;
  }

  /** A copy of the item members a point's look is drawn from. */
  const pointLookOf = (item) => LOOK_FROM.map((key) => lookCopy(item[key]));

  /**
   * Whether `value` holds what `kept` (a `plainCopy` of a colour, curve or
   * range) holds, read without allocating: points moved every frame
   * compare their looks every frame.
   */
  function sameLookValue(kept, value) {
    if (Object.is(kept, value)) return true;
    if (
      !kept ||
      !value ||
      typeof kept !== 'object' ||
      typeof value !== 'object'
    )
      return false;
    if (Array.isArray(kept) !== Array.isArray(value)) return false;
    if (Array.isArray(value)) {
      // Colours, read by index: a `for...in` over an array is far slower.
      if (kept.length !== value.length) return false;
      for (let i = 0; i < value.length; i++)
        if (!Object.is(kept[i], value[i])) return false;
      return true;
    }
    let count = 0;
    for (const key in value) {
      if (value[key] === undefined) continue;
      count += 1;
      if (!Object.is(kept[key], value[key])) return false;
    }
    for (const key in kept) if (kept[key] !== undefined) count -= 1;
    return count === 0;
  }

  /** Set the members of a point's look whose item values changed. */
  function patchLook(was, item) {
    for (let i = 0; i < LOOK.length; i++) {
      const value = item[LOOK_FROM[i]];
      if (sameLookValue(was.look[i], value)) continue;
      was.primitive[LOOK[i][0]] = LOOK[i][1](item);
      was.look[i] = lookCopy(value);
    }
  }

  /**
   * Where an item is, as its values when drawn: a caller may change the
   * position object it passes and send the same one again.
   */
  const placeOf = (item) => {
    const pos = item.pos;
    return [
      pos?.x,
      pos?.y,
      pos?.z,
      pos?.lon,
      pos?.lat,
      pos?.height,
      item.height,
    ];
  };

  /**
   * Whether an item is somewhere else than `at`; if so, `at` takes it. Read
   * member by member, by name: points moved every frame are compared every
   * frame.
   */
  function movedFrom(at, item) {
    const pos = item.pos;
    const x = pos?.x;
    const y = pos?.y;
    const z = pos?.z;
    const lon = pos?.lon;
    const lat = pos?.lat;
    const height = pos?.height;
    if (
      Object.is(x, at[0]) &&
      Object.is(y, at[1]) &&
      Object.is(z, at[2]) &&
      Object.is(lon, at[3]) &&
      Object.is(lat, at[4]) &&
      Object.is(height, at[5]) &&
      Object.is(item.height, at[6])
    )
      return false;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    at[3] = lon;
    at[4] = lat;
    at[5] = height;
    at[6] = item.height;
    return true;
  }

  /** A position as Cesium's, written into `result`. */
  function toCartesianInto(pos, result) {
    if ('x' in pos)
      return Cesium.Cartesian3.fromElements(pos.x, pos.y, pos.z, result);
    return Cesium.Cartesian3.fromDegrees(
      pos.lon,
      pos.lat,
      pos.height ?? 0,
      undefined,
      result,
    );
  }

  /**
   * Upsert points in place, without a rebuild, when every item is one the
   * set draws now, in the same LOD group, and stays drawn the same way: an
   * unclamped point stays unclamped (then how it looks changes on the point
   * it has, member by member), a clamped dot clamps the same way and keeps
   * its look (the dot image it is drawn with). Where it is, its `meta`, its
   * display range and whether it shows change in place; a dot moved follows
   * the ground where it now is. A new unclamped item joins a set drawn by
   * one point collection where it is. `POINTS_ADDED` when items were
   * added, `POINTS_KEPT` when all were changed in place; false, changing
   * nothing, otherwise.
   */
  function patchPoints(record, list) {
    const patchable = record.patchable;
    if (record.kind !== 'points' || !patchable) return false;
    // New ids, to tell one sent twice (a rebuild keeps the last).
    let added = null;
    for (const item of list) {
      const was = patchable.get(item.id);
      const heightReference = heightReferenceOf(
        item.height,
        record.spec.clampTo,
      );
      if (!was) {
        // Only an unclamped point joins, on the set's one collection.
        if (
          !record.pointHost ||
          record.host !== record.pointHost ||
          record.pointHost.isDestroyed?.() ||
          heightReference !== Cesium.HeightReference.NONE ||
          added?.has(item.id)
        )
          return false;
        (added ??= new Set()).add(item.id);
        continue;
      }
      if (item.lodGroup !== was.lodGroup) return false;
      if (was.dot === undefined) {
        if (heightReference !== Cesium.HeightReference.NONE) return false;
      } else if (
        heightReference !== was.heightReference ||
        dotLook(item).key !== was.dot
      )
        return false;
    }
    for (const item of list) {
      const was = patchable.get(item.id);
      const show = item.show !== false && displayable(item.displayRange);
      if (!was) {
        const position = toCartesian(item.pos);
        addPoint(record, record.pointHost, item, position, show);
        const placed = patchable.get(item.id).placed;
        placed.primitive.show = shownNow(record, placed);
        continue;
      }
      if (movedFrom(was.at, item)) {
        // The cull's own copy of where it is; the primitive copies it.
        toCartesianInto(item.pos, was.placed.position);
        was.primitive.position = was.placed.position;
      }
      if (was.dot === undefined) patchLook(was, item);
      else {
        was.primitive.distanceDisplayCondition = displayConditionOf(
          item.displayRange,
        );
        was.primitive.disableDepthTestDistance = item.disableDepthTest ?? 0;
      }
      was.primitive.id.meta = item.meta;
      was.placed.shown = show;
      was.primitive.show = shownNow(record, was.placed);
    }
    return added ? POINTS_ADDED : POINTS_KEPT;
  }

  /**
   * Remove points from a set drawn by one point collection where they are,
   * as the items that stay keep drawing. False, changing nothing, for a set
   * drawn otherwise.
   */
  function removePoints(record, ids) {
    if (
      record.kind !== 'points' ||
      !record.pointHost ||
      record.host !== record.pointHost ||
      record.pointHost.isDestroyed?.()
    )
      return false;
    const gone = new Set();
    for (const id of ids) {
      const was = record.patchable.get(id);
      if (!was) continue;
      record.patchable.delete(id);
      record.pointHost.remove(was.primitive);
      gone.add(was.primitive);
    }
    if (gone.size) {
      record.pickIds = record.pickIds.filter((pick) =>
        record.patchable.has(pick.id),
      );
      record.placed = record.placed.filter(
        (placed) => !gone.has(placed.primitive),
      );
    }
    return true;
  }

  /**
   * How a clamped point's dot is drawn: its image (by key) and the scale
   * it is drawn at.
   */
  function dotLook(item) {
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
    return {
      key: JSON.stringify([css, pixelSize, cssOutline, outlineWidth, scale]),
      image: JSON.stringify([css, pixelSize, cssOutline, outlineWidth]),
      alpha: color.alpha,
      css,
      cssOutline,
      outlineWidth,
      pixelSize,
      scale,
    };
  }

  /**
   * A clamped point as Cesium's entity points draw one: a billboard of a
   * dot drawn at its pixel size, one texture per look.
   */
  function addDot(collection, item, options) {
    const look = dotLook(item);
    const billboard = collection.add({
      ...options,
      scale: look.scale,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
    });
    billboard.setImage(
      look.image,
      Cesium.createBillboardPointCallback(
        look.alpha,
        look.css,
        look.cssOutline,
        look.outlineWidth,
        look.pixelSize,
      ),
    );
    return billboard;
  }

  /**
   * A line's material; with `reveal` (where along its texture the line
   * ends, `revealUniform`), one drawing only that far. A flow material
   * (the route annotations' dashes, which run toward the line's end on the
   * clock `flowTime` keeps) is noted for the frame clock.
   */
  function lineMaterial(record, style, reveal) {
    const fabric = lineFabric(style);
    // Built from its type, then given its values, as `fromType` does:
    // values in the fabric would be merged into copies of the type's.
    const template = ({ type, source, uniforms }) =>
      source ? { type, source, uniforms } : { type };
    const material =
      reveal === undefined
        ? new Cesium.Material({ fabric: template(fabric) })
        : new Cesium.Material({
            fabric: {
              type: `${REVEAL_MATERIAL}_${style.kind}`,
              materials: { revealed: template(fabric) },
              uniforms: { reveal },
              source: REVEAL_SOURCE,
            },
          });
    const drawn = reveal === undefined ? material : material.materials.revealed;
    Object.assign(drawn.uniforms, fabric.uniforms);
    const flow = flowOf(material, style);
    if (flow) record.flowMaterials.push(flow);
    return material;
  }

  /**
   * The flow material a line's material runs on (itself, or what a revealed
   * line draws), for the frame clock; null for other styles.
   */
  const flowOf = (material, style) =>
    style.kind !== 'flow'
      ? null
      : material.type === FLOW_MATERIAL
        ? material
        : material.materials.revealed;

  /** Stop running the clock of a line material that no longer draws. */
  function dropFlow(record, material, style) {
    const flow = material && flowOf(material, style);
    if (flow)
      record.flowMaterials = record.flowMaterials.filter((m) => m !== flow);
  }

  /** Whether a line draws only the first part of its length. */
  const revealed = (item) => item.revealFraction !== undefined;

  /** The fabric of a line style's material. */
  function lineFabric(style) {
    switch (style.kind) {
      case 'flow':
        return {
          type: FLOW_MATERIAL,
          uniforms: {
            color: toColor(style.color),
            time: flowTime(style.speed),
            repeat: style.repeat,
            duty: style.duty,
            speed: style.speed,
          },
          source: FLOW_SOURCE,
        };
      case 'solid':
        return { type: 'Color', uniforms: { color: toColor(style.color) } };
      case 'glow':
        return {
          type: 'PolylineGlow',
          uniforms: {
            color: toColor(style.color),
            glowPower: style.power,
            taperPower: style.taper ?? 1,
          },
        };
      case 'dash':
        return {
          type: 'PolylineDash',
          uniforms: {
            color: toColor(style.color),
            gapColor: toColor(style.gapColor ?? [0, 0, 0, 0]),
            dashLength: style.length,
            ...(style.pattern16 !== undefined
              ? { dashPattern: style.pattern16 }
              : {}),
          },
        };
      case 'arrow':
        return {
          type: 'PolylineArrow',
          uniforms: { color: toColor(style.color) },
        };
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
      // At least a step a degree of arc, as Cesium's own geodesic
      // polylines are cut, and 64 steps over the whole line: a long trail
      // of short legs stays as light as its positions.
      const steps = Math.max(
        Math.ceil((geodesic.surfaceDistance || 0) / GEODESIC_STEP_M),
        Math.ceil(GEODESIC_LINE_STEPS / (points.length - 1)),
      );
      for (let k = 0; k < steps; k++) {
        const s = k / steps;
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
    const reveal = revealed(item)
      ? revealUniform(item.revealFraction, positions)
      : undefined;
    const material = lineMaterial(record, item.style, reveal);
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
        material: lineMaterial(
          record,
          item.depthFailDash
            ? {
                kind: 'dash',
                color: item.depthFailColor,
                length: item.depthFailDash.length,
                pattern16: item.depthFailDash.pattern16,
              }
            : { kind: 'solid', color: item.depthFailColor },
          reveal,
        ),
      }),
      show: item.show !== false,
      asynchronous: false,
    });
  }

  /**
   * A draped line's geometry instance under its pick id: coloured per
   * instance when `solid` (batched with others), else drawn by its
   * primitive's material.
   */
  function drapedInstance(item, part, solid, positions = linePositions(item)) {
    const show = new Cesium.ShowGeometryInstanceAttribute(item.show !== false);
    return new Cesium.GeometryInstance({
      geometry: new Cesium.GroundPolylineGeometry({
        positions,
        width: item.widthPx,
        arcType: Cesium.ArcType.GEODESIC,
      }),
      attributes: solid
        ? {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              toColor(item.style.color),
            ),
            show,
          }
        : { show },
      id: part.id,
    });
  }

  /** Whether a draped line draws in a batch of solid ones. */
  const batchable = (item) => item.style.kind === 'solid' && !revealed(item);

  /**
   * A ground primitive of a draped line's own, drawn by a material (a
   * style, or a reveal, a batch cannot draw) or, solid, by its colour. With
   * `sync` it is built in the first frame it is updated in, as Cesium's
   * entities build ground lines whose positions change: only once Cesium's
   * approximate terrain heights are loaded (`groundSyncs`).
   */
  function drapedPrimitive(record, item, part, sync, positions) {
    const solid = batchable(item);
    let appearance;
    if (solid) {
      appearance = new Cesium.PolylineColorAppearance();
      part.material = null;
    } else {
      part.material = lineMaterial(
        record,
        item.style,
        revealed(item) ? revealUniform(item.revealFraction) : undefined,
      );
      appearance = new Cesium.PolylineMaterialAppearance({
        material: part.material,
      });
    }
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: [drapedInstance(item, part, solid, positions)],
      appearance,
      classificationType: classificationOf(part.clampTo),
      allowPicking: record.spec.pickable !== false,
      asynchronous: !sync,
    });
  }

  function buildLines(record) {
    // Refused before anything changes, so the set keeps drawing as it was.
    for (const item of record.items.values())
      if (item.mode === 'draped' && !DRAPED_STYLES.has(item.style.kind))
        throw new Error(
          'the Cesium renderer drapes solid, glow, dash and flow lines only',
        );
      else if (
        segmented(item) &&
        (item.mode !== 'draped' ||
          item.style.kind !== 'solid' ||
          revealed(item))
      )
        throw new Error(
          'the Cesium renderer colours and shows segments of draped solid lines only',
        );
    const polylines = new Cesium.PolylineCollection();
    const draped = new Map();
    // Draped lines a batch cannot draw, each with a primitive of its own.
    const alone = [];
    // Each line as drawn, for upserts that change it in place.
    const parts = new Map();
    // What the old host's flow lines run on, while it still draws; a host
    // already retiring keeps drawing in its place, with its own.
    if (!record.retiring) {
      record.retiringFlows = record.flowMaterials ?? null;
      record.retiringParts = record.drawnParts ?? null;
    }
    record.flowMaterials = [];
    record.lineParts = parts;
    // Lines with a depth-fail colour, beside the collection.
    let deep = null;
    for (const item of record.items.values()) {
      if (item.mode === 'draped') {
        const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
        const part = {
          look: lineLook(item),
          shape: lineLook(item, true),
          positions: flatPositions(item.positions),
          clampTo,
          id: pickId(record, item),
          // Its ground primitive: its batch's, or its own.
          ground: null,
          batch: null,
          material: null,
          // Moved in place: drawn by a primitive of its own built at once.
          solo: false,
        };
        parts.set(item.id, part);
        if (segmented(item)) {
          // A line of no length builds no ground primitive (it would
          // never be ready, and hold the swap).
          const instances = segmentInstances(record, item, part);
          if (!instances.length) continue;
          if (!draped.has(clampTo)) draped.set(clampTo, []);
          draped.get(clampTo).push(...instances);
          continue;
        }
        if (!batchable(item)) {
          alone.push({ item, part });
          continue;
        }
        if (!draped.has(clampTo)) draped.set(clampTo, []);
        draped.get(clampTo).push(drapedInstance(item, part, true));
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
      const positions = linePositions(item);
      const reveal = revealed(item)
        ? revealUniform(item.revealFraction, positions)
        : undefined;
      const material = lineMaterial(record, item.style, reveal);
      const polyline = polylines.add({
        positions,
        width: item.widthPx,
        material,
        show: item.show !== false,
        id: pickId(record, item),
      });
      parts.set(item.id, {
        look: lineLook(item),
        polyline,
        reveal: reveal === undefined ? null : material,
      });
    }
    let own = polylines;
    if (deep) {
      own = new Cesium.PrimitiveCollection();
      own.add(polylines);
      own.add(deep);
    }
    record.deepLines = deep;
    if (!draped.size && !alone.length) {
      noteFlows(record);
      return replaceHost(record, own);
    }
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
      if (part.clampTo && byClamp.has(part.clampTo)) {
        part.ground = byClamp.get(part.clampTo);
        part.batch = part.ground;
      }
    for (const { item, part } of alone) {
      part.ground = drapedPrimitive(record, item, part, false);
      ground.push(part.ground);
    }
    noteFlows(record);
    replaceHost(record, collect(own, ground), ground, own);
  }

  /**
   * How a line draws, but for where it runs, whether it shows and how much
   * of it is revealed: lines that keep it can be changed in place.
   */
  const lineLook = (item, colourless = false) =>
    JSON.stringify([
      item.mode,
      item.widthPx,
      item.clampTo,
      colourless ? { ...item.style, color: undefined } : item.style,
      item.depthFailColor,
      // A dash is drawn only with a depth-fail colour, the same in any key order.
      item.depthFailColor && item.depthFailDash
        ? [item.depthFailDash.length, item.depthFailDash.pattern16]
        : null,
      // Segment colours and shows change in place.
      item.segmentColors != null,
      item.segmentShow != null,
      revealed(item),
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
    a === b ||
    (a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

  /**
   * Whether a line's positions are those `flat` (a `flatPositions`) holds,
   * read without flattening them: lines sent again every frame, unmoved,
   * make nothing new.
   */
  function flatEquals(positions, flat) {
    const same = (value, at) => at < flat.length && Object.is(value, flat[at]);
    if (positions instanceof Float64Array) {
      if (positions.length !== flat.length) return false;
      for (let i = 0; i < positions.length; i++)
        if (!same(positions[i], i)) return false;
      return true;
    }
    let at = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if ('x' in p) {
        if (!same(p.x, at) || !same(p.y, at + 1) || !same(p.z, at + 2))
          return false;
        at += 3;
        continue;
      }
      if (
        !same(p.lon, at) ||
        !same(p.lat, at + 1) ||
        !same(p.height ?? 0, at + 2) ||
        !same(NaN, at + 3)
      )
        return false;
      at += 4;
    }
    return at === flat.length;
  }

  /**
   * Whether a draped line drawn by a material of its own (not a batch's,
   * nor revealed or in segments) changes only its colour: its material
   * takes the new one in place.
   */
  const recolourable = (was, item) =>
    Boolean(was.clampTo && was.material && !was.segments) &&
    !revealed(item) &&
    was.shape === lineLook(item, true);

  /**
   * Whether a draped line's upsert can change it in place: its ground
   * primitive is still there and, unless it moves, ready or building as
   * the set's pending one (or drawn alone); one that moves is built anew
   * at once, which needs Cesium's terrain heights loaded.
   */
  function drapedPatchable(record, was, flat) {
    if (was.ground?.isDestroyed() || was.batch?.isDestroyed()) return false;
    if (!samePositions(flat, was.positions))
      return groundSyncs() && typeof record.host?.add === 'function';
    if (was.solo) return true;
    return was.ground.ready || record.pending?.includes(was.ground);
  }

  /**
   * Upsert lines in place, without a rebuild, when every item is drawn now
   * and looks the same: then only whether it shows, its `meta`, how much of
   * it is revealed and where it runs change. An undraped line moves on the
   * polyline it has (one with a depth-fail colour is built anew, alone); a
   * draped one that moves is drawn by a ground primitive of its own, built
   * anew in the frame it moves (`drapedPatchable`). False, changing
   * nothing, otherwise.
   */
  function patchLines(record, list) {
    const parts = record.lineParts;
    if (record.kind !== 'lines' || !parts) return false;
    // Each draped line's positions, flattened once for both passes.
    const flats = new Map();
    // Each item's look, in order: an item sent twice is changed twice.
    const looks = [];
    for (const item of list) {
      const was = parts.get(item.id);
      if (!was) return false;
      const look = lineLook(item);
      // Only its colour may change: its material takes it in place.
      if (was.look !== look && !recolourable(was, item)) return false;
      looks.push(look);
      if (was.deep !== undefined && record.deepLines?.isDestroyed())
        return false;
      if (!was.clampTo) continue;
      const flat = flatEquals(item.positions, was.positions)
        ? was.positions
        : flatPositions(item.positions);
      // A segmented line that moves is built anew, segment by segment (so
      // one that moves every frame is not drawn until it stops: segments
      // are for lines that move only now and then).
      if (was.segments && !samePositions(flat, was.positions)) return false;
      // One with no length draws nothing, whatever its segments' looks.
      if (was.segments && !was.ground) continue;
      if (!drapedPatchable(record, was, flat)) return false;
      flats.set(item.id, flat);
    }
    for (let k = 0; k < list.length; k++) {
      const item = list[k];
      const was = parts.get(item.id);
      const show = item.show !== false;
      if (was.look !== looks[k]) {
        was.material.uniforms.color = toColor(item.style.color);
        was.look = looks[k];
      }
      if (was.polyline) {
        const positions = linePositions(item);
        was.polyline.positions = positions;
        was.polyline.show = show;
        was.polyline.id.meta = item.meta;
        if (was.reveal)
          was.reveal.uniforms.reveal = revealUniform(
            item.revealFraction,
            positions,
          );
        continue;
      }
      if (was.deep !== undefined) {
        was.id.meta = item.meta;
        // Built anew where it now runs, under the same pick id.
        const deep = record.deepLines;
        const old = was.deep;
        if (old) {
          dropFlow(record, old.appearance.material, item.style);
          dropFlow(record, old.depthFailAppearance.material, item.style);
        }
        was.deep = depthFailLine(record, item, was.id);
        if (was.deep) deep.add(was.deep);
        if (old) deep.remove(old);
        continue;
      }
      was.id.meta = item.meta;
      if (was.segments) {
        if (!was.ground) continue;
        // A newer write supersedes one queued while the ground built.
        was.pendingItem = was.ground.ready ? undefined : item;
        if (was.ground.ready) writeSegments(was, item);
        continue;
      }
      const flat = flats.get(item.id);
      if (!samePositions(flat, was.positions)) {
        moveDraped(record, was, item, flat);
        continue;
      }
      if (was.material && revealed(item))
        was.material.uniforms.reveal = revealUniform(item.revealFraction);
      if (was.solo) {
        // Not yet drawn, it is built again showing as asked.
        if (was.ground && was.ground.ready) showPart(was, show);
        else if (was.ground) moveDraped(record, was, item, flat);
        continue;
      }
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

  /**
   * Draw a draped line where it now runs, in this frame: on a ground
   * primitive of its own built at once, in place of its own one (or of its
   * place in its batch, hidden there). Positions that make no line draw
   * nothing until they do again.
   */
  function moveDraped(record, part, item, flat) {
    const host = record.host;
    const old = part.ground;
    if (old && old !== part.batch) {
      dropFlow(record, part.material, item.style);
      for (const list of new Set([record.pending, record.ground])) {
        const at = list?.indexOf(old) ?? -1;
        if (at >= 0) list.splice(at, 1);
      }
      host.remove(old);
    } else if (old) {
      // Its batch draws on without it, hidden now or once it is ready.
      part.batchHidden = true;
      if (old.ready) showOn(old, part.id, false);
    }
    hideRetiring(record, item.id);
    part.solo = true;
    part.positions = flat;
    part.pendingShow = undefined;
    const positions = linePositions(item);
    part.material = null;
    part.ground = drawable(positions)
      ? drapedPrimitive(record, item, part, true, positions)
      : null;
    if (part.ground) host.add(part.ground);
  }

  /**
   * Hide where the host a set is rebuilding from still draws a draped line,
   * once the line is drawn where it now is: else both would draw (and
   * pick) until the rebuild is ready.
   */
  function hideRetiring(record, id) {
    const part = record.retiring && record.retiringParts?.get(id);
    const ground = part?.ground;
    if (!ground || ground.isDestroyed() || !ground.ready) return;
    // A segmented line draws under a pick id a segment.
    if (part.segments)
      for (const segment of part.segments) {
        if (segment) showOn(ground, segment, false);
      }
    else showOn(ground, part.id, false);
  }

  /** A draped line part's show, on its ready ground primitive. */
  const showPart = (part, show) => showOn(part.ground, part.id, show);

  /** The show of the instance under pick id `id` in a ready ground primitive. */
  function showOn(ground, id, show) {
    const attributes = ground.getGeometryInstanceAttributes(id);
    attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
      show,
      attributes.show,
    );
  }

  /**
   * The shows patched in while a set's ground primitives were building,
   * and the lines drawn alone since, hidden in their batches.
   */
  function showPending(record) {
    for (const part of record.shapeParts?.values() ?? [])
      if (
        part.pendingShow !== undefined &&
        part.ground &&
        !part.ground.isDestroyed()
      ) {
        showOn(part.ground, part.id, part.pendingShow);
        part.pendingShow = undefined;
      }
    for (const part of record.lineParts?.values() ?? []) {
      if (part.batchHidden && part.batch && !part.batch.isDestroyed())
        showOn(part.batch, part.id, false);
      if (
        part.pendingShow !== undefined &&
        part.ground &&
        !part.ground.isDestroyed()
      ) {
        showPart(part, part.pendingShow);
        part.pendingShow = undefined;
      }
      if (part.pendingItem && part.ground && !part.ground.isDestroyed()) {
        writeSegments(part, part.pendingItem);
        part.pendingItem = undefined;
      }
    }
  }

  /** Whether a line is drawn segment by segment, in colours or shows of their own. */
  const segmented = (item) =>
    item.segmentColors != null || item.segmentShow != null;

  /** A segment's colour and whether it shows. */
  const segmentLook = (item, j) => ({
    color: toColor(item.segmentColors?.[j] ?? item.style.color),
    show: item.show !== false && item.segmentShow?.[j] !== false,
  });

  /** What a segment draws, to tell whether an upsert changes it. */
  const segmentKey = ({ color, show }) =>
    `${color.red},${color.green},${color.blue},${color.alpha},${show}`;

  /**
   * A draped line drawn segment by segment: a ground polyline instance a
   * segment, each with a pick id of its own that reads as the line's (and
   * that height queries see through), so its colour and show change in
   * place. A segment of no length draws nothing.
   */
  function segmentInstances(record, item, part) {
    const points = linePositions(item);
    const instances = [];
    part.segments = [];
    part.drawn = [];
    for (let j = 0; j + 1 < points.length; j++) {
      if (Cesium.Cartesian3.equals(points[j], points[j + 1])) {
        part.segments.push(null);
        part.drawn.push(null);
        continue;
      }
      const id = Object.create(part.id);
      record.pickIds.push(id);
      const look = segmentLook(item, j);
      part.segments.push(id);
      part.drawn.push(segmentKey(look));
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: [points[j], points[j + 1]],
            width: item.widthPx,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(look.color),
            show: new Cesium.ShowGeometryInstanceAttribute(look.show),
          },
          id,
        }),
      );
    }
    return instances;
  }

  /** A segmented line's colours and shows, on its ready ground primitive. */
  function writeSegments(part, item) {
    for (let j = 0; j < part.segments.length; j++) {
      const id = part.segments[j];
      if (!id) continue;
      const look = segmentLook(item, j);
      const key = segmentKey(look);
      if (key === part.drawn[j]) continue;
      part.drawn[j] = key;
      const attributes = part.ground.getGeometryInstanceAttributes(id);
      attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        look.color,
        attributes.color,
      );
      attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
        look.show,
        attributes.show,
      );
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
            // An image fill turns with the rectangle, as a KML overlay's does.
            rotation: g.rotation ?? 0,
            stRotation: g.rotation ?? 0,
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
          rotation: g.rotation ?? 0,
          stRotation: g.rotation ?? 0,
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
    // Each clamped item as drawn, for upserts that only show or hide it;
    // the set keeps them once every one is built.
    const parts = new Map();
    record.shapeParts = null;
    for (const item of items) {
      if (item.outline)
        throw new Error('the Cesium renderer has no clamped outlines yet');
      if (!item.fill || item.outlineOnly) {
        parts.set(item.id, { look: lookOf(item), id: null, ground: null });
        continue;
      }
      const imageFill =
        typeof item.fill === 'object' && !Array.isArray(item.fill)
          ? item.fill
          : null;
      if (imageFill && !imageFill.image)
        throw new Error('the Cesium renderer fills shapes with colours only');
      if (item.extrudeHeight !== undefined)
        throw new Error('the Cesium renderer cannot clamp extruded shapes');
      // Draping a material needs depth textures (WebGL 2 always has them).
      if (imageFill && scene.context?.depthTexture === false)
        throw new Error('the Cesium renderer cannot drape images here');
      // Refused before anything is made, so nothing is left half built.
      const image = imageFill ? toImage(imageFill.image) : null;
      // Hidden colour fills are built too, hidden, so showing them is a
      // change of their show, not a rebuild of every fill; a hidden one it
      // cannot build stays out, as before, and showing it rebuilds. Hidden
      // image fills are not passed in (`hiddenFillBuilds`): their textures
      // load when they show.
      let geometry;
      try {
        geometry = groundGeometry(item);
      } catch (error) {
        if (item.show === false) continue;
        throw error;
      }
      const part = {
        look: lookOf(item),
        id: pickId(record, item),
        ground: null,
      };
      parts.set(item.id, part);
      const show = new Cesium.ShowGeometryInstanceAttribute(
        item.show !== false,
      );
      const instance = new Cesium.GeometryInstance({
        geometry,
        attributes: imageFill
          ? { show }
          : {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                toColor(item.fill),
              ),
              show,
            },
        id: part.id,
      });
      const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
      if (imageFill) {
        // An image fill is a ground primitive of its own, with its material.
        // (Cesium turns its texture wrongly across the antimeridian: its
        // rotation points are taken against a centre wrapped to ±180°.)
        batches.push({
          clampTo,
          instances: [instance],
          parts: [part],
          image,
          imageFill,
        });
        continue;
      }
      const rectangle = instance.geometry.rectangle;
      let batch = batches.find(
        (b) =>
          b.rectangles &&
          b.clampTo === clampTo &&
          !b.rectangles.collides(rectangle),
      );
      if (!batch) {
        batch = {
          clampTo,
          instances: [],
          parts: [],
          rectangles: new Cesium.RectangleCollisionChecker(),
        };
        batches.push(batch);
      }
      batch.rectangles.insert(String(batch.instances.length), rectangle);
      batch.instances.push(instance);
      batch.parts.push(part);
    }
    const pickable = record.spec.pickable !== false;
    const Ground = pickable
      ? Cesium.GroundPrimitive
      : UnpickableGroundPrimitive;
    const grounds = batches.map((batch) => {
      const material = batch.imageFill
        ? Cesium.Material.fromType('Image', {
            image: batch.image,
            repeat: new Cesium.Cartesian2(
              ...(batch.imageFill.repeat ?? [1, 1]),
            ),
          })
        : null;
      const ground = new Ground({
        geometryInstances: batch.instances,
        classificationType: classificationOf(batch.clampTo),
        allowPicking: pickable,
        ...(material
          ? {
              appearance: new Cesium.MaterialAppearance({
                material,
                materialSupport:
                  Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
                translucent: true,
                flat: true,
              }),
            }
          : {}),
      });
      // Its material holds the texture, which the primitive leaves alone:
      // it goes with the primitive, which may outlive the host that built it
      // while a rebuild's ground primitives get ready.
      if (material) {
        const destroyGround = ground.destroy.bind(ground);
        ground.destroy = () => {
          if (!material.isDestroyed()) material.destroy();
          return destroyGround();
        };
      }
      for (const part of batch.parts) part.ground = ground;
      return ground;
    });
    record.shapeParts = parts;
    return grounds;
  }

  /**
   * How a clamped shape draws, but for whether it shows and its `meta`: a
   * copy of its values, so an item changed in place still reads as changed.
   */
  const lookOf = (item) => {
    const { show, meta, ...look } = item;
    return plainCopy(look);
  };

  /** A copy of plain data: arrays and objects copied, the rest kept. */
  function plainCopy(value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value))
      return Array.from(value, plainCopy);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value))
      if (value[key] !== undefined) out[key] = plainCopy(value[key]);
    return out;
  }

  /** Whether `value` holds what `look` (a `plainCopy`) holds. */
  function sameValues(look, value) {
    if (Array.isArray(look)) {
      if (!(Array.isArray(value) || ArrayBuffer.isView(value))) return false;
      if (look.length !== value.length) return false;
      for (let i = 0; i < look.length; i++)
        if (!sameValues(look[i], value[i])) return false;
      return true;
    }
    if (look && typeof look === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      let count = 0;
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        count += 1;
        if (!(key in look) || !sameValues(look[key], value[key])) return false;
      }
      return count === Object.keys(look).length;
    }
    return look === value || (Number.isNaN(look) && Number.isNaN(value));
  }

  /** Whether `item` draws as the part's item did, but for show and `meta`. */
  function sameLook(part, item) {
    const { show, meta, ...look } = item;
    return sameValues(part.look, look);
  }

  /**
   * Upsert clamped shapes in place, without a rebuild, when every item is
   * drawn now and looks the same: then only whether it shows and its
   * `meta` change. A ground primitive still building takes the show once
   * it is ready (`swapReady`). False, changing nothing, otherwise.
   */
  function patchShapes(record, list) {
    const parts = record.shapeParts;
    if (record.kind !== 'shapes' || !parts) return false;
    for (const item of list) {
      const was = parts.get(item.id);
      if (!was || !sameLook(was, item)) return false;
      if (was.ground?.isDestroyed()) return false;
    }
    for (const item of list) {
      const was = parts.get(item.id);
      if (!was.ground) continue;
      was.id.meta = item.meta;
      const show = item.show !== false;
      if (was.ground.ready) {
        showOn(was.ground, was.id, show);
        was.pendingShow = undefined;
      } else was.pendingShow = show;
    }
    return true;
  }

  /** Whether a hidden clamped item is a plain colour fill `groundFills` builds. */
  const hiddenFillBuilds = (item) =>
    Boolean(item.fill) &&
    !item.outlineOnly &&
    !item.outline &&
    item.extrudeHeight === undefined &&
    (typeof item.fill !== 'object' || Array.isArray(item.fill));

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
      // Clamped ones are built hidden as well (`groundFills`), when they
      // are a colour fill it can draw: others hidden stay out, as before.
      if (
        item.height === 'clampGround' &&
        (item.show !== false || hiddenFillBuilds(item))
      ) {
        clamped.push(item);
        continue;
      }
      if (item.show === false) continue;
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
    replaceHost(
      record,
      collect(host, ground),
      ground,
      host,
      clamped.some(
        (item) => item.show !== false && item.fill && !item.outlineOnly,
      ),
    );
  }

  const modelSets = createModelSets({
    scene,
    toColor,
    pickId,
    replaceHost,
    horizonNow,
    requestRender,
  });
  const buildModels = (record) => modelSets.build(record);

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
          const synced = syncIcons(record, drawing);
          if (!synced) record.rebuild();
          else if (synced === ICONS_CHANGED) setsVersion += 1;
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
      modelSets.beforeRender(sets.values());
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
