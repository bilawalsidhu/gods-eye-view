/**
 * The satellite layer.
 *
 * One `BillboardCollection` and one `PolylineCollection`, both built once and mutated in
 * place, exactly as `layers/aircraft.ts` does and for the same reason: the Entity API
 * collapses in the low thousands of movers and the target here is the whole active
 * catalogue, 10,000-plus objects. Retired satellites hand their primitives back to a free
 * pool, so a pass in and out of the element cache does not force Cesium to rebuild its
 * vertex buffers.
 *
 * **This layer draws the most objects and shows the least of each one, and that ordering is
 * deliberate.** About 700 satellites on a normal run, spread right around the globe rather
 * than gathered over the places people live, so a whole-globe view holds every single one of
 * them at once. It is the only layer that can hide the planet, so it gets the smallest mark,
 * the plainest shape and the hardest shrink with range. An earlier version drew a four-point
 * star at twenty pixels and the result was a lattice of cyan spikes with the continents
 * somewhere behind it.
 *
 * Three things keep it cheap. Its mark is one image for the whole layer, so there is exactly
 * one texture atlas entry and every billboard after the first is an early return in Cesium's
 * own setter. The mark points nowhere, so nothing here computes an orientation: a propagated
 * element set carries no attitude, and a satellite drawn pointing somewhere would be inventing
 * a fact as well as paying for it. And the shrink is a vertex-shader attribute written once
 * per satellite, so range costs nothing per frame.
 *
 * **Grouping applies here too, and mostly does not fire.** The same screen-density rule as the
 * other two layers runs over this one, per `../cluster`, and that is the honest way to include
 * it: 700 objects spread right around the globe are rarely three-to-a-cell, so a whole-globe view
 * leaves the shell as a shell. Where they do pile up, which is against the limb where the shell
 * projects edge-on, a badge appears and says how many. Density decides rather than a threshold,
 * so nothing had to be tuned to get that.
 *
 * A plain `PointPrimitive` was weighed against this and not taken. It would be marginally
 * cheaper, but the measurement says the cost here is already unmeasurable against vsync, and a
 * round dot is the one mark that cannot be told from the aircraft layer's own no-track
 * fallback. The diamond is what buys the layer its identity for that nothing.
 *
 * Positions arrive already propagated, as flat typed arrays off the worker. Nothing in this
 * file does any orbital maths, and nothing in it holds a `Date`.
 *
 * The polyline collection holds exactly one polyline, ever: the orbit trail of the current
 * selection. A trail per satellite would cost more than every mark on the globe put
 * together and would draw a ball of wool.
 */

import {
  BillboardCollection,
  Cartesian2,
  BlendOption,
  Cartesian3,
  Cartographic,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Material,
  Matrix4,
  NearFarScalar,
  PolylineCollection,
  VerticalOrigin,
} from 'cesium';
import type { Billboard, Label, Polyline, Scene } from 'cesium';

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
import { clusterBadgeImage, iconImage } from '../icons';
import {
  CLUSTER_FILL,
  CLUSTER_TEXT,
  clusterBadgePx,
  clusterBadgeText,
  clusterFontPx,
} from '../palette';

/**
 * One hue for the whole layer.
 *
 * Pale cyan: distinct from the aircraft class hues, and nowhere near the red and orange the
 * palette reserves for alert states. There is no per-satellite classification in phase 2, so
 * a second colour here would encode nothing.
 */
export const SATELLITE_COLOUR = '#7fe3ff';

/**
 * Satellite mark size in pixels, at the range a satellite is actually looked at from.
 *
 * The smallest mark in the app, because this is the layer that can hide the globe, and a
 * diamond survives being small better than a silhouette with detail in it does. Eighteen is
 * the floor set by the casing rather than a round number: below it the black edge drops under
 * a pixel and the mark stops holding its shape against bright cloud. See `casingPixels`.
 */
export const SATELLITE_ICON_PX = 18;

/** The selected satellite, which is at most one. Doubles, and gains the halo. */
export const SATELLITE_SELECTED_ICON_PX = 36;

