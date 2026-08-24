/**
 * The vessel layer.
 *
 * Structurally the same as `aircraft.ts` and for the same reason: one
 * `BillboardCollection` and one `LabelCollection`, both created once and mutated in place,
 * no Cesium `Entity` anywhere, no collection rebuilt per tick, and retired vessels hand
 * their primitives back to a free pool. That is not a preference, it is the only shape that
 * survives thousands of movers.
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
 *   reported is still drawn, and its name is one click away.
 * - **A vessel with no reported course is drawn as a square rather than a hull, and a
 *   moored vessel is drawn dimmer than one under way.** At a port zoom a full berth then
 *   reads as a field of quiet squares with the moving hulls standing out of it, rather than
 *   as one saturated blob where every ship has painted over its neighbour. The shape is not
 *   decoration: it is the difference between a course the feed gave us and one it did not.
 *
 * **Crowding.** Nearly four thousand records, all of them in Northern European waters, so from
 * a whole-globe view they are one dense patch and no mark size can separate them: there is less
 * than a pixel of screen per ship. Past that point the layer draws one badge carrying the count
 * instead, per `../cluster`. Grouping is decided by screen density rather than by altitude, so
 * pulling in splits the groups until they are ships again, and nothing is dropped on the way:
 * `clusterState` publishes how many are drawn as themselves and how many are inside a badge.
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
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Matrix4,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium';
import type { Billboard, Label, Scene } from 'cesium';

import { isUnderWay, vesselLabel } from '../../domain/vessel';
import type { Vessel } from '../../domain/vessel';
import type { Changes } from '../../net/ws';
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
import { iconImage, orientAxis } from '../icons';
import type { IconShape } from '../icons';
import { advanceGreatCircle, pointInView } from '../project';
import type { ViewRect } from '../project';

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
 * Vessel mark size in pixels, at the range a coast is actually looked at from.
 *
 * Smaller than an aircraft's twenty-six, because a thousand vessels within a few hundred
 * metres of each other is a normal port and the aircraft size would merge them into one
 * shape. Not smaller than that: some of the people this is shown to have poor vision, so
 * density at a given range is answered by the quieter shape and the dimmer hue rather than by
 * shrinking the mark until nobody can see it. Density across ranges is answered by
 * `SCALE_NEAR_M` below, which is a different problem with a different lever.
 */
export const VESSEL_ICON_PX = 22;

/** The selected vessel, which is at most one. Doubles, and gains the halo with it. */
export const SELECTED_VESSEL_ICON_PX = 40;

/**
 * The camera range over which a vessel mark shrinks, in metres, and how far it shrinks.
 *
 * Tighter than the aircraft range because the useful zoom for shipping is tighter: a coast or
 * a strait rather than a continent.
 *
 * The far factor is the hardest in the app, and it is set by measurement rather than symmetry.
 * This layer holds the most records by a wide margin and they all sit in Northern European
 * waters, so a whole-globe view stacks several thousand of them into perhaps sixty pixels of
 * screen. Nothing about an individual ship is legible there at any size, so the mark's only
 * job at that range is to mark the water as busy without becoming an ink stain over the North
 * Sea. What is left after this is a clustering problem rather than a sizing one, and
 * clustering is phase 9.
 */
const SCALE_NEAR_M = 60_000;
const SCALE_FAR_M = 2_500_000;
const SCALE_FAR_FACTOR = 0.28;

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

/** Gap in pixels between the edge of the mark and the start of the name. */
const LABEL_GAP_PX = 6;

/**
 * How many ships must share a cell before they become a group. Fifteen, not the default ten.
 *
 * This layer's marks are the smallest of the three that carry a shape, and there are four thousand
 * of them in one part of the world, so a badge has to replace more of them before it is worth the
 * map it hides. Fifteen is where a badge stops costing the picture more than the ships behind it.
 */
export const VESSEL_CLUSTER_MIN = 15;

/** The key a vessel badge's pick id carries. One feed, so one name. */
export const VESSEL_CLUSTER_KEY = 'vessels';

