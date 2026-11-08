/**
 * A draw port (`src/render/contract/draw.d.ts`) that keeps what it is
 * given, for layer tests: each set's spec, items by id, `show` and whether
 * it was disposed. `bindFakeDraw` binds it to a viewer double, as the
 * application binds its renderer, so the layer's `drawOf(viewer)` finds it.
 */
import { bindRenderer } from '../render/rendererOf.js';

export function fakeDrawPort() {
  const sets = new Map();
  const make = (kind) => (spec) => {
    const live = sets.get(spec.id);
    if (live && !live.disposed)
      throw new Error(`a set with id ${spec.id} is live`);
    const record = {
      kind,
      spec: { ...spec },
      items: new Map(),
      show: spec.show !== false,
      disposed: false,
      writes: 0,
      ready: new Set(),
      loadFailed: new Set(),
    };
    sets.set(spec.id, record);
    const write = (fn) => {
      if (record.disposed) throw new Error(`set ${spec.id} is disposed`);
      fn();
      record.writes += 1;
    };
    return {
      id: spec.id,
      set: (items) =>
        write(() => {
          record.items.clear();
          for (const item of items) record.items.set(item.id, item);
        }),
      upsert: (items) =>
        write(() => {
          for (const item of items) record.items.set(item.id, item);
        }),
      remove: (ids) =>
        write(() => {
          for (const id of ids) record.items.delete(id);
        }),
      clear: () => write(() => record.items.clear()),
      setOptions(options) {
        Object.assign(record.spec, options);
        if ('show' in options) record.show = options.show !== false;
      },
      size: () => record.items.size,
      get show() {
        return record.show;
      },
      set show(value) {
        record.show = value;
      },
      on(event, cb) {
        const listeners = {
          ready: record.ready,
          loadFailed: record.loadFailed,
        }[event];
        if (!listeners) return () => {};
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      dispose() {
        record.disposed = true;
      },
    };
  };
  return {
    sets,
    /** The live set with this id, or undefined. */
    set: (id) => (sets.get(id)?.disposed ? undefined : sets.get(id)),
    /** The live set whose id starts with `prefix`, or undefined. */
    find: (prefix) =>
      [...sets.values()].find(
        (record) => !record.disposed && record.spec.id.startsWith(prefix),
      ),
    icons: make('icons'),
    points: make('points'),
    lines: make('lines'),
    shapes: make('shapes'),
    models: make('models'),
    /** Fire a models set's `ready` for an item, as a load finishing does. */
    ready(setId, id) {
      for (const cb of [...(sets.get(setId)?.ready ?? [])]) cb(id);
    },
    /** Fire a models set's `loadFailed` for an item, as a failed load does. */
    loadFailed(setId, id, message = 'the model did not load') {
      for (const cb of [...(sets.get(setId)?.loadFailed ?? [])])
        cb(id, message);
    },
    clampState: () => 'draped',
    on: () => () => {},
    atlas() {},
  };
}

/**
 * Bind a fake draw port to `viewer`; `renderer` adds other ports.
 * @returns {{draw: ReturnType<typeof fakeDrawPort>, unbind: () => void}}
 */
export function bindFakeDraw(viewer, renderer = {}) {
  const draw = fakeDrawPort();
  const unbind = bindRenderer(viewer, {
    // The double's canvas, as `bindFakeCesiumCamera`'s renderer reports it.
    get canvas() {
      return viewer.canvas ?? viewer.scene?.canvas;
    },
    ...renderer,
    draw,
  });
  return { draw, unbind };
}
