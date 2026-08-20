/**
 * The vessel layer.
 *
 * Structurally the same as `aircraft.ts` and for the same reason: one
 * `PointPrimitiveCollection` and one `LabelCollection`, both created once and mutated in
 * place, no Cesium `Entity` anywhere, no collection rebuilt per tick, and retired vessels
 * hand their primitives back to a free pool. That is not a preference, it is the only
 * shape that survives thousands of movers.
 *
 * Three things differ from aircraft, all of them because a ship is not a plane.
 *
 * **Ports.** A berth holds hundreds of vessels inside a few hundred metres, so the display
 * problem is density rather than distance. Two decisions handle it without clustering,
 * which is phase 9 and deliberately not built here:
 *
 * - **A vessel is labelled only while it is under way**, plus the selected one whatever it
 *   is doing. A harbour is mostly moored ships and their names would stack into a solid
 *   block of text that hides the traffic actually moving through it. The labels are also
 *   the most expensive tier we draw, so the layer that most needs them thinned is the one
 *   with the most primitives in a screen. Nothing is hidden: every vessel the feed
 *   reported is still drawn as a point, and its name is one click away.
 * - **Points are smaller than aircraft points and a moored vessel is drawn dimmer than one
 *   under way.** At a port zoom a full berth then reads as texture with the movers standing
 *   out of it, rather than as one saturated blob where every ship has painted over its
 *   neighbour.
 *
 * **Speed.** Vessels are polled once a minute (the union's floor, `app.py`) and a ship at
 * 15 knots covers 460 metres in that time, so dead reckoning still earns its place. It is
 * capped, though: see `MAX_DEAD_RECKON_SECONDS`.
 *
 * **One layer.** Aircraft arrive on two layer names (`aircraft` and `military`) from two
 * separate server-side stores, so that layer has to track which feed owns each record.
 * Vessels are one store and one layer name: ADR 010's three providers are merged into it
 * server side, in `services/union.py`, and arrive already resolved to one record per MMSI.
 * There is no per-record layer here because there is nothing for it to discriminate.
 */

import {
  BlendOption,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  PointPrimitiveCollection,
  VerticalOrigin,
} from 'cesium';
import type { Label, PointPrimitive, Scene } from 'cesium';

import { isUnderWay, vesselLabel } from '../../domain/vessel';
import type { Vessel } from '../../domain/vessel';
import type { Changes } from '../../net/ws';
import { cesiumColour } from '../colour';
import { advanceGreatCircle } from '../project';
import { SELECTION_COLOUR } from '../palette';

/**
 * Vessels under way, in a cyan that no aircraft class uses.
 *
 * Red and orange stay reserved for alerts across the whole app, so nothing here may use
 * them.
 */
export const UNDER_WAY_COLOUR = '#2ec8d8';

/** Moored, anchored or otherwise stopped. Dimmer so a berth recedes behind the traffic. */
export const STOPPED_COLOUR = '#4d6373';

/**
 * Smaller than the seven pixels an aircraft gets.
 *
 * A thousand vessels within a few hundred metres of each other is a normal port. At seven
 * pixels they merge into one shape; at four the mass still has structure.
 */
export const VESSEL_PIXEL_SIZE = 4;

/** The selected vessel is enlarged as well as ringed, so the ring is not the only cue. */
export const SELECTED_VESSEL_PIXEL_SIZE = 9;

/**
 * How close the camera has to be before names appear, in metres.
 *
 * Tighter than the aircraft layer's 400 km. A ship's name is only useful once you are
 * looking at a stretch of coast rather than an ocean, and at ocean range the label tier
 * would be paying for text nobody can read.
 */
const LABEL_VISIBLE_RANGE_M = 60_000;

/**
 * The longest a position is extrapolated before the vessel is left where it is, in seconds.
 *
 * Two poll cycles. Digitraffic's default query window is 24 hours, so a record can arrive
 * with a position age in the tens of thousands of seconds, and the store keeps a vessel for
 * three missed polls. Without a cap a browser tab left open would sail every ship along a
 * straight line it was never on, which in coastal water is a lie a viewer can measure
 * against the shore. Past the cap the vessel stays put and `advance` stops reporting
 * movement, so the render loop goes idle rather than spinning on positions that no longer
 * change.
 */
export const MAX_DEAD_RECKON_SECONDS = 120;

const LABEL_FONT = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Same near-white as the panel text, so a label reads as chrome and not as an entity. */
const LABEL_COLOUR = '#e6edf3';

