// Satellite points, rigid orbit rings and follow through the globe contract.
import * as geo from '../../../geo/index.js';
import { createMoverBank } from '../../shared/render/navaraMoverBank.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { WHITE, constantRgba } from '../../shared/color.js';

const YELLOW = constantRgba(1, 1, 0);
export function createSatellitesNavaraRenderer(engine) {
  const banks = new Map();
  const points = new Map();
  const tracked = new Set();
  const orbits = new Set();
  const dirty = new Set();
  let destroyed = false;
  let inFrame = false;
  let queued = false;
  let visible = true;
  let sequence = 0;
  let releasing = false;
  let starting = null;
  const rgba = new Float64Array(4);
  const fields = {
    position: null,
    color: rgba,
    scale: 1,
    show: true,
    pickId: null,
  };
  const positionField = { position: null };
  const colorField = { color: rgba };
  const showField = { show: true };
  const flush = () => {
    queued = false;
    for (const bank of dirty) bank.commit();
    dirty.clear();
  };
  const onCommit = (bank) => {
    dirty.add(bank);
    if (!inFrame && !queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
  const frame = (run) => {
    inFrame = true;
    try {
      return run();
    } finally {
      inFrame = false;
      flush();
    }
  };
  const layerView = createEngineLayerView(engine, {
    layerId: 'satellites',
    wrap: frame,
    isDestroyed: () => destroyed,
  });
  const copyColor = (color) => {
    rgba[0] = color.red;
    rgba[1] = color.green;
    rgba[2] = color.blue;
    rgba[3] = color.alpha;
  };
  const write = (point, set, index) => {
    copyColor(point.values.color);
    fields.position = point.values.position;
    fields.show = point.values.show;
    fields.pickId = point.id;
    set.set(index, fields);
  };
  const bankFor = (point) => {
    const v = point.values;
    const scale = v.scaleByDistance;
    const outline = v.outlineColor;
    const depth =
      v.disableDepthTestDistance === Infinity
        ? 'always'
        : v.disableDepthTestDistance > 0
          ? { disableWithinM: v.disableDepthTestDistance }
          : 'normal';
    const key = [
      point.family,
      v.pixelSize,
      v.outlineWidth,
      outline.red,
      outline.green,
      outline.blue,
      outline.alpha,
      ...Object.values(scale ?? {}),
      v.disableDepthTestDistance,
    ].join(':');
    let entry = banks.get(key);
    if (!entry) {
      const id = ++sequence;
      const bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `satellites-points-${id}-${generation}`,
          kind: 'point',
          capacity,
          pickable: true,
          depthTest: depth,
          order: point.family === 'tracked' ? 100 : 0,
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
              : null,
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
  const createPoint = (spec, family = 'fleet') => {
    const point = {
      id: spec.id,
      family,
      gevBank: null,
      gevIndex: -1,
      values: {
        position: geo.cartesian3.clone(spec.position),
        color: spec.color ?? WHITE,
        show: spec.show !== false,
        pixelSize: spec.pixelSize ?? 1,
        outlineColor: spec.outlineColor ?? WHITE,
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
          point.values.color = value;
          copyColor(value);
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
    for (const key of [
      'pixelSize',
      'outlineWidth',
      'outlineColor',
      'scaleByDistance',
      'disableDepthTestDistance',
    ])
      Object.defineProperty(point, key, {
        get: () => point.values[key],
        set(value) {
          if (point.values[key] === value) return;
          point.values[key] = value;
          bankFor(point).add(point);
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
      if (!points.delete(point.id)) return false;
      point.gevBank?.remove(point);
      return true;
    },
    removeAll() {
      for (const point of points.values()) point.gevBank?.remove(point);
      points.clear();
    },
  };
  const follow = {
    start(entity) {
      starting = entity;
      try {
        const followLabel = {
          id: entity.gevTrackedId,
          model: () => entity.gevLabelModel,
          position: () => entity.gevDisplayPosition?.() ?? entity.sample(),
        };
        entity.follow = engine.camera.follow({
          position: entity.sample,
          viewFrom: () => entity.viewFrom,
          label: followLabel,
        });
      } finally {
        starting = null;
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
    current() {
      if (starting) return starting;
      const current = engine.camera.following();
      for (const entity of tracked)
        if (entity.follow === current && current) return entity;
      return current;
    },
    onChanged: (listener) =>
      engine.camera.followChanged.addEventListener(listener),
  };
  return {
    kind: 'navara',
    engine,
    view: layerView.view,
    createPoints: () => collection,
    removePoints: () => collection.removeAll(),
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    onFrame: (listener) =>
      layerView.view.on('preRender', () => {
        listener();
        for (const entity of tracked) {
          const position = entity.sample();
          if (position) entity.point.position = position;
        }
      }),
    createOrbit({ positions, width, color }) {
      const line = engine.lines.createLine({
        id: `satellites-orbit-${++sequence}`,
        widthPx: width,
        color: [color.red, color.green, color.blue, 0.6],
        depthFailAlpha: 0.35 / 0.6,
        arc: 'geodesic',
      });
      line.setPositions(positions);
      const primitive = {
        line,
        modelMatrix: geo.matrix4.clone(geo.matrix4.IDENTITY),
        visible: true,
        get show() {
          return this.visible;
        },
        set show(value) {
          this.visible = Boolean(value);
          line.show(this.visible);
        },
      };
      orbits.add(primitive);
      return primitive;
    },
    commitOrbit: (primitive) =>
      primitive.line.setModelMatrix(primitive.modelMatrix),
    removeOrbit(primitive) {
      primitive.line.destroy();
      orbits.delete(primitive);
    },
    createTracked({ id, position, viewFrom }) {
      const entity = {
        id: `satellites:${id}`,
        sample: position,
        viewFrom,
        follow: null,
        position: { getValue: position },
        point: createPoint(
          {
            id,
            position: position(),
            pixelSize: 14,
            color: YELLOW,
            outlineColor: WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Infinity,
          },
          'tracked',
        ),
      };
      tracked.add(entity);
      return entity;
    },
    trackedPosition: (entity) => entity?.point.position,
    removeTracked(entity) {
      entity.point.gevBank?.remove(entity.point);
      tracked.delete(entity);
      if (entity.follow && engine.camera.following() === entity.follow)
        follow.release();
    },
    follow,
    listenClick(listener) {
      const dispatcher = selectionDispatcherFor(engine);
      if (!dispatcher)
        throw new Error('Satellite selection dispatcher unavailable');
      const remove = dispatcher.register('satellites', {
        owns: (id) => points.has(Number(id)),
        onClick: listener,
      });
      return { destroy: remove };
    },
    pickedNorad: (picked) => Number(picked?.id ?? picked?.primitive?.id),
    isTrackedPick: (picked, entity) =>
      Boolean(
        entity &&
        Number(picked?.id ?? picked?.primitive?.id) === entity.point.id,
      ),
    destroy() {
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
