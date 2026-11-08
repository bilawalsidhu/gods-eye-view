// The satellites layer's display, the same on every globe engine, through
// the engine contract only: the fleet's dots are engine.movers point banks
// (one per look: size, outline, distance scale, depth mode), the tracked
// satellite's dot is its own bank drawn over them, the orbit rings are
// engine.lines turned by their model matrix (GMST), the follow is
// engine.camera.follow and clicks come through the engine's selection
// dispatcher. The view the logic reads (camera, scene, frame number) is the
// shared engine layer view.
//
// The logic holds handles with Cesium's PointPrimitive field vocabulary
// (position, show, pixelSize, color, outlineColor, outlineWidth,
// scaleByDistance, disableDepthTestDistance, id); a change of look moves the
// dot to that look's bank. The writes of a frame are committed once, at the
// end of the frame listener that made them (or in a microtask for writes
// outside a frame).

import * as geo from '../../../geo/index.js';
import { createMoverBank } from '../../shared/render/moverBank.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { Rgba, WHITE, constantRgba } from '../../shared/color.js';

const LAYER_ID = 'satellites';
const YELLOW = constantRgba(1, 1, 0);
// The tracked dot: 14 px yellow with a 2 px white outline, never depth-tested.
const TRACKED_POINT = Object.freeze({
  pixelSize: 14,
  color: YELLOW,
  outlineColor: WHITE,
  outlineWidth: 2,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
});
// An orbit ring's alpha in front of the scene, and where the scene hides it.
const ORBIT_ALPHA = 0.6;
const ORBIT_OCCLUDED_ALPHA = 0.35;
// The tracked dot draws over the fleet.
const TRACKED_ORDER = 100;

const copyColor = (color) =>
  new Rgba(
    color?.red ?? 1,
    color?.green ?? 1,
    color?.blue ?? 1,
    color?.alpha ?? 1,
  );

const depthTestOf = (distance) =>
  distance === Number.POSITIVE_INFINITY
    ? 'always'
    : distance > 0
      ? { disableWithinM: distance }
      : 'normal';

