import { describe, expect, it } from 'vitest';

import { advanceGreatCircle, normaliseLongitude, pointInView } from './project';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * Haversine, written here on purpose.
 *
 * Checking the destination formula with the destination formula would prove nothing. This
 * is an independent measure: it says how far apart two points are, so it can confirm that
 * an aircraft moved exactly as far as its speed and the elapsed time say it should.
 */
function haversineMetres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Initial bearing from one point to another, degrees clockwise from north. */
function initialBearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

describe('advanceGreatCircle', () => {
  it('runs due east along the equator by the arc the speed and time imply', () => {
    // 100 m/s for 10 s is 1000 m, which at the equator is 1000/R radians of longitude.
    const expectedLon = 1000 / EARTH_RADIUS_M / DEG;
    const moved = advanceGreatCircle(0, 0, 90, 100, 10);

    expect(moved.lon).toBeCloseTo(expectedLon, 9);
    expect(moved.lat).toBeCloseTo(0, 9);
  });

  it('runs due north along a meridian without changing longitude', () => {
    // 200 m/s for 30 s is 6000 m, and a degree of latitude is the same anywhere.
    const expectedLat = 50 + 6000 / EARTH_RADIUS_M / DEG;
    const moved = advanceGreatCircle(10, 50, 0, 200, 30);

    expect(moved.lat).toBeCloseTo(expectedLat, 9);
    expect(moved.lon).toBeCloseTo(10, 9);
  });

  it('lands the correct distance away on the correct bearing for a diagonal track', () => {
    const lon = -0.4543;
    const lat = 51.4706;
    const speed = 243.6;
    const seconds = 8;
    const track = 287.3;

    const moved = advanceGreatCircle(lon, lat, track, speed, seconds);

    expect(haversineMetres(lon, lat, moved.lon, moved.lat)).toBeCloseTo(speed * seconds, 3);
    expect(initialBearing(lon, lat, moved.lon, moved.lat)).toBeCloseTo(track, 6);
  });

  it('crosses the antimeridian into a valid longitude', () => {
    const moved = advanceGreatCircle(179.99, 0, 90, 300, 60);

    expect(moved.lon).toBeGreaterThanOrEqual(-180);
    expect(moved.lon).toBeLessThan(0);
    expect(haversineMetres(179.99, 0, moved.lon, moved.lat)).toBeCloseTo(18_000, 3);
  });

  it('does not move an aircraft with no speed', () => {
    expect(advanceGreatCircle(12.5, -33.9, 271, 0, 60)).toEqual({ lon: 12.5, lat: -33.9 });
  });

  it('does not move an aircraft with no track, rather than guessing one', () => {
    expect(advanceGreatCircle(12.5, -33.9, null, 250, 60)).toEqual({ lon: 12.5, lat: -33.9 });
    expect(advanceGreatCircle(12.5, -33.9, undefined, 250, 60)).toEqual({
      lon: 12.5,
      lat: -33.9,
    });
  });

  it('does not move before any time has passed', () => {
    expect(advanceGreatCircle(1, 2, 45, 250, 0)).toEqual({ lon: 1, lat: 2 });
  });
});

describe('normaliseLongitude', () => {
  it('wraps into the range every contract in this app uses', () => {
    expect(normaliseLongitude(0)).toBe(0);
    expect(normaliseLongitude(-179.5)).toBe(-179.5);
    expect(normaliseLongitude(181)).toBe(-179);
    expect(normaliseLongitude(-181)).toBe(179);
    expect(normaliseLongitude(540)).toBe(-180);
  });
});

describe('pointInView', () => {
  const london = { west: -1, south: 51, east: 1, north: 52 };

  it('accepts a point inside the rectangle and its edges', () => {
    expect(pointInView(london, -0.12, 51.5)).toBe(true);
    expect(pointInView(london, -1, 51)).toBe(true);
    expect(pointInView(london, 1, 52)).toBe(true);
  });

  it('rejects a point outside it in either axis', () => {
    expect(pointInView(london, -0.12, 40)).toBe(false);
    expect(pointInView(london, 30, 51.5)).toBe(false);
  });

  it('handles a view across the antimeridian, where west is greater than east', () => {
    // Cesium's own convention, and the fourth bounding-box convention in this project. An
    // `and` here rather than an `or` would answer confidently about the wrong half of the
    // world: everything from Fiji to Alaska would read as off screen.
    const pacific = { west: 170, south: -10, east: -170, north: 10 };

    expect(pointInView(pacific, 179, 0)).toBe(true);
    expect(pointInView(pacific, -179, 0)).toBe(true);
    expect(pointInView(pacific, 0, 0)).toBe(false);
  });

  it('accepts everything when the view is the whole world', () => {
    // What `cityView` falls back to when the camera is looking at the limb and Cesium
    // cannot give it a rectangle. A layer must not read as empty because of that.
    const world = { west: -180, south: -90, east: 180, north: 90 };

    expect(pointInView(world, 179.9, -89.9)).toBe(true);
  });
});
