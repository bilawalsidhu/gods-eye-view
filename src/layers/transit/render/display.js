// The transit vehicles on the globe contract, the same on every engine:
// - markers: two engine.movers sprite sets (the stationary fleet and the
//   vehicles mid-glide, so a glide never rewrites the fleet), drawn over the
//   scene and turned on screen; one atlas holds every glyph the layer draws
//   (data/transitIcons.js). The layer writes Billboard-shaped handles
//   (position, image, width, color, rotation, show); the writes of a frame
//   are committed once, at the end of the frame listener that made them (in
//   a microtask for writes outside a frame);
// - the selected vehicle's trail: engine.ground, its completed history in
//   alpha bands by age and its live head up to the marker;
// - the camera, surface and credits through engine.camera, engine.surface
//   and engine.credits; clicks through engine.input and engine.picker.
// Feed, playback and selection policy stay in the layer.

import * as geo from '../../../geo/index.js';
import { Rgba, rgbaFromCss } from '../../shared/color.js';
import { createMoverBank } from '../../shared/render/moverBank.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import {
  decodeImages,
  packImageAtlas,
} from '../../shared/render/imageAtlas.js';
import {
  claimCameraSensitivity,
  releaseCameraSensitivity,
} from '../../../data/cameraSensitivity.js';
import {
  cameraPoseSignature,
  perspectiveProjectedRotation,
} from '../../../data/iconOrientation.js';
import { TRANSIT_ICON_KINDS, transitIcon } from '../../../data/transitIcons.js';
import { CAMERA_PERCENTAGE_CHANGED } from '../policy.js';
import {
  MARKER_SET_IDS,
  SPRITE_SIZE_PX,
  TRAIL_BACKING_RGB,
  TRAIL_BACKING_WIDTH_PX,
  TRAIL_DEFAULT_CSS,
  TRAIL_HEAD_ALPHA,
  TRAIL_WIDTH_PX,
  markerOrder,
  trailAlpha,
  trailBand,
  trailBandAlpha,
} from './style.js';

const LAYER_ID = 'transit';
// The frustum test keeps a vehicle this close outside the view (metres).
const VIEW_MARGIN_M = 5;
// Consecutive trail segments closer than this (squared metres) join.
const JOIN_DISTANCE_SQ = 1;

/** Every glyph the markers draw: each mode, look and size. */
export function transitAtlasIcons() {
  return [
    ...new Set(
      TRANSIT_ICON_KINDS.flatMap((mode) =>
        ['normal', 'thermal', 'retro'].flatMap((style) =>
          [48, 96].map((px) => transitIcon(mode, px, { style })),
        ),
      ),
    ),
  ];
}

