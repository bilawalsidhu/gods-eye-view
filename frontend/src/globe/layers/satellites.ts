/**
 * The satellite layer.
 *
 * One `PointPrimitiveCollection` and one `PolylineCollection`, both built once and mutated
 * in place, exactly as `layers/aircraft.ts` does and for the same reason: the Entity API
 * collapses in the low thousands of movers and the target here is the whole active
 * catalogue, 10,000-plus objects. Retired satellites hand their primitives back to a free
 * pool, so a pass in and out of the element cache does not force Cesium to rebuild its
 * vertex buffers.
 *
 * Positions arrive already propagated, as flat typed arrays off the worker. Nothing in this
 * file does any orbital maths, and nothing in it holds a `Date`.
 *
 * The polyline collection holds exactly one polyline, ever: the orbit trail of the current
 * selection. A trail per satellite would cost more than every point on the globe put
 * together and would draw a ball of wool.
 */

import {
  BlendOption,
  Cartesian3,
  Color,
  Material,
  PointPrimitiveCollection,
  PolylineCollection,
} from 'cesium';
import type { PointPrimitive, Polyline, Scene } from 'cesium';

import { SELECTION_COLOUR } from '../palette';

/**
 * One hue for the whole layer.
 *
 * Pale cyan: distinct from the aircraft class hues, and nowhere near the red and orange the
 * palette reserves for alert states. There is no per-satellite classification in phase 2, so
 * a second colour here would encode nothing.
 */
export const SATELLITE_COLOUR = '#7fe3ff';

export const SATELLITE_PIXEL_SIZE = 4;
export const SATELLITE_SELECTED_PIXEL_SIZE = 9;

/** The trail is the same hue, thin, so the point stays the thing being read. */
export const ORBIT_TRAIL_WIDTH = 1.5;

/**
 * Prefix on the id stamped onto every satellite primitive.
 *
 * Picking returns whatever `id` the primitive carries and the aircraft layer stamps a bare
 * six-hex ICAO address, so a bare catalogue number could be read as an aircraft. The prefix
 * is what keeps one click routing to one layer.
 */
export const SATELLITE_PICK_PREFIX = 'satellite:';