/**
 * A merged group and the label slot it no longer uses. Pooled like everything else in this file.
 *
 * The label stays in the pool with nothing on it. Groups are drawn as one ship now rather than as a
 * counted hexagon, so there is no text, but the collection is kept because dropping a primitive
 * collection from a scene is the churn this file exists to avoid and because a later change that
 * wants a word on a group has somewhere to put it.
 */
interface Badge {
  mark: Billboard;
  label: Label;
}

/** What the layer holds for one vessel. Kept flat: this is touched every frame. */
interface Slot {
  mark: Billboard;
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
  /** Held so a selection change can rebuild the mark without the record in hand. */
  colour: string;
  shape: IconShape;
  /** Grid cell from the last clustering pass, or `OFF_SCREEN`. */
  cell: number;
  /** Whether a badge is currently speaking for this vessel instead of its own mark. */
  grouped: boolean;
}

const scratch = new Cartesian3();
const scratchAxis = new Cartesian3();
const scratchBadge = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchCarto = new Cartographic();

export class VesselLayer {
  private readonly marks: BillboardCollection;
  private readonly labels: LabelCollection;
  private readonly slots = new Map<string, Slot>();
  private readonly freeMarks: Billboard[] = [];
  private readonly freeLabels: Label[] = [];
  /** One reusable offset. Cesium's `pixelOffset` setter clones, so this never aliases. */
  private readonly labelOffset = new Cartesian2(0, 0);
  /** Reused for the badge nudge, which changes on every clustering pass. */
  private readonly badgeOffset = new Cartesian2(0, 0);
  /** Reused for the slot the shared lattice grants. Plain numbers, never a Cesium type. */
  private readonly badgeSlot: BadgeSlot = { x: 0, y: 0 };
  /** How the mark shrinks with range, built once and shared. The setter clones. */
  private readonly rangeScale: NearFarScalar;
  /**
   * A flat scalar for the one mark that must not shrink.
   *
   * Cesium types `scaleByDistance` as required rather than optional, so this is how a
   * billboard opts out of ranging: the same value at both ends of the range means no change
   * at any distance. Clearer than casting away the type, and it reads as the deliberate
   * exemption it is.
   */
  private readonly fixedScale: NearFarScalar;
  private selectedId: string | null = null;
  private visible = true;
  /** The scene, kept because every clustering pass needs its camera and its viewport. */
  private readonly scene: Scene;
  private readonly badges: BillboardCollection;
  private readonly badgeLabels: LabelCollection;
  private readonly badgePool: Badge[] = [];
  /** See `VESSEL_CLUSTER_MIN`. */
  private readonly grid = new ScreenClusterer(CLUSTER_CELL_PX, VESSEL_CLUSTER_MIN);
  /**
   * Cells holding at least one ship under way, rebuilt each pass.
   *
   * What keeps a merged group from reading as a berth when something in it is moving. A port at a
   * wide zoom is one cell, and the vessels in it are mostly moored, so without this every merged
   * icon on a coast would be drawn in the stopped grey and traffic would vanish into the harbour
   * it is leaving.
   */
  private readonly underWayCells = new Set<number>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.rangeScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, SCALE_FAR_FACTOR);
    this.fixedScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, 1);
    this.marks = new BillboardCollection({
      scene,
      // An icon has antialiased edges and transparent corners, so it has to go through the
      // translucent pass; `OPAQUE` would draw those corners as black squares. Still
      // narrower than Cesium's default, which pays for both passes.
      blendOption: BlendOption.TRANSLUCENT,
    });
    this.labels = new LabelCollection({ scene });
    this.badges = new BillboardCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    // `BlendOption.TRANSLUCENT` on the counts, not the default. The badges are translucent,
    // and Cesium draws every translucent command after every opaque one whatever order the
    // primitives were added in, so a count left on the default blend went into the opaque
    // pass and its own badge was then painted straight over it. Measured 2026-08-23: every
    // badge on the globe rendered as an empty hexagon, and the counts came back the moment
    // both collections shared a pass and primitive order could decide.
    this.badgeLabels = new LabelCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    scene.primitives.add(this.marks);
    scene.primitives.add(this.labels);
    // Badges after the marks, counts last, so a count is never drawn under its own badge.
    scene.primitives.add(this.badges);
    scene.primitives.add(this.badgeLabels);
    // `preUpdate` rather than a loop of its own: this reacts to frames that are already
    // happening and never asks for one, so render policy stays in `viewer.ts`.
    scene.preUpdate.addEventListener(() => {
      this.recluster();
    });
  }

  get count(): number {
    return this.slots.size;
  }

  /**
   * How many ships are inside the current view.
   *
   * This layer is the reason the count exists. Its only keyless provider is Fintraffic,
   * which covers Finnish waters, so the layer is legitimately live with hundreds of ships
   * and legitimately empty everywhere else on the globe. A rail row showing the total alone
   * reads as a broken layer.
   */
  countInView(view: ViewRect): number {
    let inside = 0;
    for (const slot of this.slots.values()) {
      if (pointInView(view, slot.fixLon, slot.fixLat)) {
        inside += 1;
      }
    }
    return inside;
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
   * back to the truth. The orientation is left alone for the same reason the aircraft layer
   * leaves it alone: two minutes of extrapolation barely turns an earth-fixed direction.
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
    this.marks.show = visible;
    this.labels.show = visible;
    this.badges.show = visible;
    this.badgeLabels.show = visible;
  }

  /**
   * Regroup against where the camera is now.
   *
   * Public because `preUpdate` is not a seam a test can stand on. Two passes and no allocation:
   * the first projects and bins every ship, the second reads back which cells came out crowded.
   * `show` is only written when it changes, so a still camera costs nothing and a moving one pays
   * only for the ships that crossed a cell boundary.
   */
  recluster(): void {
    badgeSlots.begin(
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      CLUSTER_CELL_PX,
    );
    badgeSlots.release(VESSEL_CLUSTER_KEY);
    const camera = this.scene.camera;
    Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, scratchMatrix);
    const eye = camera.positionWC;
    this.grid.begin(this.scene.drawingBufferWidth, this.scene.drawingBufferHeight);
    for (const slot of this.slots.values()) {
      const at = slot.mark.position;
      // The course goes in so a merged group can be turned to the members' mean heading. Null
      // where the feed carried none, and the clusterer keeps those out of the circular mean
      // rather than counting them as due north.
      slot.cell = this.grid.offer(
        scratchMatrix,
        eye.x,
        eye.y,
        eye.z,
        at.x,
        at.y,
        at.z,
        slot.courseDeg,
      );
    }
    this.grid.resolve();
    this.underWayCells.clear();
    for (const slot of this.slots.values()) {
      const grouped = this.grid.grouped(slot.cell);
      if (grouped && slot.underWay) {
        this.underWayCells.add(slot.cell);
      }
      if (slot.grouped !== grouped) {
        slot.grouped = grouped;
        slot.mark.show = !grouped;
        // The port rule still decides whether a name is drawn; grouping can only take it away.
        slot.label.show = !grouped && (slot.underWay || this.selectedId !== null);
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

  /**
   * What the grouping came to, for the rail.
   *
   * `onScreen === individuals + inGroups` always holds, which is what stops clustering turning
   * this layer's count into a lie.
   */
  get clusterState(): ClusterState {
    return this.grid.state;
  }

  /**
   * Where to take the camera for a picked badge, or null when the id was not one of ours.
   *
   * A badge opens no card: a card for four hundred ships is not a card. Null also covers a stale
   * id, because cells are numbered per pass and a badge that has dissolved must resolve to
   * nothing rather than to whatever now sits in that cell.
   */
  clusterFlyTo(pickId: string | null): ClusterFlyTo | null {
    const parsed = parseClusterPickId(pickId);
    if (parsed?.layerKey !== VESSEL_CLUSTER_KEY) {
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
    slot.colour = slot.underWay ? UNDER_WAY_COLOUR : STOPPED_COLOUR;
    // No course, no hull. The AIS not-available course is 360.0 and the adapter maps it to
    // null, so a missing course is a missing measurement rather than a bearing of zero, and
    // pointing a bow north on the strength of it would invent a heading for about one ship
    // in twenty. Those are drawn as a square instead, which points nowhere by construction.
    // True heading is not consulted either: it is where the bow looks, not where the ship is
    // going, and the whole layer extrapolates on course over ground.
    slot.shape = slot.courseDeg === null ? 'block' : 'ship';

    slot.label.text = vesselLabel(record);
    this.emphasise(slot, record.mmsi === this.selectedId);
    this.orient(slot);
    this.place(slot, slot.fixLon, slot.fixLat);
  }

  /**
   * Draw one group as a single vessel, taking the next slot out of the pool.
   *
   * **No hexagon and no count.** Alexander Fanthome asked on 2026-08-24 to "remove those
   * hexagons ... instead just merge the asset locations into one icon, and average the
   * position/rotation ... Do not scale the asset icon size when merging, keep at the current
   * size", after saying the globe was very cluttered. So a group of ships is drawn as one ship:
   * same hull, same size, at the members' mean position, pointing along their mean course.
   *
   * **The information this gives up is the count**, and that is the trade he asked for. One hull
   * in the Channel now looks the same whether it stands for two ships or four hundred. The rail
   * still carries the totals, and zooming in splits the group into its members, which is where
   * the number becomes visible again.
   *
   * **A group with one ship moving in it is drawn as moving.** Cyan and grey are this layer's
   * only state channel, so a group of four hundred moored hulls with one under way among them
   * keeps the under-way cyan, for the same reason the aircraft layer keeps red on a group that
   * swallowed an emergency: the merge must not be the thing that hides the movement.
   */
  private drawBadge(mark: ClusterMark, used: number): number {
    // The unmerged size, deliberately. `clusterBadgePx` grew with the count, which is exactly what
    // was asked to stop: a merged icon is one vessel's worth of ink wherever it appears.
    const sizePx = VESSEL_ICON_PX;
    const badge = this.badgePool[used] ?? this.acquireBadge();
    badge.mark.show = true;
    badge.mark.id = clusterPickId(VESSEL_CLUSTER_KEY, mark.cellId);
    // A cut-cornered square when nothing in the group reported a course, matching what a single
    // vessel with no course draws. A hull pointing north would be a bearing nobody reported.
    badge.mark.image = iconImage(
      mark.meanHeadingDeg === null ? 'block' : 'ship',
      this.underWayCells.has(mark.cellId) ? UNDER_WAY_COLOUR : STOPPED_COLOUR,
      false,
      sizePx,
    );
    badge.mark.width = sizePx;
    badge.mark.height = sizePx;
    scratchBadge.x = mark.meanX;
    scratchBadge.y = mark.meanY;
    scratchBadge.z = mark.meanZ;
    // Both setters clone, so one scratch vector serves every badge in the pass.
    badge.mark.position = scratchBadge;
    if (mark.meanHeadingDeg === null) {
      // No member reported a course, so there is no bearing to turn to. The zero vector is
      // Cesium's own "unrotated", which is what a courseless single vessel draws as too.
      badge.mark.alignedAxis = Cartesian3.ZERO;
    } else {
      // Orientation is a world-space axis rather than a screen angle, the same way a single hull
      // is turned. The mean position has to be converted back to degrees for it, because
      // `orientAxis` works from a point on the ellipsoid and a bearing there.
      const at = Cartographic.fromCartesian(scratchBadge, undefined, scratchCarto);
      orientAxis(
        (at.longitude * 180) / Math.PI,
        (at.latitude * 180) / Math.PI,
        mark.meanHeadingDeg,
        scratchAxis,
      );
      badge.mark.alignedAxis = scratchAxis;
    }
    badge.label.show = false;
    badge.label.text = '';
    // Drawn on a lattice point rather than on the member it hangs from. Its own cell's centre when
    // that is free, which is what keeps two badges of this layer apart, and the nearest free point
    // otherwise, which is what keeps it from landing exactly on another layer's badge. See
    // `ClusterMark.nudgeX` and `badge-slots.ts`.
    const slot = badgeSlots.claim(VESSEL_CLUSTER_KEY, mark.centreX, mark.centreY, this.badgeSlot);
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
    // No depth override on either. My first guess at the empty-hexagon bug was a depth tie between
    // a badge and the count sitting at exactly its position, and turning depth off did hide the
    // symptom. It was the wrong diagnosis: Cesium draws every opaque command before every
    // translucent one, and the count's collection was on its default blend, so the digits went
    // into the opaque pass and the badge painted over them. That is fixed where it belongs, on the
    // collection's `blendOption`, and this stays honest about depth.
    const label = this.badgeLabels.add({ position: Cartesian3.ZERO });
    label.horizontalOrigin = HorizontalOrigin.CENTER;
    label.verticalOrigin = VerticalOrigin.CENTER;
    // Fill only, held from when a group carried a count. Nothing is drawn on it now.
    label.style = LabelStyle.FILL;
    const badge: Badge = { mark, label };
    this.badgePool.push(badge);
    return badge;
  }

  private emphasise(slot: Slot, selected: boolean): void {
    const sizePx = selected ? SELECTED_VESSEL_ICON_PX : VESSEL_ICON_PX;
    slot.mark.image = iconImage(slot.shape, slot.colour, selected, sizePx);
    slot.mark.show = !slot.grouped;
    slot.mark.width = sizePx;
    slot.mark.height = sizePx;
    // The selected vessel keeps its full size at any range: there is one of it, and a
    // selection that faded with distance would be useless at the zoom where a picture holds
    // three thousand ships.
    slot.mark.scaleByDistance = selected ? this.fixedScale : this.rangeScale;
    this.labelOffset.x = sizePx / 2 + LABEL_GAP_PX;
    slot.label.pixelOffset = this.labelOffset;
    // Grouping outranks the port rule: a ship inside a badge shows nothing of its own.
    slot.label.show = !slot.grouped && (selected || slot.underWay);
  }

  /**
   * Point the hull along the reported course, or leave the square unpointed.
   *
   * `alignedAxis` rather than `rotation`, because a rotation is measured against the screen
   * and would be wrong the moment the camera is turned away from north.
   */
  private orient(slot: Slot): void {
    if (slot.courseDeg === null) {
      slot.mark.alignedAxis = Cartesian3.ZERO;
      return;
    }
    orientAxis(slot.fixLon, slot.fixLat, slot.courseDeg, scratchAxis);
    // The setter clones, so one scratch axis serves every vessel.
    slot.mark.alignedAxis = scratchAxis;
  }

  private place(slot: Slot, lon: number, lat: number): void {
    // Height 0: AIS carries no altitude and the contract guarantees `point.altitude_m` is
    // null on every vessel, so there is nothing to read.
    Cartesian3.fromDegrees(lon, lat, 0, undefined, scratch);
    // Both setters clone, so one scratch vector serves every vessel and the frame
    // allocates nothing.
    slot.mark.position = scratch;
    slot.label.position = scratch;
  }

  private acquire(mmsi: string): Slot {
    // A fresh primitive is positioned by the caller a few lines later; Cesium just needs
    // somewhere to start.
    const mark = this.freeMarks.pop() ?? this.marks.add({ position: Cartesian3.ZERO });
    const label = this.freeLabels.pop() ?? this.labels.add({ position: Cartesian3.ZERO });
    mark.show = true;
    mark.id = mmsi;
    // Centred on the fix in both axes, so the mark sits on the position rather than beside
    // it and a rotation turns it about the ship rather than about its bow.
    mark.horizontalOrigin = HorizontalOrigin.CENTER;
    mark.verticalOrigin = VerticalOrigin.CENTER;
    // The label carries the same id as its mark, because Cesium copies a label's id onto
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
    label.distanceDisplayCondition = new DistanceDisplayCondition(0, LABEL_VISIBLE_RANGE_M);

    const slot: Slot = {
      mark,
      label,
      fixLon: 0,
      fixLat: 0,
      courseDeg: null,
      speedMps: null,
      anchorMs: 0,
      underWay: false,
      colour: STOPPED_COLOUR,
      shape: 'block',
      cell: OFF_SCREEN,
      grouped: false,
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
    slot.grouped = false;
    slot.cell = OFF_SCREEN;
    slot.mark.show = false;
    slot.mark.id = undefined;
    slot.label.show = false;
    slot.label.id = undefined;
    slot.label.text = '';
    this.freeMarks.push(slot.mark);
    this.freeLabels.push(slot.label);
    this.slots.delete(mmsi);
    if (this.selectedId === mmsi) {
      this.selectedId = null;
    }
  }
}