/**
 * The camera range over which a satellite mark shrinks, in metres, and how far it shrinks.
 *
 * The near figure is 600 km rather than the tens of kilometres the other two layers use,
 * because a satellite is hundreds of kilometres up and is never close to the camera in the way
 * an aircraft is. Full size is therefore reserved for one nearly overhead at a low zoom;
 * anything framing a continent or the whole globe puts every object past `SCALE_FAR_M` and
 * draws the whole catalogue at about seven pixels. That is where the shell reads as a shell and
 * the continents read through it.
 */
const SCALE_NEAR_M = 600_000;
const SCALE_FAR_M = 12_000_000;
const SCALE_FAR_FACTOR = 0.38;

/** The trail is the same hue, thin, so the mark stays the thing being read. */
export const ORBIT_TRAIL_WIDTH = 1.5;

/**
 * The two images this layer ever draws, built once each.
 *
 * Module constants rather than fields, unlike the Cesium colours they replace: `iconImage`
 * returns a plain string and touches nothing in the renderer, so there is no side effect to
 * defer. The strings are the atlas keys, so holding them here is also what guarantees the
 * whole layer shares one entry.
 */
const SATELLITE_IMAGE = iconImage('diamond', SATELLITE_COLOUR, false, SATELLITE_ICON_PX);
const SATELLITE_SELECTED_IMAGE = iconImage(
  'diamond',
  SATELLITE_COLOUR,
  true,
  SATELLITE_SELECTED_ICON_PX,
);

/**
 * Prefix on the id stamped onto every satellite primitive.
 *
 * Picking returns whatever `id` the primitive carries and the aircraft layer stamps a bare
 * six-hex ICAO address, so a bare catalogue number could be read as an aircraft. The prefix
 * is what keeps one click routing to one layer.
 */
export const SATELLITE_PICK_PREFIX = 'satellite:';

/**
 * The catalogue number in a picked id, or null when the pick was not a satellite.
 *
 * The `> 0` is doing real work, and `geonamesFromPickId` in `./cities` is where the pattern
 * comes from. `Number('')` is 0 and `Number.isSafeInteger(0)` is true, so a bare
 * `satellite:` with nothing after it used to resolve to catalogue number 0 and read as a
 * lookup that quietly finds nothing, rather than as "that was not a satellite". Catalogue
 * numbers start at 1, so anything at or below zero is a malformed id and says so.
 */
