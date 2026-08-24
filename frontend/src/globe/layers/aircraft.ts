/**
 * The aircraft layer. This is the performance-critical file in the frontend.
 *
 * One `BillboardCollection` and one `LabelCollection`, both created once and then mutated
 * in place. Nothing here removes and re-adds a primitive on an update, and the Entity API
 * is not used at all: it collapses in the low thousands of movers and the target is 20,000.
 * Retired aircraft hand their primitives back to a free pool so the collections stop
 * growing without the collection itself churning.
 *
 * The mark is a silhouette rather than a dot, and it points where the aircraft is going.
 * Two consequences worth knowing before changing anything here.
 *
 * **The collection is translucent, where the old point collection was opaque.** An icon has
 * antialiased edges and transparent corners, and `BlendOption.OPAQUE` throws both away: the
 * transparent corners render as black squares. `TRANSLUCENT` is the narrowest option that
 * draws an image correctly, and it is narrower than Cesium's own default.
 *
 * **Orientation is a world-space axis, not a screen-space angle.** See `orientAxis` in
 * `../icons`. It is recomputed when a fix arrives and not while dead reckoning: two minutes
 * of extrapolation moves an aircraft about a quarter of a degree of arc, so the earth-fixed
 * direction it is pointing barely changes, and paying for it per frame would buy nothing
 * anybody can see.
 *
 * **Crowded marks become one badge that says how many.** See `../cluster`. Below about a pixel
 * of screen per aircraft, shrinking has run out of room and the only honest move left is to stop
 * drawing eleven hundred separate places and say "210" instead. Grouping is decided by screen
 * density rather than by altitude, so there is no threshold to cross: pull in and the groups
 * split until they are aircraft again. A grouped aircraft is hidden rather than dropped, and
 * `clusterState` reports both halves so the rail can never disagree with the globe.
 *
 * **The mark shrinks with camera distance, and it has to.** A size that lets one aircraft be
 * read at a city is the wrong size for a thousand of them seen from orbit, where the marks
 * stop being objects and become a stain over Europe that hides the continent under it. There
 * is no single number that serves both, so `SCALE_NEAR_M`/`SCALE_FAR_M` interpolate between
 * them. Cesium evaluates it in the vertex shader off an attribute set once per aircraft, so
 * it costs nothing per frame. The selected aircraft is deliberately exempt: see `emphasise`.
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

import { aircraftLabel, inEmergency } from '../../domain/derive';
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
import { advanceGreatCircle, pointInView } from '../project';
import type { ViewRect } from '../project';
import {
  CLASS_COLOURS,
  CLUSTER_ALERT_FILL,
  CLUSTER_ALERT_TEXT,
  CLUSTER_FILL,
  CLUSTER_TEXT,
  EMERGENCY_COLOUR,
  clusterBadgePx,
  clusterBadgeText,
  clusterFontPx,
  colourFor,
  iconSizeFor,
} from '../palette';
import type { Changes } from '../../net/ws';
import type { Aircraft, AircraftClass, LayerName } from '../../types/entities';

/** Labels are the most expensive tier, so they only exist within this range in metres. */
const LABEL_VISIBLE_RANGE_M = 400_000;

const LABEL_FONT = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Same near-white as the panel text, so a label reads as chrome and not as an entity. */
const LABEL_COLOUR = '#e6edf3';

/**
 * The camera range over which an aircraft mark shrinks, in metres, and how far it shrinks.
 *
 * Aircraft fly below about 13 km, so the distance from the camera to one is very close to the
 * camera's own height and this behaves as a zoom response. Full size from a city view;
 * `SCALE_FAR_FACTOR` of it from anywhere that frames a continent or the whole globe, where
 * about eleven pixels is what keeps a thousand of them from painting Europe solid.
 */
const SCALE_NEAR_M = 120_000;
const SCALE_FAR_M = 4_000_000;
const SCALE_FAR_FACTOR = 0.36;

/**
 * Gap in pixels between the edge of the mark and the start of the callsign.
 *
 * Measured off the mark's own size rather than fixed, so the selected mark's halo does not
 * end up with the text sitting on it. Seven, because five put the callsign touching the
 * outer edge of the halo at forty-eight pixels.
 */
const LABEL_GAP_PX = 7;

