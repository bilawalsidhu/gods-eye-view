/**
 * The social post layer: Wikimedia Commons photographs and Mastodon posts.
 *
 * **Read ADR 005 before changing anything here.** This layer is the one in the project most able to
 * turn it into something nobody would want to demo, and the render is where its central rule either
 * holds or quietly stops holding.
 *
 * **A post is not a mover.** It is an event with a timestamp and no motion, so `advance` returns
 * false and there is no dead reckoning anywhere in this file. On the transit layer that was a
 * judgement about buses; here it is absolute. Two posts joined to the same profile are two dated
 * points, which is evidence, and the line between them is not, so this layer draws no line. That is
 * ADR 005's own wording and it is why there is no polyline collection here.
 *
 * **`location_basis` decides the mark, and the two must never be confusable.** A post whose source
 * supplied the coordinate is drawn as a pin: a tip on one exact point, which is a true claim about a
 * Commons photograph *of* a place. A post whose position we worked out from its words is drawn as a
 * hollow ring: no tip, no centre, meaning somewhere in this. A city-level gazetteer match rendered
 * as a point is precisely the presentation ADR 005 exists to forbid, and a filled mark with a
 * centre is that presentation. So the difference is carried by outline, which is the strongest
 * channel available, rather than by a hue or a label that a viewer has to look up.
 *
 * The basis is read through `isObservedPosition` rather than by comparing the string. That mirrors
 * the property of the same name on the contract, which exists, in its own words, because "a consumer
 * comparing against the string literal itself is one typo away from treating a guess as a fix".
 *
 * **Media is not drawn here at all.** ADR 005 has it proxied, cached and licence-checked, and
 * Mastodon carries no rights field anywhere so its media is dropped upstream and that half of the
 * layer is text. Nothing in this file fetches an image; the card is where media belongs, and the
 * proxy is somebody else's. See `proxiedMediaUrl`.
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
import { areaRingImage, iconImage, pinTipOffsetPx } from '../icons';
import { pointInView } from '../project';
import type { ViewRect } from '../project';
import type { SocialPost } from '../../types/entities';
import { SOCIAL_COLOUR } from '../palette';

/**
 * The one route to a post's media, so nothing in the app can hot-link by accident.
 *
 * `src/tracker/api/routes_media.py` already settles the shape: `GET /api/media?url=<provider url>`,
 * with an allowlist of one host, a disk cache keyed by URL hash, a magic-byte check on the body and
 * a removal path. So this is not a shape being proposed, it is the existing endpoint being named in
 * one place. Nothing in this file fetches media, because media belongs on the card, but the helper
 * lives with the layer that decides a post's identity so a caller never has to build the path.
 *
 * ADR 005 forbids hot-linking, and what makes a hot-link is the browser fetching from the provider,
 * not the provider's URL appearing in a query string. This returns a URL on our own origin, which is
 * the thing that matters.
 */
export const MEDIA_PROXY_PATH = '/api/media';

/** Build the proxied URL for one provider media item. Never pass a provider URL to an `img` tag. */
export function proxiedMediaUrl(providerUrl: string): string {
  return `${MEDIA_PROXY_PATH}?url=${encodeURIComponent(providerUrl)}`;
}

/**
 * The slot key: the source and the post's own id, joined by a tab.
 *
 * Compound for the same reason the transit key is. `post_id` is whatever the provider calls it, and
 * a Commons page id and a Mastodon status id are different namespaces that will collide sooner or
 * later. A tab because both halves are provider-supplied strings and any printable separator could
 * appear inside one.
 */
export function socialKey(post: Pick<SocialPost, 'source' | 'post_id'>): string {
  return `${post.source}\t${post.post_id}`;
}

/**
 * Whether the coordinate was reported rather than worked out.
 *
 * Mirrors the property of the same name on `contracts/social.py`, which is a Python `@property` and
 * so is never serialised. Duplicated here for the reason the contract gives itself: this is the
 * question every consumer actually wants to ask, and one comparing the string literal is a typo
 * away from treating a guess as a fix. Keep it trivial and keep it tested.
 */
export function isObservedPosition(post: Pick<SocialPost, 'location_basis'>): boolean {
  return post.location_basis === 'upstream';
}

/** The key a social badge's pick id carries. */
export const SOCIAL_CLUSTER_KEY = 'social';

