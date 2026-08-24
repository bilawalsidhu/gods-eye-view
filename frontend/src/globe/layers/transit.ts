/**
 * The transit layer: buses, trams, trains and ferries from GTFS-Realtime.
 *
 * Structurally the same as `vessels.ts` and for the same reasons: one `BillboardCollection`, one
 * `LabelCollection`, both built once and mutated in place, no Cesium `Entity` anywhere, retired
 * vehicles pooled rather than removed. This is the layer that most needs that discipline, because
 * it is the biggest in the app: 10,000 vehicles at a quiet hour and 20,349 measured at the daily
 * peak, against 6,000 vessels.
 *
 * Four things differ from every other mover layer, and all four come from the contract rather than
 * from taste. Read `src/tracker/contracts/transit.py` before changing any of them.
 *
 * **The key is compound.** A slot is keyed on `feed_id` and `entity_id` together, never on
 * `vehicle_id`. Measured across 247 feeds on 2026-08-23: 35.9% of id-carrying vehicles sat on an id
 * another agency was also using, `'557'` and `'801'` were each in use by nine operators, and keying
 * on `vehicle_id` alone would have collapsed 3,224 vehicles into other vehicles. A further 14.7%
 * carry no `vehicle_id` at all. This is not the ADR 010 union case: each feed is the sole publisher
 * of its own vehicles, so `feed_id` is part of the identity rather than provenance.
 *
 * **There is one silhouette, because there is no mode.** The contract carries no `route_type`, no
 * `vehicle_type` and no `mode`, and `sources/gtfsrt.py` derives none. Telling a bus from a train
 * would need each operator's static `routes.txt`, which this project does not fetch. So a bus and a
 * train are drawn the same, and that is the honest answer rather than guessing which is which. See
 * `vehicle` in `../icons`.
 *
 * **Nothing is dead reckoned.** Every other mover layer extrapolates between polls. This one does
 * not, and `advance` says so by always returning false. A ship at sea and an aircraft at altitude
 * keep going in a straight line at the speed they reported, which is why extrapolating them is
 * sound. A bus does not: it stops at every stop and every light, and it turns at junctions. At a
 * typical fifteen-second feed cadence, a vehicle reporting 8 m/s would be drawn 120 metres along
 * its bearing, which for a road vehicle is the wrong street and a viewer can see it. The feed also
 * reports a speed on only 23.4% of vehicles, measured live on 2026-08-23, so for three in four
 * there is nothing to extrapolate from even in principle.
 * Not extrapolating also takes the densest layer in the app out of the per-frame budget entirely.
 *
 * **One colour.** The vessel layer draws under way and stopped apart because AIS reports a speed
 * almost always. Here the contract measured 39.9% and the live feed on 2026-08-23 came in lower
 * still at 23.4% of 13,054 vehicles, so a moving/stopped split would be a claim about three
 * vehicles in four that the feed never made.
 */