/**
 * What a slot holds before its first record lands on it.
 *
 * Never drawn: `acquire` is only ever called from `upsertOne`, which paints the real class
 * colour on the next line. It exists so the slot type has no nullable colour field.
 */
const CLASS_FALLBACK_COLOUR = colourFor('unknown', false);

/** Bold, because a count inside a badge is the one piece of text here that has to be read. */
const BADGE_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** A badge and the count drawn on it. Pooled like everything else in this file. */
interface Badge {
  mark: Billboard;
  label: Label;
  /** Which feed drew it, so the rail switch can hide it without parsing its pick id. */
  feed: LayerName | null;
}

/** What the layer holds for one aircraft. Kept flat: this is touched every frame. */
interface Slot {
  mark: Billboard;
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
  /** Held so a selection change can rebuild the mark without the record in hand. */
  colour: string;
  shape: IconShape;
  /** Grid cell from the last clustering pass, or `OFF_SCREEN`. */
  cell: number;
  /** Whether a badge is currently speaking for this aircraft instead of its own mark. */
  grouped: boolean;
}

const scratch = new Cartesian3();
const scratchAxis = new Cartesian3();
const scratchBadge = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchCarto = new Cartographic();

export class AircraftLayer {
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
  /**
   * How the mark shrinks with range, built once and shared.
   *
   * A field rather than a module constant, because constructing a Cesium type at module load
   * is a side effect in an imported module. The setter clones, so one instance serves every
   * aircraft.
   */
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
  /**
   * Layers the rail has switched off.
   *
   * Per layer rather than per collection: the civil feed and the military feed share one
   * `BillboardCollection`, so `collection.show` would hide both and a rail switch for
   * one of them would be a lie.
   */
  private readonly hiddenLayers = new Set<LayerName>();
  /** The scene, kept because every clustering pass needs its camera and its viewport. */
  private readonly scene: Scene;
  private readonly badges: BillboardCollection;
  private readonly badgeLabels: LabelCollection;
  private readonly badgePool: Badge[] = [];
  /**
   * One grid per feed, because the rail switches the feeds independently.
   *
   * A group spanning the civil feed and the military feed could not be hidden by either switch
   * without lying about the other, and its badge would claim a count that changed meaning
   * depending on which switches were on.
   */
  private readonly grids = new Map<LayerName, ScreenClusterer>();
  /** Feeds this layer has ever held, so a pass knows which grids to run. */
  private readonly feeds = new Set<LayerName>();
  /** Cells holding an aircraft in distress, rebuilt each pass. Usually empty. */
  private readonly alertCells = new Set<number>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.rangeScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, SCALE_FAR_FACTOR);
    this.fixedScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, 1);
    this.marks = new BillboardCollection({
      scene,
      // Icons have antialiased edges and transparent corners, so they have to go through
      // the translucent pass. This is still narrower than Cesium's default, which pays for
      // both passes.
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
    // Badges after the marks, and their counts last of all, so a count is never drawn under the
    // badge it belongs to.
    scene.primitives.add(this.badges);
    scene.primitives.add(this.badgeLabels);
    // `preUpdate` rather than a frame loop of its own: this reacts to frames that are already
    // happening and never asks for one, so render policy stays where it belongs in `viewer.ts`.
    // Clustering depends on where the camera is, so it cannot be driven by a fix arriving.
    scene.preUpdate.addEventListener(() => {
      this.recluster();
    });
  }

  get count(): number {
    return this.slots.size;
  }

  /**
   * How many of one feed's aircraft are inside the current view.
   *
   * The honest answer to "why is my screen empty". A layer can be live, healthy and
   * reporting hundreds of aircraft while none of them is anywhere near where the camera is
   * pointing, and a rail row showing only the total says nothing about that. Counted off the
   * last reported fix rather than the extrapolated position: an aircraft a few hundred
   * metres from the edge of the screen is not a distinction worth a per-frame recount.
   *
   * Hidden layers are counted too. A layer switched off is empty for a reason the user
   * chose, and reporting nothing in view for it would be a second explanation for the same
   * thing.
   */
  countInView(view: ViewRect, layer: LayerName): number {
    let inside = 0;
    for (const slot of this.slots.values()) {
      if (slot.layer === layer && pointInView(view, slot.fixLon, slot.fixLat)) {
        inside += 1;
      }
    }
    return inside;
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
    this.feeds.add(layer);
    slot.fixLon = record.point.lon;
    slot.fixLat = record.point.lat;
    slot.heightM = record.point.altitude_m ?? 0;
    slot.trackDeg = record.track_deg ?? null;
    slot.speedMps = record.on_ground ? 0 : (record.ground_speed_mps ?? null);
    slot.anchorMs = nowMs;
    slot.moving = slot.trackDeg !== null && slot.speedMps !== null && slot.speedMps > 0;
    // An aircraft with no reported track is drawn as a circle, not as an aircraft pointing
    // north. The feed publishes a track on nearly every record, so this is the exception
    // rather than the rule, but a silhouette aimed at a bearing nobody measured is a
    // fabricated fact and looks exactly like a real one.
    slot.shape = slot.trackDeg === null ? 'disc' : 'plane';

    this.paint(record.icao24, slot, record.aircraft_class, inEmergency(record));
    this.orient(slot);
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
   *
   * The orientation is deliberately left alone. It is an earth-fixed direction, and the
   * furthest dead reckoning ever carries an aircraft is a fraction of a degree of arc, so
   * recomputing it here would cost a walk over every mover per frame to change nothing
   * visible.
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
    if (!visible) {
      badgeSlots.release(layer);
    }
    if (visible) {
      this.hiddenLayers.delete(layer);
    } else {
      this.hiddenLayers.add(layer);
    }
    for (const slot of this.slots.values()) {
      if (slot.layer !== layer) {
        continue;
      }
      // A grouped aircraft stays hidden when its feed is switched back on: its badge is what is
      // drawn for it, and un-hiding it here would draw both until the next camera movement.
      const shown = visible && !slot.grouped;
      slot.mark.show = shown;
      slot.label.show = shown;
    }
    for (const badge of this.badgePool) {
      if (badge.feed !== layer) {
        continue;
      }

      badge.mark.show = visible;
      badge.label.show = visible;
    }
  }

  /**
   * Regroup every feed against where the camera is now.
   *
   * Public because `preUpdate` is not a seam a test can stand on: driving this directly is what
   * lets the grouping rules be asserted without a WebGL context or a real camera.
   *
   * Two passes per feed and no allocation in either. The first projects every aircraft and bins
   * it; the second reads back which cells came out crowded. `show` is only written when it
   * actually changes, which is what keeps a still camera free and a moving one paying only for
   * the aircraft that crossed a boundary.
   */
  recluster(): void {
    const camera = this.scene.camera;
    Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, scratchMatrix);
    const eye = camera.positionWC;
    const width = this.scene.drawingBufferWidth;
    const height = this.scene.drawingBufferHeight;
    badgeSlots.begin(width, height, CLUSTER_CELL_PX);
    let badgesUsed = 0;
    for (const feed of this.feeds) {
      badgesUsed = this.reclusterFeed(feed, eye, width, height, badgesUsed);
    }
    for (let index = badgesUsed; index < this.badgePool.length; index += 1) {
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
   * Regroup one feed. Returns how many badges have been used across the whole pass so far.
   *
   * Its own method rather than a nested loop, because the two walks over the slot map both skip
   * the other feed's aircraft and a `continue` inside a loop inside a loop is the kind of thing
   * that reads fine and then quietly skips the wrong level.
   */
  private reclusterFeed(
    feed: LayerName,
    eye: Cartesian3,
    width: number,
    height: number,
    badgesUsed: number,
  ): number {
    badgeSlots.release(feed);
    const grid = this.gridFor(feed);
    grid.begin(width, height);
    for (const slot of this.slots.values()) {
      if (slot.layer !== feed) {
        continue;
      }

      const at = slot.mark.position;
      slot.cell = grid.offer(scratchMatrix, eye.x, eye.y, eye.z, at.x, at.y, at.z);
    }
    grid.resolve();
    const hidden = this.hiddenLayers.has(feed);
    this.alertCells.clear();
    for (const slot of this.slots.values()) {
      if (slot.layer !== feed) {
        continue;
      }
      const grouped = grid.grouped(slot.cell);
      if (grouped && slot.inEmergency) {
        this.alertCells.add(slot.cell);
      }
      if (slot.grouped !== grouped) {
        slot.grouped = grouped;
        const shown = !hidden && !grouped;
        slot.mark.show = shown;
        slot.label.show = shown;
      }
    }
    // A switched-off feed is still grouped and still counted, exactly as `countInView` still
    // counts it, but nothing of it is drawn.
    if (hidden) {
      return badgesUsed;
    }
    let used = badgesUsed;
    for (const mark of grid.marks()) {
      used = this.drawBadge(feed, mark, used);
    }
    return used;
  }

  /**
   * What one feed's grouping came to, for the rail.
   *
   * `onScreen === individuals + inGroups` always holds. That is the invariant that stops
   * clustering turning a count into a lie: every aircraft the camera can see is either drawn as
   * itself or inside exactly one badge, and both numbers are published.
   */
  clusterState(layer: LayerName): ClusterState {
    return (
      this.grids.get(layer)?.state ?? {
        onScreen: 0,
        individuals: 0,
        groups: 0,
        inGroups: 0,
        largestGroup: 0,
      }
    );
  }

  /**
   * Where to take the camera for a picked badge, or null when the id was not one of ours.
   *
   * A badge opens no card, because a card for two hundred aircraft is not a card. It answers the
   * only question a group can answer, which is "what is in there", and it answers it by taking
   * the camera close enough for the group to become aircraft again.
   *
   * Null also covers a stale id: cells are numbered per pass, so a badge that has since
   * dissolved resolves to nothing rather than to whatever is now in that cell.
   */
  clusterFlyTo(pickId: string | null): ClusterFlyTo | null {
    const parsed = parseClusterPickId(pickId);
    if (parsed === null) {
      return null;
    }
    const mark = this.grids.get(parsed.layerKey as LayerName)?.markFor(parsed.cellId) ?? null;
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

  /** Highlight one aircraft, or none. Selection is a halo, never a hue change. */
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

  private gridFor(feed: LayerName): ScreenClusterer {
    const held = this.grids.get(feed);
    if (held !== undefined) {
      return held;
    }
    const made = new ScreenClusterer();
    this.grids.set(feed, made);
    return made;
  }

  /**
   * Draw one badge, taking the next one out of the pool.
   *
   * A group holding an aircraft in distress is drawn in the alert colour with the text inverted.
   * Red is reserved for alerts across the whole app, and a group that swallowed one silently
   * would be the single case where clustering hid something that mattered.
   */
  private drawBadge(feed: LayerName, mark: ClusterMark, used: number): number {
    const alert = this.alertCells.has(mark.cellId);
    const sizePx = clusterBadgePx(mark.count);
    const badge = this.badgePool[used] ?? this.acquireBadge();
    badge.feed = feed;
    badge.mark.show = true;
    badge.mark.id = clusterPickId(feed, mark.cellId);
    badge.mark.image = clusterBadgeImage(
      sizePx,
      alert ? CLUSTER_ALERT_FILL : CLUSTER_FILL,
      feed === 'military' ? CLASS_COLOURS.military : CLASS_COLOURS.unknown,
    );
    badge.mark.width = sizePx;
    badge.mark.height = sizePx;
    scratchBadge.x = mark.x;
    scratchBadge.y = mark.y;
    scratchBadge.z = mark.z;
    // Both setters clone, so one scratch vector serves every badge in the pass.
    badge.mark.position = scratchBadge;
    badge.label.show = true;
    badge.label.text = clusterBadgeText(mark.count);
    badge.label.font = `700 ${clusterFontPx(mark.count)}px ${BADGE_FONT_FAMILY}`;
    badge.label.fillColor = cesiumColour(alert ? CLUSTER_ALERT_TEXT : CLUSTER_TEXT);
    badge.label.position = scratchBadge;
    // Drawn on a lattice point rather than on the member it hangs from. Its own cell's centre when
    // that is free, which is what keeps two badges of this layer apart, and the nearest free point
    // otherwise, which is what keeps it from landing exactly on another layer's badge. See
    // `ClusterMark.nudgeX` and `badge-slots.ts`.
    const slot = badgeSlots.claim(feed, mark.centreX, mark.centreY, this.badgeSlot);
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
    // Fill only. The badge behind the digits is their contrast, so an outline would only thicken
    // them, and at fourteen pixels a thickened digit is a smudge.
    label.style = LabelStyle.FILL;
    const badge: Badge = { mark, label, feed: null };
    this.badgePool.push(badge);
    return badge;
  }

  private paint(id: string, slot: Slot, aircraftClass: AircraftClass, inEmergency: boolean): void {
    slot.inEmergency = inEmergency;
    slot.colour = colourFor(aircraftClass, inEmergency);
    slot.label.fillColor = cesiumColour(inEmergency ? EMERGENCY_COLOUR : LABEL_COLOUR);
    this.emphasise(slot, id === this.selectedId);
  }

  /**
   * Choose the image and the size, which together carry class, emergency and selection.
   *
   * All three end up in one texture because a Cesium billboard tint multiplies the image,
   * and under a multiply only black comes out unchanged: a white selection halo baked into
   * a tinted texture would be drawn in the aircraft's own hue. `iconImage` remembers each
   * combination, so this assigns the same string every time and Cesium's setter returns
   * early rather than touching the texture atlas.
   *
   * Selection does not dress an emergency down. The red fill and the enlarged mark both
   * survive, and the halo is added on top of them.
   *
   * The selected aircraft is the one thing here that does not shrink with range. There is at
   * most one of it, so it costs the picture nothing, and the whole job of a selection is to
   * be findable: a halo that faded away with distance would fail at exactly the zoom where
   * you most need to be told which of a thousand marks you just clicked.
   */
  private emphasise(slot: Slot, selected: boolean): void {
    const sizePx = iconSizeFor(slot.inEmergency, selected);
    slot.mark.image = iconImage(slot.shape, slot.colour, selected, sizePx);
    slot.mark.width = sizePx;
    slot.mark.height = sizePx;
    slot.mark.scaleByDistance = selected ? this.fixedScale : this.rangeScale;
    this.labelOffset.x = sizePx / 2 + LABEL_GAP_PX;
    slot.label.pixelOffset = this.labelOffset;
  }

  /**
   * Point the mark along the reported track, or leave it unpointed.
   *
   * `alignedAxis` rather than `rotation`, because a rotation is measured against the screen
   * and would be wrong the moment the camera is turned away from north.
   */
  private orient(slot: Slot): void {
    if (slot.trackDeg === null) {
      slot.mark.alignedAxis = Cartesian3.ZERO;
      return;
    }
    orientAxis(slot.fixLon, slot.fixLat, slot.trackDeg, scratchAxis);
    // The setter clones, so one scratch axis serves every aircraft.
    slot.mark.alignedAxis = scratchAxis;
  }

  private place(slot: Slot, lon: number, lat: number): void {
    Cartesian3.fromDegrees(lon, lat, slot.heightM, undefined, scratch);
    // Both setters clone, so one scratch vector serves every aircraft and the frame
    // allocates nothing.
    slot.mark.position = scratch;
    slot.label.position = scratch;
  }

  private acquire(id: string, layer: LayerName): Slot {
    // A fresh primitive is positioned by the caller a few lines later; Cesium just needs
    // somewhere to start.
    const mark = this.freeMarks.pop() ?? this.marks.add({ position: Cartesian3.ZERO });
    const label = this.freeLabels.pop() ?? this.labels.add({ position: Cartesian3.ZERO });
    const shown = !this.hiddenLayers.has(layer);
    mark.show = shown;
    mark.id = id;
    // Centred on the fix in both axes, so the mark sits on the position rather than beside
    // it and a rotation turns it about the aircraft rather than about its wingtip.
    mark.horizontalOrigin = HorizontalOrigin.CENTER;
    mark.verticalOrigin = VerticalOrigin.CENTER;
    // The label needs the same id as its mark. Cesium copies a label's id onto the glyph
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
    label.distanceDisplayCondition = new DistanceDisplayCondition(0, LABEL_VISIBLE_RANGE_M);

    const slot: Slot = {
      mark,
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
      colour: CLASS_FALLBACK_COLOUR,
      shape: 'disc',
      cell: OFF_SCREEN,
      grouped: false,
    };
    this.feeds.add(layer);
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
    slot.grouped = false;
    slot.cell = OFF_SCREEN;
    slot.mark.show = false;
    slot.mark.id = undefined;
    slot.label.show = false;
    slot.label.id = undefined;
    slot.label.text = '';
    this.freeMarks.push(slot.mark);
    this.freeLabels.push(slot.label);
    this.slots.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
    }
  }
}
