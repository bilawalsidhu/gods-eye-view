/**
 * The viewer's own position, drawn as one mark and one accuracy circle.
 *
 * The smallest layer in the app: one billboard and one polyline, both built once in the
 * constructor and mutated in place, because there is exactly one of you. No pooling, no
 * clustering, no grid, none of which would have anything to do.
 *
 * **The circle is the feature, not decoration.** The browser reports a 95% confidence radius
 * with every fix and it swings from a few metres on GPS to tens of kilometres when the answer
 * came from an IP address lookup. A dot alone would present both as the same claim. Drawing
 * the radius is what makes an IP-derived position read as the wide guess it is, which is the
 * same rule this project applies to a derived social post and to a stale transit report.
 *
 * **No pick id, deliberately.** Every other mark on this globe carries one and a click on it
 * opens a card. This one carries none, so a click passes through to whatever is behind it.
 * There is no card to open: the accuracy figure is on the rail row, and a foreign id reaching
 * `store.select` is a trap `main.ts` already has a comment about.
 *
 * Nothing here holds the fix beyond the two primitives it has written. The position lives in
 * `state/location.ts`, which is the module that also carries the rule that it never leaves
 * the tab.
 */

import {
  BillboardCollection,
  BlendOption,
  Cartesian3,
  Color,
  HorizontalOrigin,
  Material,
  PolylineCollection,
  VerticalOrigin,
} from 'cesium';
import type { Billboard, Polyline, Scene } from 'cesium';

import { iconImage } from '../icons';
import type { LocationFix } from '../../state/location';

/**
 * The chrome accent, and it is the one mark on this globe that takes a colour from the panel
 * palette rather than from the entity palette.
 *
 * Deliberate. `globe/palette.ts` reserves its hues for classes of thing in the world, and this
 * is not a thing in the world: it is where the person reading the screen is sitting. Blue for
 * "you are here" is also the convention every mapping application uses, so it needs no legend.
 */
export const LOCATION_COLOUR = '#7cc4ff';

/**
 * Twenty pixels: larger than a satellite's diamond and smaller than an aircraft.
 *
 * It does not shrink with range, unlike every other mark here. There is one of it, so it costs
 * the picture nothing, and the whole reason to draw it is to find yourself on a globe you have
 * just zoomed out of.
 */
export const LOCATION_ICON_PX = 20;

/** A disc, so it cannot be confused with any silhouette the feeds draw. */
const LOCATION_IMAGE = iconImage('disc', LOCATION_COLOUR, false, LOCATION_ICON_PX);

/**
 * Points around the accuracy circle. Sixty-four is smooth at any zoom this globe reaches.
 *
 * The circle closes by repeating its first point, so the polyline gets one more position than
 * this: an open ring with a visible bite out of it reads as a broken primitive.
 */
export const ACCURACY_RING_POINTS = 64;

export const ACCURACY_RING_WIDTH = 2;

/**
 * Metres per degree of latitude, and the basis of the ring's shape.
 *
 * A local flat-earth approximation rather than a geodesic walk, and that is a decision rather
 * than a shortcut. The largest radius this ever draws is an IP-derived fix of tens of
 * kilometres, where the error in the approximation is metres, and the number it is drawing is
 * itself a confidence radius rather than a measurement. A geodesic ring would be more
 * arithmetic for a difference far below the thing it is illustrating.
 */
const METRES_PER_DEGREE_LATITUDE = 111_320;

const RAD_PER_DEG = Math.PI / 180;

/**
 * How far from a pole the longitude scaling is allowed to blow up.
 *
 * `cos(latitude)` goes to zero at the pole, so metres-per-degree-of-longitude goes to
 * infinity and the ring would wrap the planet. Clamped to 89.9 degrees, where the scaling is
 * about 573 times the equatorial figure and the ring is still a ring.
 */
const MAXIMUM_RING_LATITUDE_DEG = 89.9;

/**
 * The accuracy circle as `[lon, lat]` pairs, closed, in this project's coordinate order.
 *
 * Exported because it is the whole of the geometry and it is worth testing without a renderer.
 * Longitude is not wrapped into `[-180, 180)` here: `Cartesian3.fromDegrees` takes any real
 * longitude and a ring straddling the antimeridian would otherwise be cut in half by the wrap.
 */
