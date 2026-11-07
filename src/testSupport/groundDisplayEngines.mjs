// Ground displays under test, on the fake engine and on the Cesium engine.
// Both harnesses record what each ground set was given (the items of its
// last commit, its commits) and count the live input listeners. The Cesium
// one is the engine over a real Cesium camera on a stub scene
// (cesiumMoversEngine.mjs) with fake GroundPrimitive and
// GroundPolylinePrimitive factories: the engine's own geometry instances,
// colours and options reach them, and they draw nothing. A click goes
// through the engine's input with a pick of a ground item (`{ set,
// instance }`), of another object (`{ id }`) or of nothing (undefined).

import * as Cesium from 'cesium';
import { normalizeGroundSetOptions } from '../globe/ground.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createFakeEventHandlers } from '../globe/cesium/testing/fakeViewer.mjs';
import { createCesiumMoversEngine } from './cesiumMoversEngine.mjs';

const CLICK_AT = { x: 100, y: 100 };

// What the engine's ground sets were given, and its live input listeners.
function watch(engine) {
  const sets = new Map();
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const record = {
      // With the engine's defaults.
      options: normalizeGroundSetOptions(options),
      pending: [],
      items: [],
      commits: 0,
    };
    const { replace, commit } = set;
    set.replace = (items) => {
      replace(items);
      record.pending = items;
    };
    set.commit = () => {
      commit();
      record.items = record.pending;
      record.commits++;
    };
    sets.set(options.id, record);
    return set;
  };
  let listeners = 0;
  const on = engine.input.on.bind(engine.input);
  engine.input.on = (type, listener, options) => {
    const remove = on(type, listener, options);
    let live = true;
    listeners++;
    return () => {
      if (live) listeners--;
      live = false;
      remove();
    };
  };
  return {
    /** A live set: its options, committed items, commits and visibility. */
    set(id) {
      const listed = engine.ground.list().find((entry) => entry.id === id);
      const record = sets.get(id);
      return listed && record ? { ...record, shown: listed.shown } : undefined;
    },
    /** How many ground sets are live. */
    sets: () => engine.ground.list().length,
    listeners: () => listeners,
  };
}

/** The fake engine, with picks scripted per click. */
export function createFakeGroundHarness(options = {}) {
  const engine = createFakeEngine(options);
  const watched = watch(engine);
  return {
    name: 'the fake engine',
    cesium: false,
    engine,
    ...watched,
    click(target, position = CLICK_AT) {
      let picked = target;
      if (target?.set !== undefined) {
        const item = watched.set(target.set)?.items[target.instance];
        picked = {
          id: item?.pickId,
          owner: target.set,
          instance: target.instance,
        };
      }
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position });
      engine.fake.unscript('pick');
    },
    destroy: () => engine.destroy(),
  };
}

/**
 * The Cesium engine over a stub scene, with fake ground primitives; with
 * `realFills`, Cesium's own GroundPrimitive draws the fills (it builds in
 * Node; GroundPolylinePrimitive does not).
 */
export function createCesiumGroundHarness({
  realFills = false,
  engineOptions = {},
} = {}) {
  const handlers = createFakeEventHandlers();
  const primitive = (type) => (options) => {
    const value = {
      type,
      options,
      ready: false,
      show: true,
      destroyed: false,
      destroy() {
        value.destroyed = true;
      },
      isDestroyed: () => value.destroyed,
    };
    return value;
  };
  const { engine, viewer } = createCesiumMoversEngine({
    engineOptions: {
      ...engineOptions,
      createEventHandler: handlers.create,
      scheduleFrame: (run) => run(),
      groundFactories: {
        ...(realFills ? {} : { fills: primitive('fills') }),
        lines: primitive('lines'),
      },
    },
  });
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  let native;
  viewer.scene.pick = () => native;
  viewer.scene.drillPick = () => (native ? [native] : []);
  const children = (collection) =>
    Array.from({ length: collection?.length ?? 0 }, (_, index) =>
      collection.get(index),
    );
  // The engine's collection of sets, each set's collection of primitives.
  const slots = () => children(viewer.scene.groundPrimitives.get(0));
  const slotOf = (id) =>
    slots().find((slot) =>
      children(slot).some((value) => value.gevGroundSet === id),
    );
  const live = (id) => children(slotOf(id));
  const typeOf = (value) =>
    value.type ?? (value instanceof Cesium.GroundPrimitive ? 'fills' : 'lines');
  return {
    name: 'the Cesium engine',
    cesium: true,
    engine,
    viewer,
    ...watch(engine),
    /** The live Cesium primitives of a set: fills and outlines. */
    primitives: (id) => ({
      fills: live(id).filter((value) => typeOf(value) === 'fills'),
      lines: live(id).filter((value) => typeOf(value) === 'lines'),
    }),
    /** Whether the set's Cesium collection is shown (undefined: none). */
    collectionShown: (id) => slotOf(id)?.show,
    click(target, position = CLICK_AT) {
      native = undefined;
      if (target?.set !== undefined) {
        const [first] = live(target.set);
        native = {
          id: { gevGroundSet: target.set, instance: target.instance },
          primitive: first,
        };
      } else if (target) native = { id: target.id, primitive: {} };
      for (const handler of handlers.handlers)
        handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
          position: new Cesium.Cartesian2(position.x, position.y),
        });
      native = undefined;
    },
    destroy: () => engine.destroy(),
  };
}

export const GROUND_HARNESSES = [
  createFakeGroundHarness,
  createCesiumGroundHarness,
];

/** A Cesium colour attribute's value as rgba in 0..1. */
export const instanceColor = (instance) =>
  Array.from(instance.attributes.color.value, (byte) => byte / 255);