import {
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Matrix4,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium';
import type { Billboard, Label, Scene } from 'cesium';

import { cesiumColour } from '../colour';
import {
  CLUSTER_CELL_PX,
  OFF_SCREEN,
  ScreenClusterer,
  clusterCameraHeight,
  clusterPickId,
  parseClusterPickId,
} from '../cluster';
import { badgeSlots } from '../badge-slots';
import type { BadgeSlot } from '../badge-slots';
import type { ClusterFlyTo, ClusterMark, ClusterState } from '../cluster';
import { clusterBadgeImage, iconImage, orientAxis } from '../icons';
import type { IconShape } from '../icons';
import { pointInView } from '../project';
import type { ViewRect } from '../project';
import { transitKey } from '../../domain/transit';
import type { TransitVehicle } from '../../types/entities';
import {
  CLUSTER_FILL,
  CLUSTER_TEXT,
  TRANSIT_COLOUR,
  clusterBadgePx,
  clusterBadgeText,
  clusterFontPx,
} from '../palette';

/**
 * The slot key: the contract's merge key, joined. Re-exported so the socket and the layer cannot
 * drift, because a slot written under one spelling and removed under another leaks silently.
 *
 * The separator is a tab, and the reason is worth keeping next to the use: `feed_id` and `entity_id`
 * are both operator-supplied strings up to 64 and 200 characters and either could contain any
 * printable separator. A tab cannot appear in either without the feed being broken in a way that
 * would have failed the contract first.
 */
export { transitKey } from '../../domain/transit';

/** The key a transit badge's pick id carries. */
export const TRANSIT_CLUSTER_KEY = 'transit';

/**
 * How many vehicles must share a cell before they become a group. Twelve.
 *
 * Between the aircraft layer's ten and the vessel layer's fifteen. It began as a reasoned guess and
 * has since been measured against the live feed, which kept it: what follows is the measurement
 * rather than the guess.
 *
 * 13,054 vehicles, 56-pixel cells, a 1400 by 900 viewport, on 2026-08-23. Occupancy per cell is
 * wildly skewed, which is what a layer concentrated in cities looks like:
 *
 * =========================  =========  ==============  =============  ===========
 * view                       on screen  occupied cells  busiest cell   median cell
 * =========================  =========  ==============  =============  ===========
 * whole globe, 20,000km          4,583              14          1,649           33
 * Europe, 3,000km                3,885              60            781           11
 * Netherlands, 400km             1,628             106            267            5
 * Amsterdam, 60km                  477             122             29            2
 * =========================  =========  ==============  =============  ===========
 *
 * The wide views do not decide it: at 20,000km the busiest cell holds 1,649 vehicles and every
 * candidate from eight to sixty groups it, the whole range differing by only 60 loose vehicles out
 * of 4,583. The city zoom decides it, and there the numbers are: at twelve, 9 of the 122 occupied
 * cells become badges and 292 of 441 vehicles are still drawn as themselves. At thirty-five nothing
 * groups at all and the busiest cell stays an unreadable pile of 29 marks in 56 pixels. At eight,
 * 15 cells group and a third of them hold fewer than a cell's worth.
 *
 * Twelve also matches the geometry, which is the reason to trust it rather than a coincidence. Marks
 * are drawn at 19.7 pixels at a city zoom and 15.4 at a regional one, so a 56-pixel cell holds
 * about eight and about thirteen respectively before they overlap. Twelve sits inside that band: it
 * groups a cell that is over-full and leaves one that is merely busy.
 */
export const TRANSIT_CLUSTER_MIN = 12;

/**
 * Vehicle mark size in pixels, at the range a city is looked at from.
 *
 * The smallest directional mark in the app. This layer has two to three times the records of the
 * next biggest and they are concentrated in cities rather than spread over an ocean, so its mark
 * has the least room of any. Twenty still leaves about seventeen pixels of coloured shape inside two
 * of black casing, which is the floor the casing sets. See `casingPixels` in `../icons`.
 */
export const TRANSIT_ICON_PX = 20;

/** The selected vehicle, which is at most one. Nearly doubles, and gains the halo. */
export const SELECTED_TRANSIT_ICON_PX = 38;

/**
 * The camera range over which a vehicle mark shrinks, in metres, and how far it shrinks.
 *
 * The tightest near figure in the app, because transit is only meaningful at a city zoom, and the
 * hardest far factor, because urban concentration is a worse case at range than the North Sea is: a
 * European view puts tens of thousands of vehicles into the few hundred pixels its cities occupy.
 */
const SCALE_NEAR_M = 40_000;
const SCALE_FAR_M = 1_200_000;
const SCALE_FAR_FACTOR = 0.26;

const LABEL_FONT = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Same near-white as the panel text, so a label reads as chrome and not as an entity. */
const LABEL_COLOUR = '#e6edf3';

/** Gap in pixels between the edge of the mark and the start of the label. */
const LABEL_GAP_PX = 4;

const BADGE_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * The best label for a vehicle, which is the route rather than the fleet number.
 *
 * `route_id` first, present on 80.7%, because a rider looking at a city wants to know which service
 * it is. Then `vehicle_label`, the number written on the vehicle, on 76.9%. Then `vehicle_id`, the
 * internal fleet number, on 85.3% but meaningless to anybody outside the depot. Then `entity_id`,
 * which is required by the contract so this never returns an empty string.
 *
 * `route_id` is not a route *name*: resolving it needs that operator's `routes.txt`, which this
 * project does not fetch, so it is shown as the operator's own identifier and nothing more.
 */
export function transitLabel(vehicle: TransitVehicle): string {
  return vehicle.route_id ?? vehicle.vehicle_label ?? vehicle.vehicle_id ?? vehicle.entity_id;
}

/**
 * Which mark a vehicle gets: the vehicle body when a bearing was reported, a square when not.
 *
 * A vehicle with no bearing is drawn as the same square the vessel layer uses for a ship with no
 * course, and that reuse is deliberate. The square already means "no direction reported" in this
 * app, transit's own magenta says which layer it is, and a third unknown-direction shape would add
 * a word to the vocabulary without adding information. It is also the compact answer, which matters
 * more here than a unique one: a spiky fallback in the densest layer is the mistake the satellite
 * star already made once.
 *
 * **Correcting the original reasoning for this, which assumed the square would be the rare case.**
 * Measured against the live feed on 2026-08-23, 13,054 vehicles: a bearing is present on **31.8%**.
 * So the square is not a fallback at all, it is the majority mark, drawn 68.2% of the time. The
 * decision survives the correction and is strengthened by it, because compactness matters more the
 * more often a shape is drawn, and because the two colours it has to be told apart from are far
 * apart: slate `#4d6373` for a stopped ship against magenta `#ff79c6` here. The `vehicle` body is
 * the minority mark, and the third of vehicles that do report a heading are the third where the
 * heading is real information worth drawing.
 *
 * `bearing` arrives already normalised. `sources/gtfsrt.py` takes the modulo of the 470 negative
 * values measured on 2026-08-23 and maps the 18 readings of exactly 360.0 to null, the same
 * sentinel treatment Digitraffic's course of 360.0 gets. So the only case to handle here is a
 * missing bearing, and a missing bearing must never become a mark pointing north.
 *
 * **Absent and null are the same thing here, and that distinction is not academic.** `bearing`
 * carries a default on the contract, so the generated type is `number | null | undefined`: the
 * field can be explicitly null or missing from the payload altogether. An earlier version of this
 * compared against null alone, which drew a directional body for every vehicle whose feed simply
 * omitted the field. `??` collapses both, which is the same thing the aircraft layer does with
 * `track_deg` and the vessel layer with `course_over_ground_deg`.
 */
export function transitShape(vehicle: Pick<TransitVehicle, 'bearing'>): IconShape {
  return (vehicle.bearing ?? null) === null ? 'block' : 'vehicle';
}

/** What the layer holds for one vehicle. */
interface Slot {
  mark: Billboard;
  label: Label;
  lon: number;
  lat: number;
  bearingDeg: number | null;
  shape: IconShape;
  /** Grid cell from the last clustering pass, or `OFF_SCREEN`. */
  cell: number;
  /** Whether a badge is currently speaking for this vehicle instead of its own mark. */
  grouped: boolean;
}

/** A badge and the count drawn on it. Pooled like everything else in this file. */
interface Badge {
  mark: Billboard;
  label: Label;
}

const scratch = new Cartesian3();
const scratchAxis = new Cartesian3();
const scratchBadge = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchCarto = new Cartographic();

export class TransitLayer {
  private readonly marks: BillboardCollection;
  private readonly labels: LabelCollection;
  private readonly badges: BillboardCollection;
  private readonly badgeLabels: LabelCollection;
  private readonly slots = new Map<string, Slot>();
  private readonly freeMarks: Billboard[] = [];
  private readonly freeLabels: Label[] = [];
  private readonly badgePool: Badge[] = [];
  private readonly labelOffset = new Cartesian2(0, 0);
  /** Reused for the badge nudge, which changes on every clustering pass. */
  private readonly badgeOffset = new Cartesian2(0, 0);
  /** Reused for the slot the shared lattice grants. Plain numbers, never a Cesium type. */
  private readonly badgeSlot: BadgeSlot = { x: 0, y: 0 };
  private readonly scene: Scene;
  private readonly grid = new ScreenClusterer(CLUSTER_CELL_PX, TRANSIT_CLUSTER_MIN);
  private readonly rangeScale: NearFarScalar;
  /** A flat scalar for the selected mark, which must not shrink. See the aircraft layer. */
  private readonly fixedScale: NearFarScalar;
  private selectedId: string | null = null;
  private visible = true;

  constructor(scene: Scene) {
    this.scene = scene;
    this.rangeScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, SCALE_FAR_FACTOR);
    this.fixedScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, 1);
    this.marks = new BillboardCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    this.labels = new LabelCollection({ scene });
    this.badges = new BillboardCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    // Translucent explicitly. A `LabelCollection` on its default blend puts its glyphs in the
    // opaque pass, which Cesium draws before every translucent one, so each badge would be painted
    // over its own count. See AGENTS.md.
    this.badgeLabels = new LabelCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    scene.primitives.add(this.marks);
    scene.primitives.add(this.labels);
    scene.primitives.add(this.badges);
    scene.primitives.add(this.badgeLabels);
    scene.preUpdate.addEventListener(() => {
      this.recluster();
    });
  }

  get count(): number {
    return this.slots.size;
  }

  /**
   * How many vehicles fall inside a longitude and latitude rectangle.
   *
   * Here for parity with the other layers and not because the rail should call it. Use
   * `clusterState.onScreen` instead: that is a real projection of every vehicle through the camera
   * matrix with a horizon test, where this depends on `camera.computeViewRectangle`, which reads
   * zero at whole-globe zoom while marks are visibly drawn.
   */
  countInView(view: ViewRect): number {
    let inside = 0;
    for (const slot of this.slots.values()) {
      if (pointInView(view, slot.lon, slot.lat)) {
        inside += 1;
      }
    }
    return inside;
  }

  /** Apply added or moved vehicles, keyed on feed and entity together. */
  upsert(records: Iterable<TransitVehicle>): void {
    for (const record of records) {
      this.upsertOne(record);
    }
  }

  /** Apply a full snapshot: anything the feed no longer reports is gone. */
  replace(records: readonly TransitVehicle[]): void {
    const present = new Set(records.map((record) => transitKey(record)));
    for (const [key, slot] of this.slots) {
      if (!present.has(key)) {
        this.release(key, slot);
      }
    }
    this.upsert(records);
  }

  /** Take vehicles off the globe. One the layer never held is ignored. */
  remove(keys: Iterable<string>): void {
    for (const key of keys) {
      const slot = this.slots.get(key);
      if (slot !== undefined) {
        this.release(key, slot);
      }
    }
  }

  /**
   * Nothing to advance, ever, and the return value says so.
   *
   * Here so the render loop can treat this layer like the others rather than special-casing it. See
   * the note at the top of the file: a road vehicle stops and turns, so extrapolating it along a
   * bearing draws it on the wrong street, and the feed reports a speed on only 39.9% of vehicles
   * anyway. A layer that cannot honestly interpolate should cost the frame nothing.
   */
  advance(): boolean {
    return false;
  }

  /** Show or hide the whole layer, for the rail switch. Collection-level, so it costs four flags. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.marks.show = visible;
    this.labels.show = visible;
    this.badges.show = visible;
    this.badgeLabels.show = visible;
  }

  /** Highlight one vehicle, or none. Selection is a halo and a label, never a hue change. */
  setSelected(key: string | null): void {
    if (this.selectedId === key) {
      return;
    }
    const previous = this.selectedId;
    this.selectedId = key;
    for (const changed of [previous, key]) {
      if (changed === null) {
        continue;
      }
      const slot = this.slots.get(changed);
      if (slot !== undefined) {
        this.emphasise(slot, changed === this.selectedId);
      }
    }
  }

  /**
   * Regroup against where the camera is now. Public so a test can drive a pass by hand.
   *
   * A switched-off layer does nothing at all here, and on this layer that matters more than on any
   * other: the pass is O(n) over every vehicle and n is twenty thousand at the measured peak, so
   * projecting a hidden layer would be the largest piece of discarded work in the app. The other
   * layers keep counting while hidden, because their counts feed the rail; this one cannot, because
   * the count comes from the pass. `clusterState` therefore reports the last pass while the layer
   * is off, which is the honest reading of a layer nobody is looking at.
   */
  recluster(): void {
    badgeSlots.begin(
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      CLUSTER_CELL_PX,
    );
    badgeSlots.release(TRANSIT_CLUSTER_KEY);
    if (!this.visible) {
      return;
    }
    const camera = this.scene.camera;
    Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, scratchMatrix);
    const eye = camera.positionWC;
    this.grid.begin(this.scene.drawingBufferWidth, this.scene.drawingBufferHeight);
    for (const slot of this.slots.values()) {
      const at = slot.mark.position;
      slot.cell = this.grid.offer(scratchMatrix, eye.x, eye.y, eye.z, at.x, at.y, at.z);
    }
    this.grid.resolve();
    for (const slot of this.slots.values()) {
      const grouped = this.grid.grouped(slot.cell);
      if (slot.grouped !== grouped) {
        slot.grouped = grouped;
        slot.mark.show = !grouped;
        slot.label.show = !grouped && this.selectedId !== null;
      }
    }
    let used = 0;
    for (const mark of this.grid.marks()) {
      used = this.drawBadge(mark, used);
    }
    for (let index = used; index < this.badgePool.length; index += 1) {
      const badge = this.badgePool[index];
      if (badge?.mark.show === true) {
        badge.mark.show = false;
        badge.mark.id = undefined;
        badge.label.show = false;
        badge.label.text = '';
      }
    }
  }

  /** What the grouping came to, for the rail. `onScreen === individuals + inGroups` always. */
  get clusterState(): ClusterState {
    return this.grid.state;
  }

  /** Where to take the camera for a picked badge, or null when the id was not one of ours. */
  clusterFlyTo(pickId: string | null): ClusterFlyTo | null {
    const parsed = parseClusterPickId(pickId);
    if (parsed?.layerKey !== TRANSIT_CLUSTER_KEY) {
      return null;
    }
    const mark = this.grid.markFor(parsed.cellId);
    if (mark === null) {
      return null;
    }
    scratchBadge.x = mark.x;
    scratchBadge.y = mark.y;
    scratchBadge.z = mark.z;
    // A badge sits on one of its own members, so this is always a real position on the globe.
    const carto = Cartographic.fromCartesian(scratchBadge, undefined, scratchCarto);
    return {
      lon: (carto.longitude * 180) / Math.PI,
      lat: (carto.latitude * 180) / Math.PI,
      altitudeM: clusterCameraHeight(mark.spreadM),
      count: mark.count,
    };
  }

  private upsertOne(record: TransitVehicle): void {
    const key = transitKey(record);
    const slot = this.slots.get(key) ?? this.acquire(key);
    slot.lon = record.point.lon;
    slot.lat = record.point.lat;
    slot.bearingDeg = record.bearing ?? null;
    slot.shape = transitShape(record);
    slot.label.text = transitLabel(record);
    this.emphasise(slot, key === this.selectedId);
    this.orient(slot);
    this.place(slot);
  }

  /**
   * Image, size and label visibility.
   *
   * Only the selected vehicle is labelled. Every other mover layer draws some labels by distance,
   * and this one cannot: ten to twenty thousand vehicles concentrated in cities turn any
   * distance-based rule into a wall of text over the exact places a viewer is trying to read. The
   * route number is one click away, which is the same trade the vessel layer already makes for a
   * berth full of moored ships.
   */
  private emphasise(slot: Slot, selected: boolean): void {
    const sizePx = selected ? SELECTED_TRANSIT_ICON_PX : TRANSIT_ICON_PX;
    slot.mark.image = iconImage(slot.shape, TRANSIT_COLOUR, selected, sizePx);
    slot.mark.show = !slot.grouped;
    slot.mark.width = sizePx;
    slot.mark.height = sizePx;
    slot.mark.scaleByDistance = selected ? this.fixedScale : this.rangeScale;
    this.labelOffset.x = sizePx / 2 + LABEL_GAP_PX;
    slot.label.pixelOffset = this.labelOffset;
    slot.label.show = selected && !slot.grouped;
  }

  /** Point the body along the reported bearing, or leave the square unpointed. */
  private orient(slot: Slot): void {
    if (slot.bearingDeg === null) {
      slot.mark.alignedAxis = Cartesian3.ZERO;
      return;
    }
    orientAxis(slot.lon, slot.lat, slot.bearingDeg, scratchAxis);
    // The setter clones, so one scratch axis serves every vehicle.
    slot.mark.alignedAxis = scratchAxis;
  }

  private place(slot: Slot): void {
    // Height 0: the contract leaves `altitude_m` unset because the feed reports none, and inventing
    // ground level would be a fabricated value.
    Cartesian3.fromDegrees(slot.lon, slot.lat, 0, undefined, scratch);
    slot.mark.position = scratch;
    slot.label.position = scratch;
  }

  private drawBadge(mark: ClusterMark, used: number): number {
    const sizePx = clusterBadgePx(mark.count);
    const badge = this.badgePool[used] ?? this.acquireBadge();
    badge.mark.show = true;
    badge.mark.id = clusterPickId(TRANSIT_CLUSTER_KEY, mark.cellId);
    badge.mark.image = clusterBadgeImage(sizePx, CLUSTER_FILL, TRANSIT_COLOUR);
    badge.mark.width = sizePx;
    badge.mark.height = sizePx;
    scratchBadge.x = mark.x;
    scratchBadge.y = mark.y;
    scratchBadge.z = mark.z;
    badge.mark.position = scratchBadge;
    badge.label.show = true;
    badge.label.text = clusterBadgeText(mark.count);
    badge.label.font = `700 ${clusterFontPx(mark.count)}px ${BADGE_FONT_FAMILY}`;
    badge.label.position = scratchBadge;
    // Drawn on a lattice point rather than on the member it hangs from. Its own cell's centre when
    // that is free, which is what keeps two badges of this layer apart, and the nearest free point
    // otherwise, which is what keeps it from landing exactly on another layer's badge. See
    // `ClusterMark.nudgeX` and `badge-slots.ts`.
    const slot = badgeSlots.claim(TRANSIT_CLUSTER_KEY, mark.centreX, mark.centreY, this.badgeSlot);
    this.badgeOffset.x = mark.nudgeX + (slot.x - mark.centreX);
    this.badgeOffset.y = mark.nudgeY + (slot.y - mark.centreY);
    badge.mark.pixelOffset = this.badgeOffset;
    badge.label.pixelOffset = this.badgeOffset;
    return used + 1;
  }

  private acquireBadge(): Badge {
    const mark = this.badges.add({ position: Cartesian3.ZERO });
    mark.horizontalOrigin = HorizontalOrigin.CENTER;
    mark.verticalOrigin = VerticalOrigin.CENTER;
    const label = this.badgeLabels.add({ position: Cartesian3.ZERO });
    label.horizontalOrigin = HorizontalOrigin.CENTER;
    label.verticalOrigin = VerticalOrigin.CENTER;
    label.style = LabelStyle.FILL;
    label.fillColor = cesiumColour(CLUSTER_TEXT);
    const badge: Badge = { mark, label };
    this.badgePool.push(badge);
    return badge;
  }

  private acquire(key: string): Slot {
    const mark = this.freeMarks.pop() ?? this.marks.add({ position: Cartesian3.ZERO });
    const label = this.freeLabels.pop() ?? this.labels.add({ position: Cartesian3.ZERO });
    mark.show = true;
    mark.id = key;
    mark.horizontalOrigin = HorizontalOrigin.CENTER;
    mark.verticalOrigin = VerticalOrigin.CENTER;
    // The label carries the same id as its mark, because Cesium copies a label's id onto the glyph
    // billboards it renders and a click on the text has to pick the vehicle rather than reading as
    // a click on empty space.
    label.id = key;
    label.show = false;
    label.font = LABEL_FONT;
    label.fillColor = cesiumColour(LABEL_COLOUR);
    label.style = LabelStyle.FILL_AND_OUTLINE;
    label.outlineColor = Color.BLACK;
    label.outlineWidth = 3;
    label.horizontalOrigin = HorizontalOrigin.LEFT;
    label.verticalOrigin = VerticalOrigin.CENTER;

    const slot: Slot = {
      mark,
      label,
      lon: 0,
      lat: 0,
      bearingDeg: null,
      shape: 'block',
      cell: OFF_SCREEN,
      grouped: false,
    };
    this.slots.set(key, slot);
    return slot;
  }

  /**
   * Hand a slot's primitives back for reuse.
   *
   * Hidden and pooled rather than removed: `remove` on a primitive collection forces it to rebuild
   * its buffers, and a city's worth of vehicles goes out of service and back in all day.
   */
  private release(key: string, slot: Slot): void {
    slot.grouped = false;
    slot.cell = OFF_SCREEN;
    slot.mark.show = false;
    slot.mark.id = undefined;
    slot.label.show = false;
    slot.label.id = undefined;
    slot.label.text = '';
    this.freeMarks.push(slot.mark);
    this.freeLabels.push(slot.label);
    this.slots.delete(key);
    if (this.selectedId === key) {
      this.selectedId = null;
    }
  }
}