/** The catalogue number in a picked id, or null when the pick was not a satellite. */
export function noradFromPickId(id: string | null): number | null {
  if (!id?.startsWith(SATELLITE_PICK_PREFIX)) {
    return null;
  }
  const parsed = Number(id.slice(SATELLITE_PICK_PREFIX.length));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

interface Slot {
  point: PointPrimitive;
  /**
   * The tick this slot was last written by.
   *
   * A generation counter rather than a `Set` of the ids present, because unlike the aircraft
   * feed every tick here is a full replacement and building a set of a thousand numbers per
   * frame is an allocation the frame does not need.
   */
  seen: number;
}

const scratch = new Cartesian3();

export class SatelliteLayer {
  private readonly points: PointPrimitiveCollection;
  private readonly trails: PolylineCollection;
  private readonly trail: Polyline;
  private readonly slots = new Map<number, Slot>();
  private readonly free: PointPrimitive[] = [];
  /**
   * The two Cesium colours this layer uses, parsed once.
   *
   * Fields rather than module constants, because parsing a CSS colour at module load is a
   * side effect in an imported module; and once rather than per point, because the first
   * load of the active catalogue would otherwise pay ten thousand parses.
   */
  private readonly baseColour: Color;
  private readonly ringColour: Color;
  private selectedId: number | null = null;
  private generation = 0;

  constructor(scene: Scene) {
    this.baseColour = Color.fromCssColorString(SATELLITE_COLOUR);
    this.ringColour = Color.fromCssColorString(SELECTION_COLOUR);
    this.points = new PointPrimitiveCollection({
      // Nothing in this layer is translucent, so Cesium can skip the translucent pass.
      blendOption: BlendOption.OPAQUE,
    });
    this.trails = new PolylineCollection();
    this.trail = this.trails.add({
      // Two positions because a polyline needs at least two; it is hidden until a selection
      // supplies a real orbit, and it is never removed and re-added.
      positions: [Cartesian3.ZERO, Cartesian3.ZERO],
      width: ORBIT_TRAIL_WIDTH,
      material: Material.fromType('Color', { color: this.baseColour.withAlpha(0.55) }),
      show: false,
    });
    scene.primitives.add(this.points);
    scene.primitives.add(this.trails);
  }

  /** How many satellites are on the globe. Drops are already absent from `ids`. */
  get count(): number {
    return this.slots.size;
  }

  /**
   * Draw one tick.
   *
   * `ids` and `lonLatAlt` are the worker's own arrays: catalogue numbers, and
   * `[lon, lat, altitudeMetres]` triples in the same order. Anything absent from `ids` was
   * refused by SGP4 or is propagating from elements too old to trust, and it comes off the
   * globe rather than being left where it last was.
   */
  apply(ids: Int32Array, lonLatAlt: Float64Array): void {
    this.generation += 1;
    // An indexed loop, not for-of: `ids.entries()` allocates an iterator result and a pair
    // array per satellite per frame, which is the one thing this loop is written to avoid.
    // `noUncheckedIndexedAccess` is why each read carries a fallback.
    // eslint-disable-next-line unicorn/no-for-loop
    for (let index = 0; index < ids.length; index += 1) {
      const noradCatId = ids[index] ?? 0;
      const slot = this.slots.get(noradCatId) ?? this.acquire(noradCatId);
      slot.seen = this.generation;
      Cartesian3.fromDegrees(
        lonLatAlt[index * 3] ?? 0,
        lonLatAlt[index * 3 + 1] ?? 0,
        lonLatAlt[index * 3 + 2] ?? 0,
        undefined,
        scratch,
      );
      // The setter clones, so one scratch vector serves the whole tick.
      slot.point.position = scratch;
    }
    for (const [noradCatId, slot] of this.slots) {
      if (slot.seen !== this.generation) {
        this.release(noradCatId, slot);
      }
    }
  }

  /** Switch the whole layer off from the rail. Collection-level, so it costs one flag. */
  setVisible(visible: boolean): void {
    this.points.show = visible;
    this.trails.show = visible;
  }

  /** Highlight one satellite, or none. Selection is an outline and a size, never a new hue. */
  setSelected(noradCatId: number | null): void {
    if (this.selectedId === noradCatId) {
      return;
    }
    const previous = this.selectedId;
    this.selectedId = noradCatId;
    for (const changed of [previous, noradCatId]) {
      if (changed === null) {
        continue;
      }
      const slot = this.slots.get(changed);
      if (slot !== undefined) {
        this.emphasise(slot.point, changed === this.selectedId);
      }
    }
  }

  /**
   * Set the orbit trail, or clear it.
   *
   * `lonLatAlt` is one revolution of `[lon, lat, altitudeMetres]` triples centred on the
   * instant it was computed for. A trail for anything other than the current selection is
   * ignored rather than drawn: the reply may have crossed a click.
   */
  setOrbit(noradCatId: number | null, lonLatAlt: Float64Array | null): void {
    if (noradCatId === null || lonLatAlt === null || noradCatId !== this.selectedId) {
      this.trail.show = false;
      return;
    }
    const positions: Cartesian3[] = [];
    for (let index = 0; index * 3 + 2 < lonLatAlt.length; index += 1) {
      positions.push(
        Cartesian3.fromDegrees(
          lonLatAlt[index * 3] ?? 0,
          lonLatAlt[index * 3 + 1] ?? 0,
          lonLatAlt[index * 3 + 2] ?? 0,
        ),
      );
    }
    // Reassigned rather than the polyline being removed and re-added: one polyline exists
    // for the lifetime of the layer. Fresh Cartesian3 objects because Cesium keeps this
    // array, unlike the point setter which clones.
    this.trail.positions = positions;
    this.trail.show = positions.length > 1;
  }

  private acquire(noradCatId: number): Slot {
    const point = this.free.pop() ?? this.points.add({ position: Cartesian3.ZERO });
    point.show = true;
    point.id = `${SATELLITE_PICK_PREFIX}${noradCatId}`;
    point.color = this.baseColour;
    this.emphasise(point, noradCatId === this.selectedId);
    const slot: Slot = { point, seen: this.generation };
    this.slots.set(noradCatId, slot);
    return slot;
  }

  private release(noradCatId: number, slot: Slot): void {
    slot.point.show = false;
    slot.point.id = undefined;
    this.free.push(slot.point);
    this.slots.delete(noradCatId);
    if (this.selectedId === noradCatId) {
      this.selectedId = null;
      this.trail.show = false;
    }
  }

  /**
   * Size and outline for the selection ring.
   *
   * An unselected point gets a transparent outline rather than a zero-width coloured one:
   * Cesium antialiases the edge against the outline colour either way, which fringed every
   * point in the ring colour.
   */
  private emphasise(point: PointPrimitive, selected: boolean): void {
    point.pixelSize = selected ? SATELLITE_SELECTED_PIXEL_SIZE : SATELLITE_PIXEL_SIZE;
    point.outlineWidth = selected ? 2 : 0;
    point.outlineColor = selected ? this.ringColour : Color.TRANSPARENT;
  }
}