/**
 * How many posts must share a cell before they become a group. Two, the lowest possible.
 *
 * Measured 2026-08-24 against 2,450 real London posts and 2,256 real Manhattan posts, through a real
 * camera at six altitudes, testing minimums of 2, 3, 4, 6, 10 and 15. The number is not a taste
 * judgement and the measurement reversed an earlier choice of four.
 *
 * **A cell is already the separability test, so a second margin on top of it only buys overlap.** At
 * a minimum of two, every post still drawn as its own mark is provably alone in its cell, because any
 * cell holding two became a badge. Raise the minimum and every extra mark it creates is one sharing a
 * cell with another mark: at four, 94 of Manhattan's 131 individual marks overlapped another at an
 * 8km view, and at fifteen, 408 of 445 did. Overlapping marks read as fewer posts than there are,
 * with nothing on screen saying so, where a badge states its count.
 *
 * Three things all point the same way, which is why this is not a close call.
 *
 * It is **fewer elements**, which is the standing instruction. Manhattan at 8km draws 172 things at a
 * minimum of two and 227 at four. It **recovers nothing** by waiting: the count of posts hidden in a
 * badge that covers more ground than one cell is flat across every candidate, 336 against 331 on the
 * same view, so a higher minimum does not rescue separable posts. And it is the only setting that
 * **cannot break ADR 005**: two overlapping marks show the viewer whichever drew last, so a pin
 * painted over a ring presents a worked-out location as a reported one, by accident, which is the one
 * outcome this layer exists to prevent. A badge says nothing about basis and claims nothing.
 *
 * The cost is real and is accepted. At a city view almost everything is a badge, so the pin and the
 * ring are not on screen until the camera comes in. That is the honest state of the data: Manhattan
 * holds thousands of photographs within a few blocks, and drawing them as marks would show a
 * fraction of them and no sign of the rest.
 */
export const SOCIAL_CLUSTER_MIN = 2;

/**
 * Post mark size in pixels.
 *
 * The largest mark in the app, and the only one that is not a compromise with density. This layer is
 * inherently small: Commons geosearch is capped at 500 results per query over a 10km radius, so a
 * viewport holds hundreds at most where transit holds ten thousand. Posts are also the thing
 * Alexander Fanthome asked to see rather than context around it, so they are allowed to be the
 * loudest thing on a city view.
 */
export const SOCIAL_ICON_PX = 26;

/** The selected post, which is at most one. Gains the halo. */
export const SELECTED_SOCIAL_ICON_PX = 46;

/**
 * The camera range over which a post mark shrinks, in metres, and how far it shrinks.
 *
 * Gentler than any mover layer's, because posts are sparse and are the subject rather than the
 * backdrop: at a continental view a handful of posts should still be findable, where a thousand
 * aircraft should recede.
 *
 * The factor is set by the ring rather than chosen, and it was measured rather than reasoned about.
 * Rendered down a size ramp on 2026-08-23, the ring's hole stays a clean dark disc to about 14px and
 * turns to mush at 10px, and a ring whose hole has closed is a filled mark with a centre, which is
 * the one presentation ADR 005 exists to forbid. 0.62 puts the far end at 16px, comfortably clear of
 * the edge rather than on it, which matters because some of the people this is being demonstrated to
 * have poor vision. An earlier 0.5 landed on 13px, which held but only just.
 */
const SCALE_NEAR_M = 80_000;
const SCALE_FAR_M = 6_000_000;
const SCALE_FAR_FACTOR = 0.62;

/**
 * The smallest drawn size at which the ring still reads as hollow. Asserted against the ramp above.
 */
export const RING_LEGIBLE_FLOOR_PX = 16;

const LABEL_FONT = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_COLOUR = '#e6edf3';
const LABEL_GAP_PX = 6;

/**
 * The label for a post: the place it is about, never its text.
 *
 * `place_name` is present exactly when the basis is derived, per the contract's own validator, so a
 * derived post can say which place its words matched. An upstream post has no place name because
 * there was no derivation, and it gets its source instead. The post's text is deliberately not a
 * candidate: a label is one line on a globe and a truncated sentence from someone's post is both
 * unreadable and a worse thing to put on a map than the name of a city.
 */
export function socialLabel(post: SocialPost): string {
  return post.place_name ?? post.source;
}

/** What the layer holds for one post. */
interface Slot {
  mark: Billboard;
  label: Label;
  lon: number;
  lat: number;
  observed: boolean;
  cell: number;
  grouped: boolean;
}

