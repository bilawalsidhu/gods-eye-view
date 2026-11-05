// Mission points, paths and the pad zone on Navara.
import * as geo from '../../../geo/index.js';
import { createMoverBank } from '../../shared/render/navaraMoverBank.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { registerViewerEngine } from '../../../globe/cesium/engineFromViewer.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { createPadGround } from './navaraPadGround.js';

const read = (v, time) =>
  typeof v?.getValue === 'function' ? v.getValue(time) : v;
const property = (v) =>
  typeof v?.getValue === 'function' ? v : { getValue: () => v };
const rgba = (c) => (c ? [c.red, c.green, c.blue, c.alpha] : [1, 1, 1, 1]);
export function createLaunchesNavaraRenderer(
  engine,
  { view: nativeView, EffectDesc, NavaraEffect } = {},
) {
  let destroyed = false,
    sequence = 0,
    inFrame = false,
    queued = false,
    bankVisibility = false;
  const sources = new Set(),
    banks = new Map(),
    dirty = new Set(),
    primitives = new Set();
  const flush = () => {
    queued = false;
    for (const bank of dirty) bank.commit();
    dirty.clear();
  };
  const touch = (bank) => {
    dirty.add(bank);
    if (!inFrame && !queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
  const fields = { position: null, color: null, show: true };
  const pointBank = (record, graphic, sprite) => {
    const time = engine.clock.now(),
      size =
        read(sprite ? graphic.width : graphic.pixelSize, time) ??
        (sprite ? 24 : 5);
    const image = sprite ? read(graphic.image, time) : null;
    const outline = rgba(
      read(graphic.outlineColor, time) ?? {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 1,
      },
    );
    const outlineWidth = read(graphic.outlineWidth, time) ?? 0;
    const key = [
      sprite ? 'sprite' : 'point',
      size,
      outlineWidth,
      ...outline,
      image ?? '',
    ].join(':');
    let bank = banks.get(key);
    if (!bank) {
      const id = ++sequence;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `launches-${id}-${generation}`,
          kind: sprite ? 'sprite' : 'point',
          capacity,
          pickable: true,
          depthTest: 'always',
          ...(sprite
            ? {
                sprite: {
                  sizePx: size,
                  atlas: {
                    ...(typeof image === 'string'
                      ? { url: image }
                      : { canvas: image }),
                    cells: { reticle: [0, 0, 1, 1] },
                  },
                },
              }
            : {
                point: {
                  sizePx: size,
                  outlinePx: outlineWidth,
                  outlineColor: outline,
                },
              }),
        }),
        write: (point, set, index) =>
          set.set(index, {
            position: point.position,
            color: point.color,
            show: point.show,
            pickId: point.record.entity.id,
            ...(sprite ? { cell: 'reticle' } : {}),
          }),
        onCommit: touch,
      });
      banks.set(key, bank);
      bank.setVisible(bankVisibility);
    }
    return bank;
  };
  const syncPoint = (point, graphic, record) => {
    const time = engine.clock.now();
    if (
      !record.source.show ||
      !record.entity.show ||
      read(graphic.show, time) === false
    ) {
      if (point.show) {
        point.show = false;
        fields.position = point.position;
        fields.color = point.color;
        fields.show = false;
        point.gevBank.update(point, fields);
      }
      return;
    }
    const p = read(record.entity.position, time),
      c = read(graphic.color, time);
    const shown = Boolean(p);
    const red = c?.red ?? 1,
      green = c?.green ?? 1,
      blue = c?.blue ?? 1,
      alpha = c?.alpha ?? 1;
    if (
      p &&
      (point.position.x !== p.x ||
        point.position.y !== p.y ||
        point.position.z !== p.z ||
        point.show !== shown ||
        red !== point.color[0] ||
        green !== point.color[1] ||
        blue !== point.color[2] ||
        alpha !== point.color[3])
    ) {
      geo.cartesian3.clone(p, point.position);
      point.color[0] = red;
      point.color[1] = green;
      point.color[2] = blue;
      point.color[3] = alpha;
      point.show = shown;
      fields.position = point.position;
      fields.color = point.color;
      fields.show = shown;
      point.gevBank.update(point, fields);
    } else if (point.show !== shown) {
      point.show = shown;
      fields.position = point.position;
      fields.color = point.color;
      fields.show = shown;
      point.gevBank.update(point, fields);
    }
  };
  const syncEntity = (record) => {
    for (const point of record.points) syncPoint(point, point.graphic, record);
    if (record.line) {
      const show = Boolean(
        record.source.show &&
        record.entity.show &&
        read(record.entity.polyline.show, engine.clock.now()) !== false,
      );
      if (show !== record.lineVisible) {
        record.lineVisible = show;
        record.line.show(show);
      }
    }
  };
  const sync = () => {
    let visible = false;
    for (const source of sources)
      if (source.show) {
        visible = true;
        break;
      }
    if (visible !== bankVisibility) {
      bankVisibility = visible;
      for (const bank of banks.values()) bank.setVisible(visible);
    }
    for (const source of sources)
      for (const record of source.records.values()) syncEntity(record);
  };
  const frame = (run) => {
    inFrame = true;
    try {
      return run();
    } finally {
      sync();
      inFrame = false;
      flush();
    }
  };
  const adapter = createEngineLayerView(engine, {
    layerId: 'rocket-launches',
    wrap: frame,
    isDestroyed: () => destroyed,
  });
  const view = adapter.view;
  view.container = engine.host.container;
  view.scene.canvas = engine.host.canvas;
  view.scene.preUpdate = engine.frames.preUpdate;
  view.scene.preRender = engine.frames.preRender;
  view.scene.postRender = engine.frames.postRender;
  view.scene.requestRender = () => engine.render.request('rocket-launches');
  Object.defineProperty(view, 'trackedEntity', {
    get: () => engine.camera.following(),
    set: (value) => {
      if (!value) engine.camera.following()?.stop();
    },
  });
  view.camera.cancelFlight = () => engine.camera.cancelFlight();
  view.camera.lookAt = (target, offset) => engine.camera.lookAt(target, offset);
  view.camera.lookAtTransform = (matrix, offset) =>
    engine.camera.lookAtTransform(matrix, offset);
  view.camera.setView = (options) => engine.camera.setView(options);
  view.camera.flyTo = ({ easingFunction, ...options }) =>
    engine.camera.flyTo({ ...options, easing: 'cubicInOut' });
  view.camera.flyToBoundingSphere = (
    sphere,
    { offset, easingFunction, ...options } = {},
  ) =>
    engine.camera.flyToSphere(sphere, {
      ...options,
      ...offset,
      easing: 'cubicInOut',
    });
  const unregister = registerViewerEngine(view, engine);
  const clearSource = (source) => {
    for (const record of source.records.values()) {
      for (const point of record.points) point.gevBank?.remove(point);
      record.line?.destroy();
    }
    source.records.clear();
    source.entitiesArray.length = 0;
  };
  const addEntity = (source, spec) => {
    const record = {
      source,
      entity: null,
      points: [],
      line: null,
      lineVisible: null,
    };
    let shown = spec.show !== false;
    const entity = {
      ...spec,
      position: spec.position ? property(spec.position) : undefined,
    };
    record.entity = entity;
    Object.defineProperty(entity, 'show', {
      get: () => shown,
      set: (value) => {
        shown = Boolean(value);
        syncEntity(record);
      },
    });
    for (const name of ['point', 'billboard', 'polyline'])
      if (spec[name]) {
        const values = Object.fromEntries(
          Object.entries(spec[name]).map(([k, v]) => [k, property(v)]),
        );
        entity[name] = new Proxy(values, {
          set: (target, key, value) => {
            target[key] = property(value);
            syncEntity(record);
            return true;
          },
        });
      }
    source.records.set(entity.id, record);
    source.entitiesArray.push(entity);
    for (const name of ['point', 'billboard'])
      if (entity[name]) {
        const graphic = entity[name],
          p = read(entity.position, engine.clock.now());
        const point = {
          record,
          graphic,
          position: geo.cartesian3.clone(p ?? geo.cartesian3.ZERO),
          color: new Float64Array(
            rgba(read(graphic.color, engine.clock.now())),
          ),
          show: false,
          gevBank: null,
          gevIndex: -1,
        };
        record.points.push(point);
        pointBank(record, graphic, name === 'billboard').add(point);
      }
    if (spec.polyline) {
      const material = read(entity.polyline.material, engine.clock.now());
      const color = material?.kind ? material.color : material;
      const dash =
        material?.kind === 'tactical'
          ? 'tactical'
          : material?.kind === 'dash'
            ? {
                lengthPx:
                  material.dashLength /
                  (material.dashPattern === 0xaaaa ? 16 : 4),
                gapPx:
                  material.dashLength /
                  (material.dashPattern === 0xaaaa ? 16 : 4),
              }
            : null;
      record.line = engine.lines.createLine({
        id: `launch-entity-${++sequence}`,
        pickId: entity.id,
        widthPx: read(entity.polyline.width, engine.clock.now()) ?? 2,
        color: rgba(color),
        dash,
        arc: 'none',
      });
      record.line.setPositions(
        read(entity.polyline.positions, engine.clock.now()),
      );
    }
    syncEntity(record);
    return entity;
  };
  const createDataSource = () => {
    let visible = false;
    const source = {
      records: new Map(),
      entitiesArray: [],
      get show() {
        return visible;
      },
      set show(value) {
        visible = Boolean(value);
        sync();
      },
      entities: {},
    };
    Object.defineProperty(source.entities, 'values', {
      get: () => source.entitiesArray,
    });
    source.entities.getById = (id) => source.records.get(id)?.entity;
    source.entities.removeAll = () => clearSource(source);
    sources.add(source);
    return source;
  };
  const createPad = (launch) => {
    // Classified onto the surface under the pad as Cesium's GroundPrimitive
    // (render/navaraPadGround.js); nothing is drawn at a height.
    const ground =
      nativeView?.registerEffect && EffectDesc && NavaraEffect
        ? createPadGround(nativeView, { EffectDesc, NavaraEffect }, launch)
        : null;
    let dead = false,
      shown = true;
    engine.render.request('launch-pad');
    const pad = {
      /** Classified, as on Cesium: the zone has no height of its own. */
      heightM: null,
      get show() {
        return shown;
      },
      set show(value) {
        if (shown === Boolean(value)) return;
        shown = Boolean(value);
        if (ground) ground.visible = shown;
        engine.render.request('launch-pad');
      },
      destroy() {
        if (dead) return;
        dead = true;
        ground?.destroy();
        primitives.delete(pad);
        engine.render.request('launch-pad');
      },
    };
    primitives.add(pad);
    return pad;
  };
  const listenClick = (source, listener, { enabled = () => true } = {}) => {
    const remove = selectionDispatcherFor(engine).register('rocket-launches', {
      owns: (id) => source.records.has(id),
      onClick: (event) => {
        if (!enabled()) return;
        const entity = [event.picked, ...event.drilled]
          .map((p) => source.entities.getById(p?.id))
          .find(Boolean);
        listener(entity);
      },
    });
    return { destroy: remove };
  };
  return {
    kind: 'navara',
    engine,
    view,
    time: (epoch) => epoch,
    occluder: () => ({
      cameraPosition: null,
      isPointVisible: (p) => engine.projector.horizonVisible(p),
    }),
    callback: (fn) => ({ getValue: fn }),
    range: (heading, pitch, range) => ({ heading, pitch, range }),
    easing: undefined,
    createDataSource,
    addEntity,
    removeDataSource(source) {
      clearSource(source);
      sources.delete(source);
      sync();
    },
    dash: (options) => ({ kind: 'dash', ...options }),
    patternMaterial: (color) => ({ kind: 'tactical', color }),
    createOrbit({ positions, width, color }) {
      const line = engine.lines.createLine({
        id: `launch-orbit-${++sequence}`,
        widthPx: width,
        color: rgba(color),
        dash: 'tactical',
        arc: 'none',
      });
      line.setPositions(positions);
      let visible = true;
      const primitive = {
        modelMatrix: geo.matrix4.clone(geo.matrix4.IDENTITY),
        get show() {
          return visible;
        },
        set show(value) {
          if (visible === Boolean(value)) return;
          visible = Boolean(value);
          line.show(visible);
        },
        destroy() {
          line.destroy();
          primitives.delete(primitive);
        },
        line,
      };
      primitives.add(primitive);
      return primitive;
    },
    commitOrbit: (primitive) =>
      primitive.line.setModelMatrix(primitive.modelMatrix),
    createPad,
    removePrimitive: (primitive) => primitive.destroy(),
    project: (p, r) => engine.projector.worldToWindow(p, r),
    on: (event, listener) => view.on(event, listener),
    listenClick,
    listenMove: (source, listener, { enabled = () => true } = {}) => ({
      destroy: engine.input.on('move', (event) => {
        if (enabled())
          listener(
            engine.picker
              .drillPick(event.endPosition, 12)
              .map((p) => source.entities.getById(p.id))
              .find(Boolean),
          );
      }),
    }),
    destroy() {
      destroyed = true;
      for (const source of sources) clearSource(source);
      sources.clear();
      for (const primitive of [...primitives]) primitive.destroy();
      for (const bank of banks.values()) bank.destroy();
      banks.clear();
      dirty.clear();
      unregister();
      adapter.destroy();
    },
  };
}
