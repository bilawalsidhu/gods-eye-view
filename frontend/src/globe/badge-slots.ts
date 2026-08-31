/**
 * One badge to a lattice point, across every layer.
 *
 * Each mover layer clusters on its own, so each computes a perfectly good badge layout and none of
 * them knows the other layers exist. Within a layer that is solved: badges are drawn on the centres
 * of a `CLUSTER_CELL_PX` lattice and the widest badge is narrower than a cell, so two of them cannot
 * touch. Across layers it made things worse rather than better, because the lattice is *shared*: two
 * layers whose members fall in the same cell draw at the identical pixel, so one badge is not partly
 * occluded but completely invisible.
 *
 * Measured on the live feeds at the opening whole-Earth view on 2026-08-24: 24 badges, zero
 * same-layer overlaps, and **8 cross-layer pairs of which all 8 were exact coincidences**, hiding
 * 8 badges of 24 outright. A viewer counted sixteen and had no way to know. That is not untidiness,
 * it breaks the promise the whole clustering exercise rests on, which is that nothing is hidden.
 *
 * **The fix is a claim on the lattice, and the lattice is what makes it cheap.** A badge asks for the
 * point it wants; if another layer already holds it, it gets the nearest free point instead. Since
 * lattice points are a cell apart and a badge is narrower than a cell, any free point is guaranteed
 * clear of every other badge, so no search over sizes or distances is needed.
 *
 * **No frame counter and no Cesium internals.** A layer releases its own claims and re-makes them in
 * the same pass, so the map always holds the current truth for every layer that has run. Layers run
 * in construction order on `preUpdate`, which is stable, so the outcome is deterministic: the first
 * layer to run keeps the point it wants and later layers move. During continuous camera motion a
 * layer is avoiding the previous frame's positions for the other layers, which settles the moment the
 * camera stops and cannot oscillate while the order holds.
 */

/** Where a badge should be drawn, in screen pixels. */
export interface BadgeSlot {
  x: number;
  y: number;
}

/**
 * Rings of lattice steps to try, nearest first, as (column, row) deltas.
 *
 * Hand-written rather than generated, because the order is a design decision and not arithmetic:
 * sideways before vertical, because a displaced badge reads better beside its data than above it,
 * and the four orthogonal neighbours before any diagonal so a badge moves the shortest distance it
 * can. Two rings is 24 alternatives, which is far more than the eight collisions a whole-Earth view
 * produces; past that the honest answer is to draw on the wanted point and collide.
 */
const RINGS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [-2, 0],
  [2, 0],
  [0, -2],
  [0, 2],
  [-2, -1],
  [2, -1],
  [-2, 1],
  [2, 1],
  [-1, -2],
  [1, -2],
  [-1, 2],
  [1, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
  [2, 2],
];

/** Shared claim map over the badge lattice. One screen, one lattice, one of these. */
class BadgeSlots {
  private pitchPx = 0;
  private columns = 0;
  private rows = 0;
  /** Lattice index to the layer holding it. */
  private readonly held = new Map<number, string>();

  /**
   * Declare the lattice. Idempotent, and clears every claim when the geometry changes.
   *
   * A resize moves every lattice point, so a claim made against the old geometry describes a place
   * that no longer exists. Cheaper and more obviously correct to drop them all than to remap.
   */
  begin(widthPx: number, heightPx: number, pitchPx: number): void {
    const columns = Math.max(1, Math.ceil(widthPx / pitchPx));
    const rows = Math.max(1, Math.ceil(heightPx / pitchPx));
    if (columns === this.columns && rows === this.rows && pitchPx === this.pitchPx) {
      return;
    }
    this.columns = columns;
    this.rows = rows;
    this.pitchPx = pitchPx;
    this.held.clear();
  }