/**
 * A merged group and the label slot it no longer uses.
 *
 * The label stays in the pool with nothing on it. Groups are drawn as one ring now rather than as a
 * counted hexagon, so there is no text, but the collection is kept because dropping a primitive
 * collection from a scene is the churn this file exists to avoid.
 */
interface Badge {
  mark: Billboard;
  label: Label;
}

const scratch = new Cartesian3();
const scratchBadge = new Cartesian3();
const scratchMatrix = new Matrix4();
const scratchCarto = new Cartographic();

export class SocialLayer {
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
  /**
   * How far to nudge a pin down so its tip lands on the post's coordinate.
   *
   * A pin is anchored at the bottom of its image, but the casing extends below the drawn tip, so
   * without this the tip floats a couple of pixels above the place it is claiming. Two pixels is
   * nothing on a mover and it is the entire point of a pin.
   */
  private readonly pinOffset = new Cartesian2(0, 0);
  private readonly scene: Scene;
  private readonly grid = new ScreenClusterer(CLUSTER_CELL_PX, SOCIAL_CLUSTER_MIN);
  private readonly rangeScale: NearFarScalar;
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
    // Translucent explicitly, or Cesium draws the counts in the opaque pass and each badge paints
    // over its own number. See AGENTS.md.
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
   * How many posts fall inside a longitude and latitude rectangle.
   *
   * Here for parity with the other layers. The rail should use `clusterState.onScreen`, which
   * projects every post through the camera matrix rather than trusting
   * `camera.computeViewRectangle`, which reads zero at whole-globe zoom while marks are drawn.
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

  upsert(posts: Iterable<SocialPost>): void {
    for (const post of posts) {
      this.upsertOne(post);
    }
  }

  /** Apply a full snapshot: anything the feed no longer reports is gone. */
  replace(posts: readonly SocialPost[]): void {
    const present = new Set(posts.map((post) => socialKey(post)));
    for (const [key, slot] of this.slots) {
      if (!present.has(key)) {
        this.release(key, slot);
      }
    }
    this.upsert(posts);
  }

  /** Take posts off the globe. One the layer never held is ignored. */
  remove(keys: Iterable<string>): void {
    for (const key of keys) {
      const slot = this.slots.get(key);
      if (slot !== undefined) {
        this.release(key, slot);
      }
    }
  }

  /**
   * Nothing to advance, ever.
   *
   * ADR 005: "A post is a fixed event, not a mover. It has a timestamp and no motion." There is
   * nothing to interpolate and no route to draw between two of them, because the route is the part
   * no source reported. Present so the render loop can treat this layer like the others.
   */
  advance(): boolean {
    return false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.marks.show = visible;
    this.labels.show = visible;
    this.badges.show = visible;
    this.badgeLabels.show = visible;
  }

  /** Highlight one post, or none. Selection is a halo and a label, never a change of mark. */
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

  /** Regroup against where the camera is now. Public so a test can drive a pass by hand. */
  recluster(): void {
    badgeSlots.begin(
      this.scene.drawingBufferWidth,
      this.scene.drawingBufferHeight,
      CLUSTER_CELL_PX,
    );
    badgeSlots.release(SOCIAL_CLUSTER_KEY);
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
    if (parsed?.layerKey !== SOCIAL_CLUSTER_KEY) {
      return null;
    }
    const mark = this.grid.markFor(parsed.cellId);
    if (mark === null) {
      return null;
    }
    scratchBadge.x = mark.x;
    scratchBadge.y = mark.y;
    scratchBadge.z = mark.z;
    const carto = Cartographic.fromCartesian(scratchBadge, undefined, scratchCarto);
    return {
      lon: (carto.longitude * 180) / Math.PI,
      lat: (carto.latitude * 180) / Math.PI,
      altitudeM: clusterCameraHeight(mark.spreadM),
      count: mark.count,
    };
  }

  private upsertOne(post: SocialPost): void {
    const key = socialKey(post);
    const slot = this.slots.get(key) ?? this.acquire(key);
    slot.lon = post.point.lon;
    slot.lat = post.point.lat;
    slot.observed = isObservedPosition(post);
    slot.label.text = socialLabel(post);
    this.emphasise(slot, key === this.selectedId);
    this.place(slot);
  }

