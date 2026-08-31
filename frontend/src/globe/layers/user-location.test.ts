import { describe, expect, it } from 'vitest';

import type { LocationFix } from '../../state/location';
import { ACCURACY_RING_POINTS, accuracyRing, markAltitudeM } from './user-location';

/** How many degrees of longitude a ring spans, which is what widens away from the equator. */
function longitudeSpan(ring: readonly (readonly [number, number])[]): number {
  const lons = ring.map(([lon]) => lon);
  return Math.max(...lons) - Math.min(...lons);
}

function fixAt(lon: number, lat: number, accuracyM = 100, altitudeM: number | null = null) {
  return { lon, lat, accuracyM, altitudeM, atMs: 0 } satisfies LocationFix;
}

describe('accuracyRing', () => {
  it('closes, so the ring has no seam', () => {
    // `points + 1` vertices, first and last identical. A ring one vertex short draws a circle
    // with a wedge missing, which reads as a broken primitive rather than as an accuracy radius.
    const ring = accuracyRing(fixAt(0, 0));

    expect(ring).toHaveLength(ACCURACY_RING_POINTS + 1);
    const first = ring[0];
    const last = ring.at(-1);
    if (first === undefined || last === undefined) throw new Error('expected a closed ring');
    // Component-wise rather than `toEqual`, because `sin(2 * PI)` is -2.4e-16 rather than zero
    // and `toEqual` treats -0 and +0 as different. The seam is what matters, not the sign bit.
    expect(last[0]).toBeCloseTo(first[0], 12);
    expect(last[1]).toBeCloseTo(first[1], 12);
  });

  it('widens in longitude as it approaches the pole, so the circle stays a circle', () => {
    // A degree of longitude is a fraction of a degree of latitude away from the equator, so a
    // ring drawn with equal spans would be an ellipse squashed flat at high latitude.
    const equator = accuracyRing(fixAt(0, 0));
    const northern = accuracyRing(fixAt(0, 60));
    // cos(60 degrees) is a half, so the longitude span should be about twice the equator's.
    expect(longitudeSpan(northern) / longitudeSpan(equator)).toBeCloseTo(2, 1);
  });

  it('does not divide by zero at the pole', () => {
    // Without the latitude clamp, `cos(90 degrees)` is about 6e-17 and the longitude span goes
    // to roughly 1e15 degrees, which is not a ring, it is a band wrapped round the earth
    // several trillion times. Every vertex must stay finite.
    const ring = accuracyRing(fixAt(0, 90));

    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('leaves longitude unwrapped so a ring at the antimeridian is not cut in half', () => {
    // `Cartesian3.fromDegrees` takes any real longitude. Wrapping into [-180, 180) here would
    // put half this ring's vertices at +179 and half at -179, and the line between them would
    // be drawn the long way round the globe.
    // A radius wide enough to actually reach the antimeridian. At a hundred metres the ring is
    // 0.0009 degrees across and never crosses, so the first version of this test proved nothing.
    const ring = accuracyRing(fixAt(179.99, 0, 200_000));
    const lons = ring.map(([lon]) => lon);

    expect(Math.max(...lons)).toBeGreaterThan(180);
  });
});

describe('markAltitudeM', () => {
  it('uses the reported altitude when the device gave one', () => {
    expect(markAltitudeM(fixAt(0, 0, 100, 42))).toBe(42);
  });

  it('falls back to sea level rather than inventing a height', () => {
    // A laptop with no GPS reports no altitude, which is the common case. Zero is the honest
    // stand-in; anything else is a number nothing measured.
    expect(markAltitudeM(fixAt(0, 0, 100, null))).toBe(0);
  });
});