/**
 * Registry factory (src/app/layers/renderers.js): `(engine)`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createSatellitesDisplay(engine) {
  const banks = new Map();
  const points = new Map();
  const tracked = new Set();
  const orbits = new Set();
  const dirty = new Set();
  let destroyed = false;
  let inFrame = 0;
  let queued = false;
  let visible = true;
  let sequence = 0;
  let releasing = false;
  let starting = null;

  // --- commits: once per frame listener, or in a microtask -----------------
  const flush = () => {
    queued = false;
    for (const bank of dirty) bank.commit();
    dirty.clear();
  };
  const onCommit = (bank) => {
    dirty.add(bank);
    if (inFrame === 0 && !queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
  const inFrameDo = (run) => {
    inFrame++;
    try {
      return run();
    } finally {
      inFrame--;
      if (inFrame === 0) flush();
    }
  };
  const layerView = createEngineLayerView(engine, {
    layerId: LAYER_ID,
    wrap: inFrameDo,
    isDestroyed: () => destroyed,
  });

  // --- the dots ----------------------------------------------------------------
  const rgba = new Float64Array(4);
  const writeColor = (color) => {
    rgba[0] = color.red;
    rgba[1] = color.green;
    rgba[2] = color.blue;
    rgba[3] = color.alpha;
  };
  const fields = {
    position: null,
    color: rgba,
    show: true,
    pickId: null,
  };
  const positionField = { position: null };
  const colorField = { color: rgba };
  const showField = { show: true };
  const write = (point, set, index) => {
    writeColor(point.values.color);
    fields.position = point.values.position;
    fields.show = point.values.show;
    fields.pickId = point.id;
    set.set(index, fields);
  };
  // One bank per family (fleet, tracked) and look.
  const bankFor = (point) => {
    const v = point.values;
    const scale = v.scaleByDistance;
    const outline = v.outlineColor;
    const key = [
      point.family,
      v.pixelSize,
      v.outlineWidth,
      outline.red,
      outline.green,
      outline.blue,
      outline.alpha,
      ...(scale
        ? [scale.near, scale.nearValue, scale.far, scale.farValue]
        : ['none']),
      v.disableDepthTestDistance,
    ].join(':');
    let entry = banks.get(key);
    if (!entry) {
      const id = ++sequence;
      const bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${LAYER_ID}-points-${id}-${generation}`,
          kind: 'point',
          capacity,
          pickable: true,
          depthTest: depthTestOf(v.disableDepthTestDistance),
          order: point.family === 'tracked' ? TRACKED_ORDER : 0,
          point: {
            sizePx: v.pixelSize,
            outlinePx: v.outlineWidth,
            outlineColor: [
              outline.red,
              outline.green,
              outline.blue,
              outline.alpha,
            ],
            scaleByDistance: scale
              ? [scale.near, scale.nearValue, scale.far, scale.farValue]
              : undefined,
          },
        }),
        write,
        onCommit,
      });
      entry = { bank, family: point.family };
      banks.set(key, entry);
      bank.setVisible(point.family === 'tracked' || visible);
    }
    return entry.bank;
  };
  const LOOK = [
    'pixelSize',
    'outlineWidth',
    'outlineColor',
    'scaleByDistance',
    'disableDepthTestDistance',
  ];
  const createPoint = (spec, family = 'fleet') => {
    const point = {
      id: spec.id,
      family,
      gevBank: null,
      gevIndex: -1,
      values: {
        position: geo.cartesian3.clone(spec.position ?? geo.cartesian3.ZERO),
        color: copyColor(spec.color ?? WHITE),
        show: spec.show !== false,
        pixelSize: spec.pixelSize ?? 1,
        outlineColor: copyColor(spec.outlineColor ?? WHITE),
        outlineWidth: spec.outlineWidth ?? 0,
        scaleByDistance: spec.scaleByDistance ?? null,
        disableDepthTestDistance: spec.disableDepthTestDistance ?? 0,
      },
    };
    Object.defineProperties(point, {
      position: {
        get: () => point.values.position,
        set(value) {
          geo.cartesian3.clone(value, point.values.position);
          positionField.position = point.values.position;
          point.gevBank?.update(point, positionField);
        },
      },
      color: {
        get: () => point.values.color,
        set(value) {
          point.values.color = copyColor(value);
          writeColor(point.values.color);
          point.gevBank?.update(point, colorField);
        },
      },
      show: {
        get: () => point.values.show,
        set(value) {
          if (point.values.show === Boolean(value)) return;
          point.values.show = Boolean(value);
          showField.show = point.values.show;
          point.gevBank?.update(point, showField);
        },
      },
    });
    for (const key of LOOK)
      Object.defineProperty(point, key, {
        get: () => point.values[key],
        set(value) {
          const next = key === 'outlineColor' ? copyColor(value) : value;
          const current = point.values[key];
          if (
            current === value ||
            (key === 'outlineColor' && current.equals(next))
          )
            return;
          point.values[key] = next;
          // Another look is another bank.
          if (point.gevBank) bankFor(point).add(point);
        },
      });
    bankFor(point).add(point);
    return point;
  };
  const collection = {
    get show() {
      return visible;
    },
    set show(value) {
      visible = Boolean(value);
      for (const entry of banks.values())
        if (entry.family === 'fleet') entry.bank.setVisible(visible);
    },
    add(spec) {
      const point = createPoint(spec);
      points.set(point.id, point);
      return point;
    },
    remove(point) {
      if (!point || points.get(point.id) !== point) return false;
      points.delete(point.id);
      point.gevBank?.remove(point);
      return true;
    },
    removeAll() {
      for (const point of points.values()) point.gevBank?.remove(point);
      points.clear();
    },
  };

  // --- follow ------------------------------------------------------------------
  const follow = {
    start(handle) {
      const outer = starting;
      starting = handle;
      try {
        handle.gevFollowHandle = engine.camera.follow({
          native: handle,
          position: handle.sample,
          viewFrom: () => handle.viewFrom,
          // The tracked readout's card as plain data (the handle's
          // annotation fields, read when the card paints).
          label:
            typeof handle.gevTrackedId === 'string'
              ? {
                  id: handle.gevTrackedId,
                  model: () => handle.gevLabelModel,
                  position: () =>
                    handle.gevDisplayPosition?.() ?? handle.sample(),
                }
              : undefined,
        });
      } finally {
        starting = outer;
      }
    },
    release() {
      releasing = true;
      try {
        engine.camera.following()?.stop();
      } finally {
        releasing = false;
      }
    },
    releasing: () => releasing,
    // What is followed: this layer's tracked handle, else what the follow is
    // of (another layer's handle or entity), else the follow itself.
    current() {
      if (starting) return starting;
      const current = engine.camera.following();
      if (!current) return null;
      for (const handle of tracked)
        if (handle.gevFollowHandle === current) return handle;
      return current.native ?? current;
    },
    onChanged: (listener) =>
      engine.camera.followChanged.addEventListener(listener),
  };

  return {
    engine,
    view: layerView.view,
    createPoints: () => collection,
    removePoints: () => collection.removeAll(),
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    // Each frame (before drawing): the listener, then the tracked dots read
    // their position (the frame's sample).
    onFrame: (listener) =>
      layerView.view.on('preRender', () => {
        listener();
        for (const handle of tracked) {
          const position = handle.sample();
          if (position) handle.point.position = position;
        }
      }),
    /** An orbit ring at identity; `commitOrbit` applies its modelMatrix. */
    createOrbit({ positions, width, color }) {
      const line = engine.lines.createLine({
        id: `${LAYER_ID}-orbit-${++sequence}`,
        widthPx: width,
        color: [color.red, color.green, color.blue, ORBIT_ALPHA],
        depthFailAlpha: ORBIT_OCCLUDED_ALPHA / ORBIT_ALPHA,
        arc: 'geodesic',
      });
      line.setPositions(positions);
      let shown = true;
      const orbit = {
        line,
        modelMatrix: geo.matrix4.clone(geo.matrix4.IDENTITY),
        get show() {
          return shown;
        },
        set show(value) {
          shown = Boolean(value);
          line.show(shown);
        },
      };
      orbits.add(orbit);
      return orbit;
    },
    commitOrbit(orbit) {
      if (orbits.has(orbit)) orbit.line.setModelMatrix(orbit.modelMatrix);
    },
    removeOrbit(orbit) {
      if (!orbit || !orbits.delete(orbit)) return;
      orbit.line.destroy();
    },
    /**
     * The tracked satellite: its dot over the fleet, followed by
     * follow.start. `position()` is read each frame.
     */
    createTracked({ id, position, viewFrom }) {
      const handle = {
        id: `${LAYER_ID}:${id}`,
        sample: position,
        viewFrom,
        gevFollowHandle: null,
        position: { getValue: () => position() },
        point: createPoint(
          { id, position: position(), ...TRACKED_POINT },
          'tracked',
        ),
      };
      tracked.add(handle);
      return handle;
    },
    trackedPosition: (handle) => handle?.sample() ?? undefined,
    removeTracked(handle) {
      if (!handle || !tracked.delete(handle)) return;
      handle.point.gevBank?.remove(handle.point);
      if (
        handle.gevFollowHandle &&
        engine.camera.following() === handle.gevFollowHandle
      )
        follow.release();
    },
    follow,
    /** Every click with its top pick (the old LEFT_CLICK rule). */
    listenClick(listener) {
      const dispatcher = selectionDispatcherFor(engine);
      const remove = dispatcher.register(LAYER_ID, {
        owns: (id) => points.has(Number(id)),
        onClick: listener,
      });
      return { destroy: remove };
    },
    pickedNorad: (picked) => Number(picked?.id ?? picked?.primitive?.id),
    isTrackedPick: (picked, handle) =>
      Boolean(
        handle &&
        Number(picked?.id ?? picked?.primitive?.id) === handle.point.id,
      ),
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      for (const orbit of orbits) orbit.line.destroy();
      orbits.clear();
      for (const entry of banks.values()) entry.bank.destroy();
      banks.clear();
      dirty.clear();
      points.clear();
      tracked.clear();
      layerView.destroy();
    },
  };
}