/** Draws the atlas (browser): each glyph at its own size, keyed by its URL. */
async function drawTransitAtlas() {
  const urls = transitAtlasIcons();
  const images = await decodeImages(urls);
  const cell = Math.max(...images.map((image) => image.naturalWidth)) + 4;
  return packImageAtlas(
    images.map((image, i) => ({
      key: urls[i],
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
    { cell, pad: 2 },
  );
}

/**
 * The two marker sets as Billboard collections: `collections` hold
 * Billboard-shaped handles; `inFrame(run)` commits what `run` wrote once.
 */
function createMarkerBanks(engine, { drawAtlas }) {
  let destroyed = false,
    atlas = null,
    queued = false,
    inFrame = 0;
  const pending = new Set();
  const owners = [];
  const api = {
    flush() {
      queued = false;
      if (destroyed) return;
      for (const bank of pending) bank.commit();
      pending.clear();
    },
    inFrame(run) {
      inFrame++;
      try {
        return run();
      } finally {
        if (--inFrame === 0) api.flush();
      }
    },
    /** The live mover sets (what a surface sample leaves out). */
    sets: () => owners.map((owner) => owner.set()).filter(Boolean),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const owner of owners) owner.destroy();
      pending.clear();
      atlas = null;
    },
  };
  const schedule = (bank) => {
    pending.add(bank);
    if (!queued && !inFrame && !destroyed) {
      queued = true;
      queueMicrotask(() => api.flush());
    }
  };
  function collection(id) {
    const handles = new Set();
    let bank = null,
      visible = false;
    const rgba = [1, 1, 1, 1];
    const colorValues = (color) => {
      rgba[0] = color.red;
      rgba[1] = color.green;
      rgba[2] = color.blue;
      rgba[3] = color.alpha;
      return rgba;
    };
    const fields = {
      position: undefined,
      rotation: undefined,
      scale: undefined,
      color: undefined,
      show: undefined,
      cell: undefined,
    };
    const update = (handle, key, value) => {
      if (!bank || destroyed || !handles.has(handle)) return;
      fields[key] = value;
      bank.update(handle, fields);
      fields[key] = undefined;
    };
    const ensure = () => {
      if (bank || !atlas || destroyed) return;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${id}-${generation}`,
          kind: 'sprite',
          capacity,
          order: markerOrder(id),
          depthTest: 'always',
          pickable: true,
          sprite: { atlas, sizePx: SPRITE_SIZE_PX },
        }),
        write: (h, set, index) =>
          set.set(index, {
            position: h.position,
            rotation: h.rotation,
            scale: h.width / SPRITE_SIZE_PX,
            color: colorValues(h.color),
            cell: h.image,
            show: h.show,
            pickId: h.id,
          }),
        onCommit: schedule,
      });
      bank.setVisible(visible);
      for (const handle of handles) bank.add(handle);
    };
    owners.push({
      ensure,
      set: () => bank?.set ?? null,
      destroy() {
        handles.clear();
        bank?.destroy();
        bank = null;
      },
    });
    return {
      get show() {
        return visible;
      },
      set show(value) {
        const next = Boolean(value);
        if (destroyed || next === visible) return;
        visible = next;
        bank?.setVisible(next);
      },
      get length() {
        return handles.size;
      },
      get: (index) => bank?.handles[index] ?? [...handles][index],
      contains: (handle) => handles.has(handle),
      add(spec) {
        if (destroyed) throw new Error('Transit markers are destroyed');
        const position = geo.cartesian3.clone(spec.position);
        let image = spec.image,
          show = spec.show !== false,
          rotation = spec.rotation ?? 0,
          width = spec.width ?? SPRITE_SIZE_PX,
          height = spec.height ?? width;
        let color = new Rgba(
          spec.color?.red,
          spec.color?.green,
          spec.color?.blue,
          spec.color?.alpha,
        );
        const handle = {
          id: spec.id,
          gevBank: null,
          gevIndex: -1,
          alignedAxis: geo.cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: spec.scaleByDistance,
          get position() {
            return position;
          },
          set position(value) {
            if (destroyed || geo.cartesian3.equals(position, value)) return;
            geo.cartesian3.clone(value, position);
            update(handle, 'position', position);
          },
          get image() {
            return image;
          },
          set image(value) {
            if (destroyed || image === value) return;
            image = value;
            update(handle, 'cell', image);
          },
          get show() {
            return show;
          },
          set show(value) {
            const next = Boolean(value);
            if (destroyed || show === next) return;
            show = next;
            update(handle, 'show', show);
          },
          get rotation() {
            return rotation;
          },
          set rotation(value) {
            if (destroyed || rotation === value) return;
            rotation = value;
            update(handle, 'rotation', rotation);
          },
          get width() {
            return width;
          },
          set width(value) {
            if (destroyed || width === value) return;
            width = value;
            update(handle, 'scale', width / SPRITE_SIZE_PX);
          },
          // Sprites are square: the width sets the size.
          get height() {
            return height;
          },
          set height(value) {
            height = value;
          },
          get color() {
            return color;
          },
          set color(value) {
            if (destroyed || color.equals(value)) return;
            color = new Rgba(value.red, value.green, value.blue, value.alpha);
            update(handle, 'color', colorValues(color));
          },
        };
        handles.add(handle);
        ensure();
        bank?.add(handle);
        return handle;
      },
      remove(handle) {
        if (!handles.delete(handle)) return false;
        bank?.remove(handle);
        return true;
      },
      removeAll() {
        for (const handle of handles) bank?.remove(handle);
        handles.clear();
      },
    };
  }
  api.collections = MARKER_SET_IDS.map(collection);
  api.ready = Promise.resolve()
    .then(drawAtlas)
    .then((drawn) => {
      if (destroyed) return;
      atlas = drawn;
      for (const owner of owners) owner.ensure();
      api.flush();
    });
  // An early decode failure is reported even before a caller awaits ready.
  api.ready.catch(() => {
    if (!destroyed) console.error('Transit sprite atlas failed');
  });
  return api;
}

const samePosition = (a, b) =>
  !!a &&
  !!b &&
  (a === b || geo.cartesian3.distanceSquared(a, b) < JOIN_DISTANCE_SQ);

/**
 * The selected vehicle's trail on engine.ground. The history is the
 * layer's prepared segments ({ fromT, toT, fromSeq, toSeq, positions: [a,
 * b] }, in time order); the segments the display clock has passed draw in
 * two lanes (a dark edge under the colour), one line per lane for each run
 * of joined segments in one age band, re-banded once per displayed second.
 * The head is the segment being driven, from its start to the marker.
 */
function createTrail(engine, { id }) {
  let seq = 0;
  let segments = [],
    runs = [],
    revision = -1,
    rebuilds = 0,
    headRebuilds = 0,
    visible = true,
    destroyed = false;
  let rgb = rgbaFromCss(TRAIL_DEFAULT_CSS).rgba().slice(0, 3);
  let css = TRAIL_DEFAULT_CSS;
  let completed = -1,
    lastSecond = -1,
    active = null;
  // Body lines by run and band: { backing, line, from, to, band }.
  let groups = new Map();
  let body = { show: true, ready: true, lines: 0 };
  const head = { show: false, positions: [], width: TRAIL_WIDTH_PX };
  const backing = {
    show: false,
    positions: [],
    width: TRAIL_BACKING_WIDTH_PX,
  };
  const lineOf = (widthPx, color, order, reveal = false, backing) => {
    const set = engine.ground.createSet({
      id: `${id}-${++seq}`,
      kind: 'corridor',
      dynamic: true,
      order,
      reveal,
    });
    let positions = [];
    const commit = () => {
      set.replace(
        positions.length
          ? [{ positions, widthPx, color, ...(backing ? { backing } : {}) }]
          : [],
      );
      set.commit();
    };
    set.show(visible);
    return {
      show: set.show,
      destroy: set.destroy,
      setReveal: set.setReveal,
      setPositions(points) {
        positions = points.map((point) => {
          const carto = geo.cartographic.fromCartesian(point);
          return [
            geo.math.toDegrees(carto.longitude),
            geo.math.toDegrees(carto.latitude),
          ];
        });
        commit();
      },
      setColor(next) {
        color = next;
        commit();
      },
    };
  };
  const laneColor = (alpha) => [...rgb, alpha];
  const backingColor = (alpha) => [...TRAIL_BACKING_RGB, alpha];
  let headLines = null;
  const ensureHead = () =>
    (headLines ??= {
      line: lineOf(TRAIL_WIDTH_PX, laneColor(TRAIL_HEAD_ALPHA), 3, true, {
        widthPx: TRAIL_BACKING_WIDTH_PX,
        color: backingColor(TRAIL_HEAD_ALPHA),
      }),
    });
  const dropGroup = (group) => {
    group.backing.destroy();
    group.line.destroy();
  };
  const clearBody = () => {
    for (const group of groups.values()) dropGroup(group);
    groups = new Map();
    body.lines = 0;
  };
  // The positions of segments [from, to] as one line.
  const runPositions = (from, to) => {
    const positions = [segments[from].positions[0]];
    for (let i = from; i <= to; i++) positions.push(segments[i].positions[1]);
    return positions;
  };
  // Each run's completed segments by band (a run's alpha only falls with
  // age, so a band is one span of it); a line keeps its run and band and is
  // rewritten only when its span changes.
  function band(displayT) {
    const reusable = groups;
    groups = new Map();
    let start = 0;
    while (start <= completed) {
      const run = runs[start];
      const level = trailBand(trailAlpha(displayT - segments[start].toT));
      let end = start;
      while (
        end + 1 <= completed &&
        runs[end + 1] === run &&
        trailBand(trailAlpha(displayT - segments[end + 1].toT)) === level
      )
        end++;
      const key = `${run}:${level}`;
      let group = reusable.get(key);
      reusable.delete(key);
      if (!group) {
        const alpha = trailBandAlpha(level);
        group = {
          level,
          backing: lineOf(TRAIL_BACKING_WIDTH_PX, backingColor(alpha), 0),
          line: lineOf(TRAIL_WIDTH_PX, laneColor(alpha), 1),
          from: -1,
          to: -1,
        };
      }
      if (group.from !== start || group.to !== end) {
        const positions = runPositions(start, end);
        group.backing.setPositions(positions);
        group.line.setPositions(positions);
        group.from = start;
        group.to = end;
      }
      groups.set(key, group);
      start = end + 1;
    }
    for (const group of reusable.values()) dropGroup(group);
    body.lines = groups.size * 2;
  }
  function hideHead() {
    head.show = backing.show = false;
    if (headLines) {
      headLines.line.show(false);
    }
  }
  return {
    replaceHistory(next) {
      if (destroyed || next.revision === revision) return;
      revision = next.revision;
      segments = next.segments;
      runs = [];
      let run = 0;
      for (let i = 0; i < segments.length; i++) {
        if (
          i > 0 &&
          !samePosition(segments[i - 1].positions[1], segments[i].positions[0])
        )
          run++;
        runs.push(run);
      }
      completed = -1;
      lastSecond = -1;
      active = null;
      clearBody();
      hideHead();
      body = { show: visible, ready: true, lines: 0 };
      if (segments.length) rebuilds++;
      engine.render.request('transit-trail-history');
    },
    setDisplaySample(sample, renderedPosition) {
      if (destroyed) return;
      if (!sample || !renderedPosition) {
        hideHead();
        return;
      }
      const second = Math.floor(sample.displayT / 1000);
      let lo = 0,
        hi = segments.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (segments[mid].toT <= sample.displayT) lo = mid + 1;
        else hi = mid;
      }
      const done = lo - 1;
      const candidate = segments[lo];
      const segment =
        candidate &&
        candidate.fromT <= sample.displayT &&
        candidate.fromSeq === sample.fromSeq &&
        candidate.toSeq === sample.toSeq
          ? candidate
          : null;
      if (done !== completed || second !== lastSecond) {
        completed = done;
        lastSecond = second;
        band(sample.displayT);
      }
      const show = visible && !!segment && sample.fraction < 1;
      head.show = backing.show = show;
      if (!show) {
        hideHead();
        return;
      }
      const lines = ensureHead();
      lines.line.show(true);
      const positions = [segment.positions[0], renderedPosition];
      head.positions = backing.positions = positions;
      if (active !== segment) {
        active = segment;
        lines.line.setPositions(segment.positions);
        headRebuilds++;
      }
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (sample.displayT - segment.fromT) / (segment.toT - segment.fromT),
        ),
      );
      lines.line.setReveal(fraction);
    },
    setStyle(next) {
      if (destroyed || next === css) return;
      css = next;
      rgb = rgbaFromCss(css).rgba().slice(0, 3);
      for (const group of groups.values())
        group.line.setColor(laneColor(trailBandAlpha(group.level)));
      headLines?.line.setColor(laneColor(TRAIL_HEAD_ALPHA));
      engine.render.request('transit-trail-style');
    },
    setVisible(next) {
      if (destroyed || visible === next) return;
      visible = next;
      body.show = next;
      for (const group of groups.values()) {
        group.backing.show(next);
        group.line.show(next);
      }
      const headShown = next && head.show;
      headLines?.line.show(headShown);
      engine.render.request('transit-trail-visible');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearBody();
      if (headLines) {
        headLines.line.destroy();
        headLines = null;
      }
      segments = [];
      engine.render.request('transit-trail-destroy');
    },
    diagnostics: () => ({
      revision,
      rebuilds,
      segments: segments.length,
      body: segments.length ? body : null,
      head,
      backing,
      headPrimitive: null,
      active,
      ground: true,
      headStrategy: 'ground corridors: age bands and a segment reveal head',
      headRebuilds,
      entitiesAdded: 0,
    }),
  };
}

/**
 * Where a click lands in the image before a sensor style bent it: the
 * surveillance lens's barrel distortion and the sensors' pixelation grid
 * (src/styles/surveillance.js, thermal.js), read from the engine's own
 * style state (render.style), on every engine that draws the styles.
 */
function styleClickPosition(engine, style, position) {
  if (style !== 'thermal' && style !== 'surveillance') return position;
  const styles = engine.render.visualStyles;
  if (!styles?.includes(style)) return position;
  const { intensity = 0, uniforms = {} } = engine.render.style(style) ?? {};
  if (!(intensity > 0)) return position;
  const { width: w, height: h } = engine.host.size();
  const canvas = engine.host.canvas;
  const bufferWidth = canvas?.width || w,
    bufferHeight = canvas?.height || h;
  let u = position.x / w,
    v = 1 - position.y / h;
  if (style === 'surveillance') {
    const x = u * 2 - 1,
      y = v * 2 - 1,
      r2 = x * x + y * y;
    const d = 1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
    u = (x * d + 1) / 2;
    v = (y * d + 1) / 2;
  }
  const grid = 1 + ((uniforms.pixelation ?? 1) - 1) * intensity;
  u +=
    ((Math.floor((u * bufferWidth) / grid) * grid) / bufferWidth - u) *
    intensity;
  v +=
    ((Math.floor((v * bufferHeight) / grid) * grid) / bufferHeight - v) *
    intensity;
  return { x: u * w, y: (1 - v) * h };
}

/**
 * Registry factory (src/app/layers/renderers.js): `(engine, context)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ state: object, services: object,
 *   drawAtlas?: () => Promise<{ canvas: object, cells: object }> }} context
 *   `drawAtlas` is a test seam: the glyph atlas.
 */
export function createTransitDisplay(
  engine,
  { state, services, drawAtlas = drawTransitAtlas } = {},
) {
  let destroyed = false,
    attached = false,
    markers = null;
  const removers = new Set(),
    trails = new Set();
  const wrap = (run) => (markers ? markers.inFrame(run) : run());
  const layerView = createEngineLayerView(engine, {
    layerId: LAYER_ID,
    wrap,
    isDestroyed: () => destroyed,
  });
  const { view, freshCamera } = layerView;
  const own = (remove) => {
    const release = () => {
      if (removers.delete(release)) remove();
    };
    removers.add(release);
    return release;
  };
  const listen = (event, fn) =>
    own(event.addEventListener((...args) => wrap(() => fn(...args))));
  const scratchCartographic = geo.cartographic.create();
  return {
    engine,
    attach() {
      attached = true;
    },
    get ready() {
      return attached && !destroyed;
    },
    createMarkers() {
      markers = createMarkerBanks(engine, { drawAtlas });
      return markers.collections;
    },
    /** The atlas is drawn (tests, QA). */
    whenReady: () => markers?.ready,
    cameraCartographic: () => freshCamera().positionCartographic,
    viewRectangle: () => engine.camera.viewRectangle(),
    cameraSignature: () => cameraPoseSignature(freshCamera()),
    rotation: (position, course, previous) =>
      perspectiveProjectedRotation(view.scene, position, course, previous),
    // A pose of its own: the sweep runs off the frame path, after any turn.
    visibilityTester() {
      const pose = engine.camera.pose();
      const { width, height } = engine.host.size();
      const tanY = Math.tan(pose.fovy / 2);
      const tanX =
        tanY * (pose.aspectRatio ?? (height > 0 ? width / height : 1));
      // The perpendicular margin to each side plane, along the view axis.
      const xMargin = VIEW_MARGIN_M * Math.hypot(1, tanX),
        yMargin = VIEW_MARGIN_M * Math.hypot(1, tanY);
      const delta = geo.cartesian3.create();
      return {
        hasFrustum: true,
        test(point) {
          geo.cartesian3.subtract(point, pose.position, delta);
          const z = geo.cartesian3.dot(delta, pose.direction);
          return {
            horizon: engine.projector.horizonVisible(point),
            inFrustum:
              z >= -VIEW_MARGIN_M &&
              Math.abs(geo.cartesian3.dot(delta, pose.right)) <=
                z * tanX + xMargin &&
              Math.abs(geo.cartesian3.dot(delta, pose.up)) <=
                z * tanY + yMargin,
          };
        },
      };
    },
    claimCamera: () =>
      claimCameraSensitivity(engine, LAYER_ID, CAMERA_PERCENTAGE_CHANGED),
    releaseCamera: () => releaseCameraSensitivity(engine, LAYER_ID),
    onCameraChanged: (fn) => listen(engine.camera.changed, fn),
    onPreRender: (fn) => listen(engine.frames.preRender, fn),
    onPostRender: (fn) => own(engine.frames.postRender.addEventListener(fn)),
    terrainHeight(lat, lon) {
      // Photoreal tiles hide the globe: the floor comes from the mesh
      // samples and the coarse floors instead.
      if (engine.maps.photorealActive()) return undefined;
      if (!engine.surface.terrainHeightSupported) return undefined;
      return engine.surface.terrainHeight(
        geo.cartographic.fromDegrees(lon, lat, 0, scratchCartographic),
      );
    },
    // The engine's surface leaves out mover sets, not single sprites: a
    // probe never lands on a vehicle of either set.
    sampleMeshFloorCells: (points, options) =>
      services.mesh?.sampleMeshFloorCells?.(engine, points, {
        ...options,
        excludeObjects: markers?.sets() ?? [],
      }),
    addCredit(feed, timestamps) {
      services.credits.registerDynamicCredit(
        engine,
        services.credits.transitFeedCredit(feed, timestamps),
      );
    },
    createTrailRenderer() {
      const trail = createTrail(engine, { id: `${LAYER_ID}-trail` });
      trails.add(trail);
      const destroy = trail.destroy;
      trail.destroy = () => {
        trails.delete(trail);
        destroy();
      };
      return trail;
    },
    bindClick(listener, pointerFree) {
      const remove = own(
        engine.input.on('click', (event) => {
          if (!pointerFree()) return;
          const position = styleClickPosition(
            engine,
            state._stylePreset,
            event.position,
          );
          const picked = engine.picker.pick(position);
          const id = typeof picked?.id === 'string' ? picked.id : null;
          const entry = id === null ? null : state._vehicles.get(id);
          listener({
            id,
            primitiveId: null,
            x: position.x,
            y: position.y,
            collection: entry?.marker
              ? entry.markerCollection === state._animatedMarkers
                ? 'animated'
                : 'stationary'
              : null,
          });
        }),
      );
      return { destroy: remove };
    },
    frameProbe() {
      // The contract has no per-set upload hook: every scene upload counts,
      // an upper bound (never an unavailable count read as zero).
      const canvas = engine.host.canvas;
      return {
        canvas,
        gl: canvas.getContext?.('webgl2'),
        uploads: [],
        allUploads: true,
        uploadScope: 'scene-upper-bound',
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of [...removers]) remove();
      releaseCameraSensitivity(engine, LAYER_ID);
      for (const trail of [...trails]) trail.destroy();
      markers?.destroy();
      markers = null;
      layerView.destroy();
      attached = false;
    },
  };
}
