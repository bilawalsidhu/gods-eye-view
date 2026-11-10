// A growing bank of engine.movers sprites, points or models that layer
// renderers share (on any engine, through the contract): handles hold their
// index into one mover set, which is rebuilt at double the capacity when it
// fills.

const FIRST_CAPACITY = 1024;

// Reused set() arguments (set() copies them; no object per write).
const fieldsNoPick = {
  position: undefined,
  orientation: undefined,
  color: undefined,
  rotation: undefined,
  scale: undefined,
  cell: undefined,
  show: undefined,
};
/** Writes `fields` of the mover at `index` (set() copies them). */
export function writeFields(set, index, fields) {
  const scratch = fieldsNoPick;
  for (const key in fields) scratch[key] = fields[key];
  set.set(index, scratch);
  for (const key in fields) scratch[key] = undefined;
}

/**
 * A growing bank of one kind of mover: handles hold an index; removal moves
 * the last handle into the hole. `options(capacity, generation)` gives the
 * createSet options; `write(handle, set, index)` writes a handle whole.
 */
export function createMoverBank(engine, { options, write, onCommit }) {
  const handles = [];
  let set = null;
  let generation = 0;
  let capacity = 0;
  let visible = true;
  let dirty = false;
  const build = (wanted) => {
    const next = engine.movers.createSet(options(wanted, ++generation));
    set?.destroy();
    set = next;
    capacity = wanted;
    handles.forEach((handle, index) => write(handle, set, index));
    set.setCount(visible ? handles.length : 0);
  };
  const bank = {
    handles,
    get set() {
      return set;
    },
    ready: () => Boolean(set?.ready()),
    add(handle) {
      if (handle.gevBank === bank) return;
      handle.gevBank?.remove(handle);
      handle.gevBank = bank;
      handle.gevIndex = handles.length;
      handles.push(handle);
      if (!set || handles.length > capacity)
        build(
          Math.max(
            FIRST_CAPACITY,
            handles.length > capacity ? capacity * 2 : capacity,
            handles.length,
          ),
        );
      else {
        write(handle, set, handle.gevIndex);
        if (visible) set.setCount(handles.length);
      }
      bank.touch();
    },
    remove(handle) {
      if (handle.gevBank !== bank) return;
      const index = handle.gevIndex;
      const last = handles.pop();
      if (last !== handle) {
        handles[index] = last;
        last.gevIndex = index;
        write(last, set, index);
      }
      handle.gevBank = null;
      handle.gevIndex = -1;
      set?.setCount(visible ? handles.length : 0);
      bank.touch();
    },
    /** Writes `fields` of one handle (when it is in this bank). */
    update(handle, fields) {
      if (handle.gevBank !== bank || !set) return;
      writeFields(set, handle.gevIndex, fields);
      bank.touch();
    },
    setVisible(next) {
      visible = next;
      set?.setCount(visible ? handles.length : 0);
      bank.touch();
    },
    visible: () => visible,
    touch() {
      if (!dirty) {
        dirty = true;
        onCommit(bank);
      }
    },
    commit() {
      if (!dirty) return;
      dirty = false;
      set?.commit();
    },
    destroy() {
      for (const handle of handles) {
        handle.gevBank = null;
        handle.gevIndex = -1;
      }
      handles.length = 0;
      set?.destroy();
      set = null;
    },
  };
  return bank;
}