/** What the layer holds for one vessel. Kept flat: this is touched every frame. */
interface Slot {
  point: PointPrimitive;
  label: Label;
  /** The reported fix, which dead reckoning extrapolates from rather than accumulating. */
  fixLon: number;
  fixLat: number;
  /** Course over ground, not heading. Null when the feed did not report one. */
  courseDeg: number | null;
  speedMps: number | null;
  /**
   * Local clock reading when the fix arrived.
   *
   * Local, not the server's `observed_at`: anchoring to a remote clock makes every vessel
   * jump by the skew between the browser and the server on each update.
   */
  anchorMs: number;
  underWay: boolean;
}

const scratch = new Cartesian3();

export class VesselLayer {
  private readonly points: PointPrimitiveCollection;
  private readonly labels: LabelCollection;
  private readonly slots = new Map<string, Slot>();
  private readonly freePoints: PointPrimitive[] = [];
  private readonly freeLabels: Label[] = [];
  private selectedId: string | null = null;
  private visible = true;

  constructor(scene: Scene) {
    this.points = new PointPrimitiveCollection({
      // Every point is fully opaque, which lets Cesium skip the translucent pass. The
      // moored/under-way distinction is two solid hues, not one hue at two alphas, for
      // exactly this reason.
      blendOption: BlendOption.OPAQUE,
    });
    this.labels = new LabelCollection({ scene });
    scene.primitives.add(this.points);
    scene.primitives.add(this.labels);
  }

  get count(): number {
    return this.slots.size;
  }

  /**
   * Draw one frame's worth of socket traffic.
   *
   * Snapshots first, then deltas, exactly as the aircraft layer does and for the same
   * reason: a snapshot is the authoritative state of the layer at the moment it was taken,
   * and anything batched alongside it is newer.
   */
  apply(changes: Changes<Vessel>, nowMs: number = Date.now()): void {
    for (const entities of changes.snapshots.values()) {
      this.replace(entities, nowMs);
    }
    this.remove(changes.removals.keys());
    for (const entry of changes.upserts.values()) {
      this.upsertOne(entry.entity, nowMs);
    }
  }

  /**
   * Apply added or moved vessels, keyed on MMSI.
   *
   * O(1) per record: the index gives the existing primitive and the primitive's own fields
   * are assigned. A new vessel takes a primitive from the free pool if one is waiting and
   * only allocates when the pool is empty.
   */
  upsert(records: Iterable<Vessel>, nowMs: number = Date.now()): void {
    for (const record of records) {
      this.upsertOne(record, nowMs);
    }
  }

  /** Apply a full snapshot: anything the feed no longer reports is gone. */
  replace(records: readonly Vessel[], nowMs: number = Date.now()): void {
    const present = new Set(records.map((record) => record.mmsi));
    for (const [mmsi, slot] of this.slots) {
      if (!present.has(mmsi)) {
        this.release(mmsi, slot);
      }
    }
    this.upsert(records, nowMs);
  }

  /** Take vessels off the globe. One the layer never held is ignored. */
  remove(mmsis: Iterable<string>): void {
    for (const mmsi of mmsis) {
      const slot = this.slots.get(mmsi);
      if (slot !== undefined) {
        this.release(mmsi, slot);
      }
    }
  }

  /**
   * Advance every vessel under way along its course. Returns true when anything actually
   * moved, which is what tells the caller whether to ask for a frame.
   *
   * Each position is recomputed from the reported fix rather than stepped from the last
   * drawn position, so extrapolation error cannot accumulate and a fresh fix snaps cleanly
   * back to the truth.
   */
  advance(nowMs: number = Date.now()): boolean {
    if (!this.visible) {
      return false;
    }
    let moved = false;
    for (const slot of this.slots.values()) {
      if (!slot.underWay) {
        continue;
      }
      const elapsed = (nowMs - slot.anchorMs) / 1000;
      if (elapsed > MAX_DEAD_RECKON_SECONDS) {
        continue;
      }
      const next = advanceGreatCircle(
        slot.fixLon,
        slot.fixLat,
        slot.courseDeg,
        slot.speedMps,
        elapsed,
      );
      this.place(slot, next.lon, next.lat);
      moved = true;
    }
    return moved;
  }

