/**
 * The aircraft layer. This is the performance-critical file in the frontend.
 *
 * One `PointPrimitiveCollection` and one `LabelCollection`, both created once and then
 * mutated in place. Nothing here removes and re-adds a primitive on an update, and the
 * Entity API is not used at all: it collapses in the low thousands of movers and the
 * target is 20,000. Retired aircraft hand their primitives back to a free pool so the
 * collections stop growing without the collection itself churning.
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

import { aircraftLabel, inEmergency } from '../../domain/derive';
import { cesiumColour } from '../colour';
import { advanceGreatCircle } from '../project';
import { EMERGENCY_COLOUR, SELECTION_COLOUR, colourFor, pixelSizeFor } from '../palette';
import type { Changes } from '../../net/ws';
import type { Aircraft, AircraftClass, LayerName } from '../../types/entities';

/** Labels are the most expensive tier, so they only exist within this range in metres. */
const LABEL_VISIBLE_RANGE_M = 400_000;

const LABEL_FONT = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Same near-white as the panel text, so a label reads as chrome and not as an entity. */
const LABEL_COLOUR = '#e6edf3';

/** What the layer holds for one aircraft. Kept flat: this is touched every frame. */
interface Slot {
  point: PointPrimitive;
  label: Label;
  /** The reported fix, which dead reckoning extrapolates from rather than accumulating. */
  fixLon: number;
  fixLat: number;
  heightM: number;
  trackDeg: number | null;
  speedMps: number | null;
  /**
   * Local clock reading when the fix arrived.
   *
   * Local, not the server's `observed_at`: anchoring to a remote clock makes every
   * aircraft jump by the clock skew between the browser and the server on each update.
   */
  anchorMs: number;
  /** Which feed owns this aircraft, so a stale removal cannot delete a live record. */
  layer: LayerName;
  moving: boolean;
  inEmergency: boolean;
}

const scratch = new Cartesian3();

export class AircraftLayer {
  private readonly points: PointPrimitiveCollection;
  private readonly labels: LabelCollection;
  private readonly slots = new Map<string, Slot>();
  private readonly freePoints: PointPrimitive[] = [];
  private readonly freeLabels: Label[] = [];
  private selectedId: string | null = null;
  /**
   * Layers the rail has switched off.
   *
   * Per layer rather than per collection: the civil feed and the military feed share one
   * `PointPrimitiveCollection`, so `collection.show` would hide both and a rail switch for
   * one of them would be a lie.
   */
  private readonly hiddenLayers = new Set<LayerName>();