  /**
   * Mark, size, anchor and label visibility.
   *
   * The two bases differ in three things at once, and all three follow from one fact. A pin claims a
   * point, so it is anchored at its tip and nudged down until the tip sits on the coordinate. A ring
   * claims an area, so it is centred and there is nothing to anchor. Only the selected post is
   * labelled: a post's place name beside every mark would put text over the city it names.
   */
  private emphasise(slot: Slot, selected: boolean): void {
    const sizePx = selected ? SELECTED_SOCIAL_ICON_PX : SOCIAL_ICON_PX;
    slot.mark.image = slot.observed
      ? iconImage('pin', SOCIAL_COLOUR, selected, sizePx)
      : areaRingImage(sizePx, SOCIAL_COLOUR, selected);
    slot.mark.show = !slot.grouped;
    slot.mark.width = sizePx;
    slot.mark.height = sizePx;
    slot.mark.scaleByDistance = selected ? this.fixedScale : this.rangeScale;
    // A pin hangs from the bottom of its image and has to be nudged down for its tip to land on the
    // coordinate, by an amount that differs between the normal and selected view boxes. `icons.ts`
    // owns that arithmetic because it owns the geometry. A ring claims an area, so there is nothing
    // to anchor and it stays centred.
    slot.mark.verticalOrigin = slot.observed ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER;
    this.pinOffset.y = slot.observed ? pinTipOffsetPx(sizePx, selected) : 0;
    slot.mark.pixelOffset = this.pinOffset;
    this.labelOffset.x = sizePx / 2 + LABEL_GAP_PX;
    slot.label.pixelOffset = this.labelOffset;
    slot.label.show = selected && !slot.grouped;
  }

  private place(slot: Slot): void {
    // Height 0. The contract leaves `altitude_m` unset, because no source in this layer reports one
    // and inventing ground level would be a fabricated value.
    Cartesian3.fromDegrees(slot.lon, slot.lat, 0, undefined, scratch);
    slot.mark.position = scratch;
    slot.label.position = scratch;
  }

  /**
   * Draw one group as a single ring, taking the next slot out of the pool.
   *
   * **No hexagon and no count.** Alexander Fanthome asked on 2026-08-24 to "remove those
   * hexagons ... instead just merge the asset locations into one icon, and average the
   * position/rotation ... Do not scale the asset icon size when merging, keep at the current
   * size", after saying the globe was very cluttered. So a group of posts is drawn as one mark at
   * the members' mean position, at the size a single post draws at.
   *
   * **The ring, never the pin, and ADR 005 is what settles it.** A pin's tip claims *here, at this
   * point, exactly*, and the mean of two hundred exact coordinates is a place none of them
   * reported. A ring claims *somewhere in this*, which is true of every group whatever its members'
   * bases are. So the old badge's rule survives the merge intact: the merged mark still says
   * nothing about basis, and it still cannot be read as an observation. Clicking it resolves the
   * group back into its own pins and rings, which is where the basis is stated.
   *
   * **Nothing is rotated.** A post is a fixed event at a place and carries no bearing, so the
   * clusterer is handed no heading and there is nothing to average.
   */
  private drawBadge(mark: ClusterMark, used: number): number {
    // The unmerged size, deliberately. `clusterBadgePx` grew with the count, which is exactly what
    // was asked to stop: a merged icon is one post's worth of ink wherever it appears.
    const sizePx = SOCIAL_ICON_PX;
    const badge = this.badgePool[used] ?? this.acquireBadge();
    badge.mark.show = true;
    badge.mark.id = clusterPickId(SOCIAL_CLUSTER_KEY, mark.cellId);
    badge.mark.image = areaRingImage(sizePx, SOCIAL_COLOUR, false);
    badge.mark.width = sizePx;
    badge.mark.height = sizePx;
    scratchBadge.x = mark.meanX;
    scratchBadge.y = mark.meanY;
    scratchBadge.z = mark.meanZ;
    badge.mark.position = scratchBadge;
    badge.label.show = false;
    badge.label.text = '';
    // Drawn on a lattice point rather than on the member it hangs from. Its own cell's centre when
    // that is free, which is what keeps two badges of this layer apart, and the nearest free point
    // otherwise, which is what keeps it from landing exactly on another layer's badge. See
    // `ClusterMark.nudgeX` and `badge-slots.ts`.
    const slot = badgeSlots.claim(SOCIAL_CLUSTER_KEY, mark.centreX, mark.centreY, this.badgeSlot);
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
    // Fill only, held from when a group carried a count. Nothing is drawn on it now.
    label.style = LabelStyle.FILL;
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
      observed: false,
      cell: OFF_SCREEN,
      grouped: false,
    };
    this.slots.set(key, slot);
    return slot;
  }

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
