// Ground display tests record committed items and input ownership on the fake engine.
import { normalizeGroundSetOptions } from '../globe/ground.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

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
    engine,
    frame: () => engine.fake.frame(),
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

export const GROUND_HARNESSES = [createFakeGroundHarness];