  /**
   * Show or hide the whole layer, for the rail switch.
   *
   * Hidden, never dropped: the records stay tracked, so switching the layer back on draws
   * the picture the store has kept rather than waiting on the next poll. One flag on each
   * collection rather than a walk over every slot, because unlike the aircraft layer this
   * layer's collections hold nothing else. Hidden vessels are also skipped by `advance`,
   * which is where the per-frame cost is.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.points.show = visible;
    this.labels.show = visible;
  }

  /**
   * Highlight one vessel, or none.
   *
   * Selection also forces the label on, which is the escape hatch for the labelling rule
   * above: click a moored ship and you get its name.
   */
  setSelected(mmsi: string | null): void {
    if (this.selectedId === mmsi) {
      return;
    }
    const previous = this.selectedId;
    this.selectedId = mmsi;
    for (const changed of [previous, mmsi]) {
      if (changed === null) {
        continue;
      }
      const slot = this.slots.get(changed);
      if (slot !== undefined) {
        this.emphasise(slot, changed === this.selectedId);
      }
    }
  }

  private upsertOne(record: Vessel, nowMs: number): void {
    const slot = this.slots.get(record.mmsi) ?? this.acquire(record.mmsi);
    slot.fixLon = record.point.lon;
    slot.fixLat = record.point.lat;
    slot.courseDeg = record.course_over_ground_deg ?? null;
    slot.speedMps = record.speed_over_ground_mps ?? null;
    slot.anchorMs = nowMs;
    slot.underWay = isUnderWay(record);

    slot.point.color = cesiumColour(slot.underWay ? UNDER_WAY_COLOUR : STOPPED_COLOUR);
    slot.label.text = vesselLabel(record);
    this.emphasise(slot, record.mmsi === this.selectedId);
    this.place(slot, slot.fixLon, slot.fixLat);
  }

  /** Size, ring and label visibility, which together carry the selection and motion state. */
  private emphasise(slot: Slot, selected: boolean): void {
    slot.point.pixelSize = selected ? SELECTED_VESSEL_PIXEL_SIZE : VESSEL_PIXEL_SIZE;
    slot.point.outlineWidth = selected ? 2 : 0;
    // An unringed point gets a transparent outline rather than a zero-width coloured one:
    // Cesium antialiases the edge against the outline colour either way.
    slot.point.outlineColor = selected ? cesiumColour(SELECTION_COLOUR) : Color.TRANSPARENT;
    slot.label.show = selected || slot.underWay;
  }

  private place(slot: Slot, lon: number, lat: number): void {
    // Height 0: AIS carries no altitude and the contract guarantees `point.altitude_m` is
    // null on every vessel, so there is nothing to read.
    Cartesian3.fromDegrees(lon, lat, 0, undefined, scratch);
    // Both setters clone, so one scratch vector serves every vessel and the frame
    // allocates nothing.
    slot.point.position = scratch;
    slot.label.position = scratch;
  }

  private acquire(mmsi: string): Slot {
    // A fresh primitive is positioned by the caller a few lines later; Cesium just needs
    // somewhere to start.
    const point = this.freePoints.pop() ?? this.points.add({ position: Cartesian3.ZERO });
    const label = this.freeLabels.pop() ?? this.labels.add({ position: Cartesian3.ZERO });
    point.show = true;
    point.id = mmsi;
    // The label carries the same id as its point, because Cesium copies a label's id onto
    // the glyph billboards it renders and a click on the name has to pick the vessel
    // rather than reading as a click on empty space.
    label.id = mmsi;
    label.font = LABEL_FONT;
    label.fillColor = cesiumColour(LABEL_COLOUR);
    label.style = LabelStyle.FILL_AND_OUTLINE;
    label.outlineColor = Color.BLACK;
    label.outlineWidth = 3;
    label.horizontalOrigin = HorizontalOrigin.LEFT;
    label.verticalOrigin = VerticalOrigin.CENTER;
    label.pixelOffset = new Cartesian2(8, 0);
    label.distanceDisplayCondition = new DistanceDisplayCondition(0, LABEL_VISIBLE_RANGE_M);

    const slot: Slot = {
      point,
      label,
      fixLon: 0,
      fixLat: 0,
      courseDeg: null,
      speedMps: null,
      anchorMs: 0,
      underWay: false,
    };
    this.slots.set(mmsi, slot);
    return slot;
  }

  /**
   * Hand a slot's primitives back for reuse.
   *
   * Hidden and pooled rather than removed from the collection: `remove` on a primitive
   * collection forces it to rebuild its buffers, and ships leave a viewport constantly.
   */
  private release(mmsi: string, slot: Slot): void {
    slot.point.show = false;
    slot.point.id = undefined;
    slot.label.show = false;
    slot.label.id = undefined;
    slot.label.text = '';
    this.freePoints.push(slot.point);
    this.freeLabels.push(slot.label);
    this.slots.delete(mmsi);
    if (this.selectedId === mmsi) {
      this.selectedId = null;
    }
  }
}