export function accuracyRing(
  fix: LocationFix,
  points: number = ACCURACY_RING_POINTS,
): readonly (readonly [number, number])[] {
  const latitudeSpanDeg = fix.accuracyM / METRES_PER_DEGREE_LATITUDE;
  const clampedLat = Math.min(Math.abs(fix.lat), MAXIMUM_RING_LATITUDE_DEG);
  const longitudeSpanDeg = latitudeSpanDeg / Math.cos(clampedLat * RAD_PER_DEG);
  const ring: (readonly [number, number])[] = [];
  for (let index = 0; index <= points; index += 1) {
    const angle = (index / points) * 2 * Math.PI;
    ring.push([
      fix.lon + longitudeSpanDeg * Math.cos(angle),
      fix.lat + latitudeSpanDeg * Math.sin(angle),
    ]);
  }
  return ring;
}

/** Where the mark sits, in metres above the ellipsoid, given whatever the browser reported. */
export function markAltitudeM(fix: LocationFix): number {
  // A device with no GPS reports no altitude, which is the common case on a laptop. Sea level
  // is the honest stand-in: the alternative is inventing a height nothing measured.
  return fix.altitudeM ?? 0;
}

export class UserLocationLayer {
  private readonly marks: BillboardCollection;
  private readonly rings: PolylineCollection;
  private readonly mark: Billboard;
  private readonly ring: Polyline;
  private fix: LocationFix | null = null;

  constructor(scene: Scene) {
    this.marks = new BillboardCollection({ scene, blendOption: BlendOption.TRANSLUCENT });
    this.rings = new PolylineCollection();
    this.mark = this.marks.add({ position: Cartesian3.ZERO });
    this.mark.image = LOCATION_IMAGE;
    this.mark.width = LOCATION_ICON_PX;
    this.mark.height = LOCATION_ICON_PX;
    this.mark.horizontalOrigin = HorizontalOrigin.CENTER;
    this.mark.verticalOrigin = VerticalOrigin.CENTER;
    this.mark.show = false;
    this.ring = this.rings.add({
      // Two positions because a polyline needs at least two. Hidden until a fix arrives, and
      // never removed and re-added: one polyline exists for the life of the layer.
      positions: [Cartesian3.ZERO, Cartesian3.ZERO],
      width: ACCURACY_RING_WIDTH,
      material: Material.fromType('Color', {
        color: Color.fromCssColorString(LOCATION_COLOUR).withAlpha(0.5),
      }),
      show: false,
    });
    // The ring under the mark, so the mark is never hidden by its own accuracy circle at a
    // zoom where the circle is a few pixels across.
    scene.primitives.add(this.rings);
    scene.primitives.add(this.marks);
  }

  /** Whether a position is currently on the globe. The rail's count for this layer. */
  get drawn(): boolean {
    return this.fix !== null;
  }

  /** Where to send the camera, or null when nothing has been fixed. */
  get point(): { lon: number; lat: number } | null {
    return this.fix === null ? null : { lon: this.fix.lon, lat: this.fix.lat };
  }

  /** Draw one fix, replacing whatever was there. */
  show(fix: LocationFix): void {
    this.fix = fix;
    this.mark.position = Cartesian3.fromDegrees(fix.lon, fix.lat, markAltitudeM(fix));
    this.mark.show = true;
    // The ring sits on the ellipsoid rather than at the mark's altitude: it is the horizontal
    // uncertainty in the position, and the browser reports no vertical figure to go with it.
    this.ring.positions = accuracyRing(fix).map(([lon, lat]) =>
      Cartesian3.fromDegrees(lon, lat, 0),
    );
    this.ring.show = true;
  }

  /**
   * Take the position off the globe and forget it.
   *
   * Called when the layer is switched off and when the browser refuses a fix. Both must leave
   * nothing on screen: a mark left behind after a switch went off is a stale position presented
   * as a live one, and here it is a stale position of a person.
   */
  clear(): void {
    this.fix = null;
    this.mark.show = false;
    this.ring.show = false;
  }

  /** The rail's switch. Collection-level, so it costs two flags. */
  setVisible(visible: boolean): void {
    this.marks.show = visible;
    this.rings.show = visible;
  }
}
