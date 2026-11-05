// Navara picks report a batchId (PickableInstancedMeshWrapper, one per
// instance); this resolves it to the mover set, the instance and the pickId
// the layer gave it. Pure: wrappers are anything with a batchIds array.

export function createPickIndex() {
  const entries = new Map();
  return {
    /** `wrapper.batchIds[i]` is instance i's batch id. */
    add(set, wrapper, pickIdOf) {
      const list = entries.get(set) ?? [];
      list.push({ wrapper, pickIdOf });
      entries.set(set, list);
    },
    remove(set) {
      entries.delete(set);
    },
    /** { set, instance, pickId } for a batch id, or null. */
    resolve(batchId) {
      for (const [set, list] of entries)
        for (const { wrapper, pickIdOf } of list) {
          const instance = wrapper.batchIds.indexOf(batchId);
          if (instance >= 0)
            return { set, instance, pickId: pickIdOf(instance) };
        }
      return null;
    },
  };
}