export function noradFromPickId(id: string | null): number | null {
  if (!id?.startsWith(SATELLITE_PICK_PREFIX)) {
    return null;
  }
  const parsed = Number(id.slice(SATELLITE_PICK_PREFIX.length));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * How many satellites must share a cell before they become a group. Thirty: the highest in the app.
 *
 * Measured rather than chosen. At the default of ten, a whole-globe view turned the shell into
 * about forty badges: the shell projects edge-on against the limb, so cells there fill up even
 * though the objects are nowhere near each other in space. That was strictly worse than the shell
 * it replaced, because seven-pixel diamonds already let the globe through and a badge does not.
 * This is the one layer where grouping has to earn its place against something that was already
 * working, so it only fires on a pile nobody could have read anyway.
 */
export const SATELLITE_CLUSTER_MIN = 30;

/** The key a satellite badge's pick id carries. */
export const SATELLITE_CLUSTER_KEY = 'satellites';

const BADGE_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** A badge and the count drawn on it. Pooled like everything else in this file. */
interface Badge {
  mark: Billboard;
  label: Label;
}

interface Slot {
  mark: Billboard;
  /**
   * The tick this slot was last written by.
   *
   * A generation counter rather than a `Set` of the ids present, because unlike the aircraft
   * feed every tick here is a full replacement and building a set of a thousand numbers per
   * frame is an allocation the frame does not need.
   */
  seen: number;
  /** Grid cell from the last clustering pass, or `OFF_SCREEN`. */
  cell: number;
  /** Whether a badge is currently speaking for this satellite instead of its own mark. */
  grouped: boolean;
}

const scratch = new Cartesian3();
const scratchBadge = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchCarto = new Cartographic();

export class SatelliteLayer {
  private readonly marks: BillboardCollection;
  private readonly trails: PolylineCollection;
  private readonly trail: Polyline;
  /** Reused for the badge nudge, which changes on every clustering pass. */
  private readonly badgeOffset = new Cartesian2(0, 0);
  /** Reused for the slot the shared lattice grants. Plain numbers, never a Cesium type. */
  private readonly badgeSlot: BadgeSlot = { x: 0, y: 0 };
  private readonly slots = new Map<number, Slot>();
  private readonly free: Billboard[] = [];
  /**
   * The layer hue as a Cesium colour, parsed once, for the orbit trail.
   *
   * A field rather than a module constant, because parsing a CSS colour at module load is a
   * side effect in an imported module. Only the trail needs it now: the marks carry their
   * colour inside their own image.
   */
  private readonly trailColour: Color;
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
  private selectedId: number | null = null;
  private generation = 0;
  /** The scene, kept because every clustering pass needs its camera and its viewport. */
  private readonly scene: Scene;
  private readonly badges: BillboardCollection;
  private readonly badgeLabels: LabelCollection;
  private readonly badgePool: Badge[] = [];
  /** See `SATELLITE_CLUSTER_MIN`. */
  private readonly grid = new ScreenClusterer(CLUSTER_CELL_PX, SATELLITE_CLUSTER_MIN);

  constructor(scene: Scene) {
    this.scene = scene;
    this.trailColour = Color.fromCssColorString(SATELLITE_COLOUR);
    this.rangeScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, SCALE_FAR_FACTOR);
    this.fixedScale = new NearFarScalar(SCALE_NEAR_M, 1, SCALE_FAR_M, 1);
    this.marks = new BillboardCollection({
      scene,
      // An icon has antialiased edges and transparent corners, so it has to go through the
      // translucent pass; `OPAQUE` would draw those corners as black squares. Still narrower
      // than Cesium's default, which pays for both passes.
      blendOption: BlendOption.TRANSLUCENT,
    });
    this.trails = new PolylineCollection();
    this.trail = this.trails.add({
      // Two positions because a polyline needs at least two; it is hidden until a selection
      // supplies a real orbit, and it is never removed and re-added.
      positions: [Cartesian3.ZERO, Cartesian3.ZERO],
      width: ORBIT_TRAIL_WIDTH,
      material: Material.fromType('Color', { color: this.trailColour.withAlpha(0.55) }),
      show: false,
    });
    this.badges = new BillboardCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    // `BlendOption.TRANSLUCENT` on the counts, not the default. The badges are translucent,
    // and Cesium draws every translucent command after every opaque one whatever order the
    // primitives were added in, so a count left on the default blend went into the opaque
    // pass and its own badge was then painted straight over it. Measured 2026-08-23: every
    // badge on the globe rendered as an empty hexagon, and the counts came back the moment
    // both collections shared a pass and primitive order could decide.
    this.badgeLabels = new LabelCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    scene.primitives.add(this.marks);
    scene.primitives.add(this.trails);
    // Badges after the marks, counts last, so a count is never drawn under its own badge.
    scene.primitives.add(this.badges);
    scene.primitives.add(this.badgeLabels);
    // `preUpdate` rather than a loop of its own: this reacts to frames that are already
    // happening and never asks for one, so render policy stays in `viewer.ts`.
    scene.preUpdate.addEventListener(() => {
      this.recluster();
    });
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
      slot.mark.position = scratch;
    }
    for (const [noradCatId, slot] of this.slots) {
      if (slot.seen !== this.generation) {
        this.release(noradCatId, slot);
      }
    }
  }

  /** Switch the whole layer off from the rail. Collection-level, so it costs one flag. */
  setVisible(visible: boolean): void {
    this.marks.show = visible;
    this.trails.show = visible;
    this.badges.show = visible;
    this.badgeLabels.show = visible;
  }

  /**
   * Regroup against where the camera is now.
   *
   * Public because `preUpdate` is not a seam a test can stand on. Mostly a no-op in practice: the
   * catalogue is spread over the whole globe, so cells rarely hold three, and a shell that reads
   * as a shell is left alone. `show` is only written when it changes, so the common case of
   * nothing grouping costs one projection per satellite and no buffer writes at all.
   */
  recluster(): void {
    badgeSlots.begin(
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      CLUSTER_CELL_PX,
    );
    badgeSlots.release(SATELLITE_CLUSTER_KEY);
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

  /**
   * Where to take the camera for a picked badge, or null when the id was not one of ours.
   *
   * Null also covers a stale id: cells are numbered per pass, so a badge that has dissolved
   * resolves to nothing rather than to whatever now sits in that cell.
   */
  clusterFlyTo(pickId: string | null): ClusterFlyTo | null {
    const parsed = parseClusterPickId(pickId);
    if (parsed?.layerKey !== SATELLITE_CLUSTER_KEY) {
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

  /** Highlight one satellite, or none. Selection is a halo and a size, never a new hue. */
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
        this.emphasise(slot.mark, changed === this.selectedId);
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

  private drawBadge(mark: ClusterMark, used: number): number {
    const sizePx = clusterBadgePx(mark.count);
    const badge = this.badgePool[used] ?? this.acquireBadge();
    badge.mark.show = true;
    badge.mark.id = clusterPickId(SATELLITE_CLUSTER_KEY, mark.cellId);
    badge.mark.image = clusterBadgeImage(sizePx, CLUSTER_FILL, SATELLITE_COLOUR);
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
    badge.label.position = scratchBadge;
    // Drawn on a lattice point rather than on the member it hangs from. Its own cell's centre when
    // that is free, which is what keeps two badges of this layer apart, and the nearest free point
    // otherwise, which is what keeps it from landing exactly on another layer's badge. See
    // `ClusterMark.nudgeX` and `badge-slots.ts`.
    const slot = badgeSlots.claim(
      SATELLITE_CLUSTER_KEY,
      mark.centreX,
      mark.centreY,
      this.badgeSlot,
    );
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
    label.style = LabelStyle.FILL;
    label.fillColor = cesiumColour(CLUSTER_TEXT);
    const badge: Badge = { mark, label };
    this.badgePool.push(badge);
    return badge;
  }

  private acquire(noradCatId: number): Slot {
    const mark = this.free.pop() ?? this.marks.add({ position: Cartesian3.ZERO });
    mark.show = true;
    // Grouping is recomputed on the next camera frame, so a freshly acquired mark starts drawn.
    mark.id = `${SATELLITE_PICK_PREFIX}${noradCatId}`;
    // Centred on the position rather than hanging off one corner of it, which for a mark
    // this small is the difference between a satellite on its orbit and one beside it.
    mark.horizontalOrigin = HorizontalOrigin.CENTER;
    mark.verticalOrigin = VerticalOrigin.CENTER;
    this.emphasise(mark, noradCatId === this.selectedId);
    const slot: Slot = { mark, seen: this.generation, cell: OFF_SCREEN, grouped: false };
    this.slots.set(noradCatId, slot);
    return slot;
  }

  private release(noradCatId: number, slot: Slot): void {
    slot.grouped = false;
    slot.cell = OFF_SCREEN;
    slot.mark.show = false;
    slot.mark.id = undefined;
    this.free.push(slot.mark);
    this.slots.delete(noradCatId);
    if (this.selectedId === noradCatId) {
      this.selectedId = null;
      this.trail.show = false;
    }
  }

  /**
   * Image and size, which together carry the selection.
   *
   * Two module-level strings, so the whole catalogue shares one atlas entry and the selected
   * satellite a second. Assigning the same string is an early return inside Cesium, which is
   * what makes this safe to call on every acquire in a ten-thousand-object tick.
   *
   * The selected satellite alone keeps its full size at any range. There is one of it, so it
   * costs the picture nothing, and it is the only mark in this layer anybody is trying to
   * find rather than see the shape of.
   */
  private emphasise(mark: Billboard, selected: boolean): void {
    const sizePx = selected ? SATELLITE_SELECTED_ICON_PX : SATELLITE_ICON_PX;
    mark.image = selected ? SATELLITE_SELECTED_IMAGE : SATELLITE_IMAGE;
    mark.width = sizePx;
    mark.height = sizePx;
    mark.scaleByDistance = selected ? this.fixedScale : this.rangeScale;
  }
}
