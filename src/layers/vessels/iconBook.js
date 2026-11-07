/**
 * The vessel icons the layer draws, as it last drew them: each icon item by
 * its row id, and the renderer draw set they go to. The layer reads its own
 * icons back from here (focus emphasis, ownership of a pick), never from the
 * renderer.
 */

/**
 * @param {import('../../render/contract/draw').DrawSet<object>|null} [drawSet]
 *   Where the icons are drawn; none keeps them only here (tests).
 */
export function createVesselIconBook(drawSet = null) {
  const items = new Map();
  const book = {
    /** The draw set's id, or null. */
    setId: drawSet?.id ?? null,
    get show() {
      return drawSet ? drawSet.show : true;
    },
    set show(value) {
      if (drawSet) drawSet.show = value;
    },
    /** How many icons are drawn. */
    get size() {
      return items.size;
    },
    /** The drawn row ids, in the order first drawn. */
    ids: () => [...items.keys()],
    /** Whether a row id is drawn. */
    has: (id) => items.has(id),
    /** The item drawn under a row id, or undefined. */
    item: (id) => items.get(id),
    /** Draw an item (anew, or as it now is). */
    put(item) {
      items.set(item.id, item);
      drawSet?.upsert([item]);
    },
    remove(id) {
      if (items.delete(id)) drawSet?.remove([id]);
    },
    /** A row's focus emphasis, 1 when not de-emphasised. */
    focus: (id) => items.get(id)?.focus ?? 1,
    setFocus(id, factor) {
      const item = items.get(id);
      if (item) book.put({ ...item, focus: factor });
    },
    dispose() {
      items.clear();
      drawSet?.dispose();
    },
  };
  return book;
}
