/**
 * @module render/motion/iconBook
 * @description The icons a layer draws, as it last drew them: each icon item
 * by its id, until when its motion holds, and the renderer draw set they go
 * to. A layer reads its own icons back from here (where a moving one is now
 * and its course, its focus, whether a pick is its own), never from the
 * renderer, and replans the ones whose motion ran out.
 *
 * Positions and courses come from the shared evaluator (`iconMotion.js`), on
 * the set's motion clock: pass the same epoch ms the set draws at (wall time
 * less its `delayMs` for a live clock, the frame port's time for a scene
 * clock). An item's `courseBlendMs` is not modelled: an item easing its
 * course by it reads its target course (give it a `courseGlide` to read the
 * eased one).
 */
import { iconCourse, iconPosition } from './iconMotion.js';

/**
 * @param {import('../contract/draw').DrawSet<object>|null} [drawSet] Where
 *   the icons are drawn; none keeps them only here (tests).
 * @param {{capabilities?: ReadonlySet<string>|null}} [options] The
 *   renderer's capabilities (`Renderer.capabilities`); without
 *   `motionSegments` or `courseGlide` an icon is read where, and with the
 *   course, it is drawn. None given reads both as drawn.
 */
export function createIconBook(drawSet = null, { capabilities = null } = {}) {
  const motionSegments = capabilities?.has('motionSegments') ?? true;
  const courseGlide = capabilities?.has('courseGlide') ?? true;
  const items = new Map();
  // Until when (epoch ms) each item's motion holds, for those given one.
  const expiries = new Map();

  /** An item as the renderer draws it. */
  function asDrawn(item) {
    if (motionSegments && courseGlide) return item;
    const { motion, courseGlide: glide, ...rest } = item;
    return {
      ...rest,
      ...(motionSegments ? { motion } : null),
      ...(courseGlide ? { courseGlide: glide } : null),
    };
  }

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
    /** The drawn ids, in the order first drawn. */
    ids: () => [...items.keys()],
    /** Whether an id is drawn. */
    has: (id) => items.has(id),
    /** The item drawn under an id, or undefined. */
    item: (id) => items.get(id),
    /**
     * Draw an item (anew, or as it now is). `expiresAt` (epoch ms on the
     * motion clock) is when its motion stops being what the layer would
     * plan, for `due` (`Infinity`: planned, never due); `null` drops it, and
     * omitted (a restyle) keeps what the item had.
     */
    put(item, { expiresAt } = {}) {
      if (
        expiresAt !== undefined &&
        expiresAt !== null &&
        (typeof expiresAt !== 'number' || Number.isNaN(expiresAt))
      )
        throw new TypeError(`expiresAt must be epoch ms, not ${expiresAt}`);
      items.set(item.id, item);
      if (expiresAt === null) expiries.delete(item.id);
      else if (expiresAt !== undefined) expiries.set(item.id, expiresAt);
      drawSet?.upsert([item]);
    },
    remove(id) {
      expiries.delete(id);
      if (items.delete(id)) drawSet?.remove([id]);
    },
    /**
     * When an id's motion runs out (epoch ms; `Infinity`: never), or
     * undefined while it was never given one (not planned).
     */
    expiresAt: (id) => expiries.get(id),
    /** The ids whose motion ran out by `t` (epoch ms), to plan afresh. */
    due(t) {
      const ids = [];
      for (const [id, at] of expiries) if (at <= t) ids.push(id);
      return ids;
    },
    /** Where an id's icon is drawn at `t` (epoch ms), ECEF, or null. */
    position(id, t) {
      const item = items.get(id);
      return item?.pos ? iconPosition(asDrawn(item), t) : null;
    },
    /** The course an id's icon is drawn with at `t`, or null. */
    course(id, t) {
      const item = items.get(id);
      return item ? iconCourse(asDrawn(item), t) : null;
    },
    /** An icon's focus emphasis, 1 when not de-emphasised. */
    focus: (id) => items.get(id)?.focus ?? 1,
    setFocus(id, factor) {
      const item = items.get(id);
      if (item) book.put({ ...item, focus: factor });
    },
    dispose() {
      items.clear();
      expiries.clear();
      drawSet?.dispose();
    },
  };
  return book;
}
