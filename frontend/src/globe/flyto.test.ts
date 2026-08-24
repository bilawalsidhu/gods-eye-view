/**
 * Tests for the camera flight, against a fake camera.
 *
 * Cesium is mocked because a real `Camera` needs a scene and a WebGL context, and neither
 * exists in a test runner. What is asserted is the one thing that would otherwise be a
 * promise nobody checks: `prefers-reduced-motion: reduce` produces a cut, not a shorter
 * animation. A flight that merely got faster would still be a moving picture, which is what
 * the setting exists to stop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => ({
  Cartesian3: {
    fromDegrees: (lon: number, lat: number, height: number) => ({ lon, lat, height }),
  },
}));

import { FLIGHT_SECONDS, flyToPoint, prefersReducedMotion } from './flyto';
import type { CameraTarget } from './flyto';

interface Recorder extends CameraTarget {
  readonly flights: unknown[];
  readonly cuts: unknown[];
  renders: number;
}

function recorder(): Recorder {
  const flights: unknown[] = [];
  const cuts: unknown[] = [];
  const target = {
    flights,
    cuts,
    renders: 0,
    viewer: {
      camera: {
        flyTo: (options: unknown) => {
          flights.push(options);
        },
        setView: (options: unknown) => {
          cuts.push(options);
        },
      },
    },
    requestRender: () => {
      target.renders += 1;
    },
  };
  return target;
}

const LONDON = { lon: -0.12, lat: 51.5, altitude_m: null };

describe('flyToPoint', () => {
  it('animates to the destination when motion is allowed', () => {
    const target = recorder();

    flyToPoint(target, LONDON, 200_000, false);

    expect(target.cuts).toHaveLength(0);
    expect(target.flights).toHaveLength(1);
    const flight = target.flights[0] as {
      destination: unknown;
      duration: number;
      complete: unknown;
    };
    expect(flight.destination).toEqual({ lon: -0.12, lat: 51.5, height: 200_000 });
    expect(flight.duration).toBe(FLIGHT_SECONDS);
    // The frame request on completion: the tween has stopped moving the camera by then, so
    // nothing else is left to notice the change and ask for the last draw.
    expect(typeof flight.complete).toBe('function');
  });

  it('cuts straight there under reduced motion, with no flight at all', () => {
    const target = recorder();

    flyToPoint(target, LONDON, 200_000, true);

    // Not a shorter duration: no animation is started, and the frame is asked for
    // immediately because there is no tween left to notice the camera moved.
    expect(target.flights).toHaveLength(0);
    expect(target.cuts).toEqual([{ destination: { lon: -0.12, lat: 51.5, height: 200_000 } }]);
    expect(target.renders).toBe(1);
  });

  it('sends longitude first and ignores the point own altitude', () => {
    const target = recorder();

    flyToPoint(target, { lon: 4.48, lat: 51.92, altitude_m: 11_000 }, 80_000, true);

    // Camera height, not the aircraft height: flying to 11km would put the camera inside it.
    expect(target.cuts).toEqual([{ destination: { lon: 4.48, lat: 51.92, height: 80_000 } }]);
  });
});

describe('prefersReducedMotion', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports what the media query says', () => {
    const queries: string[] = [];
    vi.stubGlobal('window', {
      matchMedia: (query: string) => {
        queries.push(query);
        return { matches: true };
      },
    });

    expect(prefersReducedMotion()).toBe(true);
    expect(queries).toEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('is false when the user has expressed no preference', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });

    expect(prefersReducedMotion()).toBe(false);
  });
});