  /**
   * Hold every lattice point a rectangle touches, so a badge is pushed off it.
   *
   * For things that are not badges and cannot move. A city label is the case this exists for: it sits
   * on a fixed geographic point and reading it is the whole of its job, where a badge is a count over
   * an area that has never claimed to mark a position and has always been free to shift. So when the
   * two want the same pixels the badge yields, and the way to make that happen is for the label to
   * take the points first.
   *
   * A rectangle rather than a point because a label is wide: "Moscow" at 13 pixels runs to about 55,
   * which is a whole lattice cell and part of the next. Reserving only the centre would leave a badge
   * sitting on the second half of the word.
   *
   * Returns how many points it took, which is what a test can assert and what tells a caller whether
   * a wide label actually needed more than one.
   */
  reserve(
    layerKey: string,
    centreX: number,
    centreY: number,
    widthPx: number,
    heightPx: number,
  ): number {
    if (this.pitchPx <= 0) {
      return 0;
    }
    const firstColumn = Math.floor((centreX - widthPx / 2) / this.pitchPx);
    const lastColumn = Math.floor((centreX + widthPx / 2) / this.pitchPx);
    const firstRow = Math.floor((centreY - heightPx / 2) / this.pitchPx);
    const lastRow = Math.floor((centreY + heightPx / 2) / this.pitchPx);
    let taken = 0;
    for (let c = Math.max(0, firstColumn); c <= Math.min(this.columns - 1, lastColumn); c += 1) {
      for (let r = Math.max(0, firstRow); r <= Math.min(this.rows - 1, lastRow); r += 1) {
        const index = r * this.columns + c;
        // First holder wins, so a reservation never steals a point another layer is already drawing
        // on. Two labels overlapping is the city layer's own problem and it declutters them itself.
        if (!this.held.has(index)) {
          this.held.set(index, layerKey);
          taken += 1;
        }
      }
    }
    return taken;
  }

  /** Drop everything one layer holds, before it makes its claims again or when it goes dark. */
  release(layerKey: string): void {
    for (const [index, holder] of this.held) {
      if (holder === layerKey) {
        this.held.delete(index);
      }
    }
  }

  /**
   * Take the wanted point if it is free, otherwise the nearest free one.
   *
   * Returns the wanted point when every alternative is taken. A badge drawn on top of another is bad;
   * a badge not drawn at all, or flung across the map away from what it counts, is worse. Every
   * answer is a lattice point, that one included, except when no geometry has been declared.
   */
  claim(layerKey: string, x: number, y: number, out: BadgeSlot): BadgeSlot {
    out.x = x;
    out.y = y;
    if (this.pitchPx <= 0) {
      return out;
    }
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor(x / this.pitchPx)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.pitchPx)));
    // The wanted cell's centre, so every answer from here on is a lattice point including the
    // give-up one. Callers work out an offset by subtracting the point they asked for, and a mixture
    // of snapped and unsnapped answers would make that offset a fraction of a cell on one path only.
    out.x = (column + 0.5) * this.pitchPx;
    out.y = (row + 0.5) * this.pitchPx;
    for (const [dc, dr] of RINGS) {
      const c = column + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= this.columns || r >= this.rows) {
        continue;
      }
      const index = r * this.columns + c;
      if (this.held.has(index)) {
        continue;
      }
      this.held.set(index, layerKey);
      out.x = (c + 0.5) * this.pitchPx;
      out.y = (r + 0.5) * this.pitchPx;
      return out;
    }
    return out;
  }

  /** How many points are held. Read by the layer tests, which assert a dark layer frees its own. */
  get claimed(): number {
    return this.held.size;
  }

  /** Drop every claim. For tests, so one does not leak into the next. */
  reset(): void {
    this.held.clear();
    this.columns = 0;
    this.rows = 0;
    this.pitchPx = 0;
  }
}

/**
 * The shared instance.
 *
 * Module state, which is normally worth avoiding, and here it is the honest shape of the problem:
 * there is one screen and one lattice on it, and the layers have to agree about it. Nothing
 * accumulates, because every layer releases its own claims each pass.
 */
export const badgeSlots = new BadgeSlots();