  constructor(scene: Scene) {
    this.points = new PointPrimitiveCollection({
      // Every point is fully opaque, which lets Cesium skip the translucent pass.
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
   * Snapshots first, then deltas: a snapshot is the authoritative state of its layer at
   * the moment it was taken, and any delta batched alongside it is newer.
   */
  apply(changes: Changes<Aircraft>, nowMs: number = Date.now()): void {
    for (const [layer, entities] of changes.snapshots) {
      this.replace(entities, layer, nowMs);
    }
    for (const [id, layer] of changes.removals) {
      this.removeOne(id, layer);
    }
    for (const entry of changes.upserts.values()) {
      this.upsertOne(entry.entity, entry.layer, nowMs);
    }
  }

  /**
   * Apply added or moved aircraft.
   *
   * O(1) per record: the index gives the existing primitive, and the primitive's own
   * fields are assigned. A new aircraft takes a primitive from the free pool if one is
   * waiting and only allocates when the pool is empty.
   */
  upsert(records: Iterable<Aircraft>, layer: LayerName, nowMs: number = Date.now()): void {
    for (const record of records) {
      this.upsertOne(record, layer, nowMs);
    }
  }

  private upsertOne(record: Aircraft, layer: LayerName, nowMs: number): void {
    const slot = this.slots.get(record.icao24) ?? this.acquire(record.icao24, layer);
    slot.layer = layer;
    slot.fixLon = record.point.lon;
    slot.fixLat = record.point.lat;
    slot.heightM = record.point.altitude_m ?? 0;
    slot.trackDeg = record.track_deg ?? null;
    slot.speedMps = record.on_ground ? 0 : (record.ground_speed_mps ?? null);
    slot.anchorMs = nowMs;
    slot.moving = slot.trackDeg !== null && slot.speedMps !== null && slot.speedMps > 0;

    this.paint(record.icao24, slot, record.aircraft_class, inEmergency(record));
    slot.label.text = aircraftLabel(record);
    this.place(slot, slot.fixLon, slot.fixLat);
  }

  /**
   * Apply a full snapshot for one layer: anything that layer no longer reports is gone.
   *
   * Only that layer's aircraft are dropped. The military feed and the viewport feed are
   * separate stores server side and a snapshot of one says nothing about the other.
   */
  replace(records: readonly Aircraft[], layer: LayerName, nowMs: number = Date.now()): void {
    const present = new Set(records.map((record) => record.icao24));
    for (const [id, slot] of this.slots) {
      if (slot.layer === layer && !present.has(id)) {
        this.release(id, slot);
      }
    }
    this.upsert(records, layer, nowMs);
  }

  /** Take aircraft off the globe. A removal from a layer that no longer owns it is ignored. */
  remove(ids: Iterable<string>, layer: LayerName): void {
    for (const id of ids) {
      this.removeOne(id, layer);
    }
  }

  private removeOne(id: string, layer: LayerName): void {
    const slot = this.slots.get(id);
    if (slot?.layer === layer) {
      this.release(id, slot);
    }
  }

  /**
   * Advance every mover along its track. Returns true when anything actually moved, which
   * is what tells the caller whether to ask for a frame.
   *
   * Each position is recomputed from the reported fix rather than stepped from the last
   * drawn position, so extrapolation error cannot accumulate and a fresh fix snaps
   * cleanly back to the truth.
   */
  advance(nowMs: number = Date.now()): boolean {
    let moved = false;
    const anyHidden = this.hiddenLayers.size > 0;
    for (const slot of this.slots.values()) {
      if (!slot.moving || (anyHidden && this.hiddenLayers.has(slot.layer))) {
        continue;
      }
      const elapsed = (nowMs - slot.anchorMs) / 1000;
      const next = advanceGreatCircle(
        slot.fixLon,
        slot.fixLat,
        slot.trackDeg,
        slot.speedMps,
        elapsed,
      );
      this.place(slot, next.lon, next.lat);
      moved = true;
    }
    return moved;
  }

  /**
   * Show or hide one layer's aircraft, for the rail switch.
   *
   * Hidden, never dropped: the records stay tracked, so switching a layer back on draws the
   * picture the store has kept rather than waiting on a refetch. Hidden aircraft are also
   * skipped by `advance`, which is where the per-frame cost of a layer actually is, so a
   * switched-off layer costs one walk at the moment it is switched and nothing after that.
   */
  setVisible(layer: LayerName, visible: boolean): void {
    if (visible) {
      this.hiddenLayers.delete(layer);
    } else {
      this.hiddenLayers.add(layer);
    }
    for (const slot of this.slots.values()) {
      if (slot.layer !== layer) {
        continue;
      }
      slot.point.show = visible;
      slot.label.show = visible;
    }
  }

  /** Highlight one aircraft, or none. Selection is an outline, never a hue change. */
  setSelected(id: string | null): void {
    if (this.selectedId === id) {
      return;
    }
    const previous = this.selectedId;
    this.selectedId = id;
    for (const changed of [previous, id]) {
      if (changed === null) {
        continue;
      }
      const slot = this.slots.get(changed);
      if (slot !== undefined) {
        this.emphasise(slot, changed === this.selectedId);
      }
    }
  }

  private paint(id: string, slot: Slot, aircraftClass: AircraftClass, inEmergency: boolean): void {
    slot.inEmergency = inEmergency;
    slot.point.color = cesiumColour(colourFor(aircraftClass, inEmergency));
    slot.label.fillColor = cesiumColour(inEmergency ? EMERGENCY_COLOUR : LABEL_COLOUR);
    this.emphasise(slot, id === this.selectedId);
  }

  /**
   * Size and outline, which together carry emergency and selection state.
   *
   * An unringed point gets a transparent outline rather than a zero-width coloured one:
   * Cesium antialiases the edge against the outline colour either way, which fringed every
   * routine aircraft in alert red.
   */
  private emphasise(slot: Slot, selected: boolean): void {
    slot.point.pixelSize = pixelSizeFor(slot.inEmergency, selected);
    // Selection outranks emergency for the ring only: the emergency still shows through
    // the fill colour and the larger point size, so neither state is ever hidden.
    let ring: string | null = null;
    if (selected) {
      ring = SELECTION_COLOUR;
    } else if (slot.inEmergency) {
      ring = EMERGENCY_COLOUR;
    }
    slot.point.outlineWidth = ring === null ? 0 : 2;
    slot.point.outlineColor = ring === null ? Color.TRANSPARENT : cesiumColour(ring);
  }

  private place(slot: Slot, lon: number, lat: number): void {
    Cartesian3.fromDegrees(lon, lat, slot.heightM, undefined, scratch);
    // Both setters clone, so one scratch vector serves every aircraft and the frame
    // allocates nothing.
    slot.point.position = scratch;
    slot.label.position = scratch;
  }

  private acquire(id: string, layer: LayerName): Slot {
    // A fresh primitive is positioned by the caller a few lines later; Cesium just needs
    // somewhere to start.
    const point = this.freePoints.pop() ?? this.points.add({ position: Cartesian3.ZERO });
    const label = this.freeLabels.pop() ?? this.labels.add({ position: Cartesian3.ZERO });
    const shown = !this.hiddenLayers.has(layer);
    point.show = shown;
    point.id = id;
    // The label needs the same id as its point. Cesium copies a label's id onto the glyph
    // billboards it renders, so a click on the callsign text picks those billboards. Left
    // unset, picking a label returned undefined and read as a click on empty space, which
    // deselected the aircraft and closed the card the user was trying to open.
    label.id = id;
    label.show = shown;
    label.font = LABEL_FONT;
    label.style = LabelStyle.FILL_AND_OUTLINE;
    label.outlineColor = Color.BLACK;
    label.outlineWidth = 3;
    label.horizontalOrigin = HorizontalOrigin.LEFT;
    label.verticalOrigin = VerticalOrigin.CENTER;
    label.pixelOffset = new Cartesian2(10, 0);
    label.distanceDisplayCondition = new DistanceDisplayCondition(0, LABEL_VISIBLE_RANGE_M);

    const slot: Slot = {
      point,
      label,
      fixLon: 0,
      fixLat: 0,
      heightM: 0,
      trackDeg: null,
      speedMps: null,
      anchorMs: 0,
      layer,
      moving: false,
      inEmergency: false,
    };
    this.slots.set(id, slot);
    return slot;
  }

  /**
   * Hand a slot's primitives back for reuse.
   *
   * Hidden and pooled rather than removed from the collection: `remove` on a primitive
   * collection forces it to rebuild its buffers, and aircraft leave a busy viewport
   * constantly.
   */
  private release(id: string, slot: Slot): void {
    slot.point.show = false;
    slot.point.id = undefined;
    slot.label.show = false;
    slot.label.id = undefined;
    slot.label.text = '';
    this.freePoints.push(slot.point);
    this.freeLabels.push(slot.label);
    this.slots.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
    }
  }
}
