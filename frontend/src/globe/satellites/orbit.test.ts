/**
 * Tests for the satellite propagation maths.
 *
 * The first block is the only test in the frontend that proves a physical result rather than
 * a code path, and it is written that way on purpose: a code-path test passes happily while
 * the whole constellation sits 28 km from where it is. It propagates the real recorded
 * CelesTrak element set to a fixed instant and checks the answer against a position
 * published by somebody else.
 */

import { describe, expect, it } from 'vitest';
import { SatRecError, eciToGeodetic, gstime, json2satrec, propagate } from 'satellite.js';

import {
  ORBIT_TRAIL_SAMPLES,
  STALE_EPOCH_AGE_MS,
  SatelliteEngine,
  handleRequest,
  toOmm,
  transferables,
} from './orbit';
import { issElements, issOmm, makeSatellite } from '../../testing/satellite';

/** WGS84 mean radius, the same figure `globe/project.ts` uses for dead reckoning. */
const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

/** Great-circle distance in kilometres between two longitude/latitude pairs. */
function groundSeparationKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The one satellite in the engine, as longitude, latitude and altitude in metres. */
function onlyPosition(engine: SatelliteEngine, when: Date) {
  const positions = engine.positionsAt(when);
  expect(positions.ids.length).toBe(1);
  return {
    lon: positions.lonLatAlt[0] ?? NaN,
    lat: positions.lonLatAlt[1] ?? NaN,
    altitudeM: positions.lonLatAlt[2] ?? NaN,
    dropped: positions.dropped,
    stale: positions.stale,
  };
}

/**
 * Independently published ISS positions, for the acceptance test below.
 *
 * Source: `https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps=1787162400,1787184000&units=kilometers`,
 * called on 2026-08-20. wheretheiss.at runs its own propagator against its own element
 * source, so it shares neither code nor elements with `satellite.js` or with our fixture.
 * Latitude and longitude are degrees, altitude is kilometres.
 */
const PUBLISHED_ISS_POSITIONS = [
  {
    at: '2026-08-19T18:00:00Z',
    lat: 39.110289242724,
    lon: -112.39227490638,
    altitudeKm: 418.9905017956,
  },
  {
    at: '2026-08-20T00:00:00Z',
    lat: 51.10332817033,
    lon: 93.271072253536,
    altitudeKm: 419.08933700298,
  },
] as const;

/**
 * How far from the published position the propagated one may sit.
 *
 * 5 km on the ground, which is 0.65 seconds of ISS flight and well under a pixel at any
 * useful camera height. It is not tighter because the two answers legitimately differ:
 * wheretheiss.at is propagating a different element set fitted at a different epoch, and an
 * OMM epoch carries more precision than the TLE epoch most references are derived from, which
 * `satellite.js` flags in its own source. It is not looser because 5 km still catches the
 * failure this test exists for: at these latitudes a GMST skew of about 14 seconds already
 * exceeds it, and the 60-second skew asserted further down misses by 21 km.
 *
 * Measured on the recorded fixture: 1.50 km at the first reference and 2.21 km at the second.
 */
const POSITION_TOLERANCE_KM = 5;
/** Altitude is not affected by a GMST skew at all, so it is held far tighter. */
const ALTITUDE_TOLERANCE_KM = 1;

describe('ISS position against an independently published one', () => {
  it.each(PUBLISHED_ISS_POSITIONS)(
    'propagates the recorded CelesTrak elements to within tolerance at $at',
    (reference) => {
      const engine = new SatelliteEngine();
      expect(engine.load([issElements()])).toEqual({ accepted: 1, rejected: 0 });

      const got = onlyPosition(engine, new Date(reference.at));

      expect(groundSeparationKm(got, reference)).toBeLessThan(POSITION_TOLERANCE_KM);
      expect(Math.abs(got.altitudeM / 1000 - reference.altitudeKm)).toBeLessThan(
        ALTITUDE_TOLERANCE_KM,
      );
      expect(got.dropped).toBe(0);
      expect(got.stale).toBe(0);
    },
  );

  it('is thrown 21 km off by rotating with a GMST from sixty seconds later', () => {
    // The trap, reproduced against the library directly, because the engine gives no way to
    // separate the two steps. It is a pure rotation about the polar axis: longitude moves by
    // 0.25068 degrees, latitude and altitude do not move at all, no error is raised and
    // nothing is NaN. Every satellite goes the same way, so the globe looks fine.
    const satrec = json2satrec(toOmm(issElements()));
    const reference = PUBLISHED_ISS_POSITIONS[0];
    const when = new Date(reference.at);
    const positionAndVelocity = propagate(satrec, when, { communityDecayCheckEnabled: true });
    expect(positionAndVelocity).not.toBeNull();

    const sixtySecondsOn = new Date(when.getTime() + 60_000);
    const sameInstant = eciToGeodetic(positionAndVelocity!.position, gstime(when));
    const sixtySecondsLate = eciToGeodetic(positionAndVelocity!.position, gstime(sixtySecondsOn));

    expect((sameInstant.longitude - sixtySecondsLate.longitude) / DEG).toBeCloseTo(0.25068, 4);
    expect(sixtySecondsLate.latitude).toBe(sameInstant.latitude);
    expect(sixtySecondsLate.height).toBe(sameInstant.height);

    const skewed = {
      lon: sixtySecondsLate.longitude / DEG,
      lat: sixtySecondsLate.latitude / DEG,
    };
    expect(groundSeparationKm(skewed, reference)).toBeGreaterThan(20);
    // Which is the point: the tolerance above is not decoration.
    expect(groundSeparationKm(skewed, reference)).toBeGreaterThan(POSITION_TOLERANCE_KM);
  });
});

describe('element loading', () => {
  it('maps the domain contract onto the OMM keywords json2satrec reads', () => {
    const omm = toOmm(issElements());
    const recorded = issOmm();

    // Every quantity the propagator reads, unconverted: degrees stay degrees and mean motion
    // stays revolutions per day, because that is what both formats hold.
    expect(omm.MEAN_MOTION).toBe(recorded.MEAN_MOTION);
    expect(omm.ECCENTRICITY).toBe(recorded.ECCENTRICITY);
    expect(omm.INCLINATION).toBe(recorded.INCLINATION);
    expect(omm.RA_OF_ASC_NODE).toBe(recorded.RA_OF_ASC_NODE);
    expect(omm.ARG_OF_PERICENTER).toBe(recorded.ARG_OF_PERICENTER);
    expect(omm.MEAN_ANOMALY).toBe(recorded.MEAN_ANOMALY);
    expect(omm.BSTAR).toBe(recorded.BSTAR);
    expect(omm.MEAN_MOTION_DOT).toBe(recorded.MEAN_MOTION_DOT);
    expect(omm.MEAN_MOTION_DDOT).toBe(recorded.MEAN_MOTION_DDOT);
    expect(omm.NORAD_CAT_ID).toBe(recorded.NORAD_CAT_ID);
    expect(omm.EPOCH).toBe(`${recorded.EPOCH}Z`);
  });

  it('rewrites a +00:00 epoch offset to Z, which is the difference between a satellite and a NaN', () => {
    // json2satrec appends a Z when the string has none, so '+00:00' becomes '+00:00Z' and
    // new Date() rejects it. Nothing throws: the satrec comes back full of NaN and the layer
    // is silently empty. Our backend serialises Z, and this is the guard for the day it does
    // not.
    const offsetForm = issElements({ epoch: '2026-08-19T12:48:46.640160+00:00' });
    expect(toOmm(offsetForm).EPOCH).toBe('2026-08-19T12:48:46.640160Z');
    expect(json2satrec(toOmm(offsetForm)).jdsatepoch).toBeCloseTo(2_461_272.033873148, 6);

    // And the unguarded form, to prove the failure is silent rather than loud.
    const unguarded = json2satrec({ ...toOmm(offsetForm), EPOCH: offsetForm.epoch });
    expect(unguarded.jdsatepoch).toBeNaN();
  });

  it('rejects and counts an element set that will not initialise, rather than keeping it', () => {
    const engine = new SatelliteEngine();
    const result = engine.load([issElements(), issElements({ epoch: 'not a timestamp' })]);

    expect(result).toEqual({ accepted: 1, rejected: 1 });
    expect(engine.size).toBe(1);
  });

  it('holds one record per catalogue number, so overlapping groups cannot double-count', () => {
    const engine = new SatelliteEngine();
    const result = engine.load([
      issElements({ group: 'stations' }),
      issElements({ group: 'active' }),
    ]);

    expect(result.accepted).toBe(1);
    expect(engine.size).toBe(1);
  });

  it('replaces the whole cache on load, so an object that left the group leaves the globe', () => {
    const engine = new SatelliteEngine();
    engine.load([issElements(), makeSatellite()]);
    expect(engine.size).toBe(2);

    engine.load([issElements()]);
    expect(engine.size).toBe(1);
  });
});

/**
 * An element set whose orbit is already underground at its own epoch.
 *
 * Built by raising the real ISS mean motion, which shrinks the semi-major axis: at 20
 * revolutions a day perigee sits 0.10 earth radii below the surface and SGP4 answers 6,
 * Decayed; at 17 it answers 1, mean eccentricity out of range. Both are element sets the
 * backend contract accepts, because nothing on an OMM record says an object has decayed.
 *
 * Constructed at epoch rather than by propagating the real ISS for years, because the
 * staleness guard catches anything that old first, and it should.
 */
function decayed(meanMotion: number, noradCatId = 25_544) {
  return issElements({ mean_motion: meanMotion, norad_cat_id: noradCatId });
}

describe('the decay guard', () => {
  const epoch = new Date('2026-08-19T12:48:46.640Z');
  const when = new Date('2026-08-19T18:00:00Z');

  it('drops a satellite SGP4 refuses, and records the reason it gave', () => {
    const engine = new SatelliteEngine();
    engine.load([decayed(20)]);

    const positions = engine.positionsAt(when);

    expect(positions.ids.length).toBe(0);
    expect(positions.dropped).toBe(1);
    expect(positions.stale).toBe(0);
    expect(engine.refusalsByCode.get(SatRecError.Decayed)).toBe(1);
  });

  it('records each refusal code separately, reading it off the propagation that produced it', () => {
    // satrec.error is mutated by the most recent propagation of any element set, so a reason
    // read one satellite late is the wrong satellite's reason. Two objects refused for two
    // different reasons in one tick is what proves it is read in time.
    const engine = new SatelliteEngine();
    engine.load([decayed(20, 90_020), decayed(17, 90_017)]);

    const positions = engine.positionsAt(when);

    expect(positions.dropped).toBe(2);
    expect(engine.refusalsByCode.get(SatRecError.Decayed)).toBe(1);
    expect(engine.refusalsByCode.get(SatRecError.MeanEccentricityOutOfRange)).toBe(1);
  });

  it('keeps drawing the satellites that do propagate while dropping the one that does not', () => {
    const engine = new SatelliteEngine();
    engine.load([issElements(), decayed(20, 90_020)]);

    const positions = engine.positionsAt(when);

    expect(engine.size).toBe(2);
    expect([...positions.ids]).toEqual([25_544]);
    expect(positions.dropped).toBe(1);
  });

  it('drops a satellite whose elements are older than three and a half days', () => {
    // Not a decay case at all, and the reason it needs its own guard: at epoch plus a year
    // these same elements still propagate with error 0 and a plausible altitude. A clean
    // error code is not evidence of a usable position, so staleness is checked separately.
    const engine = new SatelliteEngine();
    engine.load([issElements()]);

    const justInside = engine.positionsAt(new Date(epoch.getTime() + STALE_EPOCH_AGE_MS - 1000));
    const justOutside = engine.positionsAt(new Date(epoch.getTime() + STALE_EPOCH_AGE_MS + 1000));

    expect(justInside.ids.length).toBe(1);
    expect(justInside.stale).toBe(0);
    expect(justOutside.ids.length).toBe(0);
    expect(justOutside.stale).toBe(1);
    // Stale is not a propagation failure and is counted apart from one.
    expect(justOutside.dropped).toBe(0);
  });

  it('counts the drop, so the number on screen is the number drawn', () => {
    const engine = new SatelliteEngine();
    engine.load([issElements(), makeSatellite({ epoch: '2026-08-01T00:00:00Z' })]);

    const positions = engine.positionsAt(new Date('2026-08-19T18:00:00Z'));

    expect(engine.size).toBe(2);
    expect(positions.ids.length).toBe(1);
    expect(positions.stale).toBe(1);
  });
});

describe('the orbit trail', () => {
  const when = new Date('2026-08-19T18:00:00Z');

  it('returns one full revolution of finite positions', () => {
    const engine = new SatelliteEngine();
    engine.load([issElements()]);

    const track = engine.orbitAt(25_544, when);

    expect(track).not.toBeNull();
    expect(track!.length).toBe(ORBIT_TRAIL_SAMPLES * 3);
    expect([...track!].every((value) => Number.isFinite(value))).toBe(true);

    // One full revolution, which is what the first and last samples prove between them. The
    // ISS is back to the same latitude and the same altitude, and 23.3 degrees of longitude
    // further west, because the earth turned under it during the 92.9-minute orbit. A trail
    // that closed on the ground would mean the earth-fixed rotation was not being applied.
    const first = { lon: track![0]!, lat: track![1]!, altitudeM: track![2]! };
    const last = {
      lon: track![(ORBIT_TRAIL_SAMPLES - 1) * 3]!,
      lat: track![(ORBIT_TRAIL_SAMPLES - 1) * 3 + 1]!,
      altitudeM: track![(ORBIT_TRAIL_SAMPLES - 1) * 3 + 2]!,
    };
    expect(Math.abs(last.lat - first.lat)).toBeLessThan(0.5);
    expect(Math.abs(last.altitudeM - first.altitudeM)).toBeLessThan(1000);
    expect(last.lon - first.lon).toBeCloseTo(-23.33, 1);

    // And the middle of the trail is where the point itself is drawn.
    const middle = Math.round(ORBIT_TRAIL_SAMPLES / 2);
    const drawn = onlyPosition(engine, when);
    const midSample = { lon: track![middle * 3]!, lat: track![middle * 3 + 1]! };
    expect(groundSeparationKm(midSample, drawn)).toBeLessThan(200);
  });

  it('has no trail for a satellite it does not hold, and none for a single sample', () => {
    const engine = new SatelliteEngine();
    engine.load([issElements()]);

    expect(engine.orbitAt(99_999, when)).toBeNull();
    expect(engine.orbitAt(25_544, when, 1)).toBeNull();
  });

  it('has no trail at all when the orbit will not propagate', () => {
    // All or nothing: skipping a failed sample would join the two points either side of the
    // gap with a chord straight through the earth.
    const engine = new SatelliteEngine();
    engine.load([issElements()]);

    expect(engine.orbitAt(25_544, new Date('2032-02-11T00:00:00Z'))).toBeNull();
  });
});

describe('the worker protocol', () => {
  it('loads, propagates and trails through handleRequest alone', () => {
    const engine = new SatelliteEngine();

    expect(handleRequest(engine, { type: 'elements', satellites: [issElements()] })).toEqual({
      type: 'elements',
      accepted: 1,
      rejected: 0,
    });

    const atMs = Date.parse('2026-08-19T18:00:00Z');
    const positions = handleRequest(engine, { type: 'positions', atMs });
    expect(positions).toMatchObject({ type: 'positions', atMs, dropped: 0, stale: 0 });

    const orbit = handleRequest(engine, { type: 'orbit', noradCatId: 25_544, atMs });
    expect(orbit).toMatchObject({ type: 'orbit', noradCatId: 25_544 });
  });

  it('hands the position buffers over rather than copying them', () => {
    // A thousand satellites is a 24 KB array per frame. Transferred it costs a pointer;
    // cloned it costs an allocation and a copy on the one thread that has to draw.
    const engine = new SatelliteEngine();
    engine.load([issElements()]);
    const atMs = Date.parse('2026-08-19T18:00:00Z');

    const positions = handleRequest(engine, { type: 'positions', atMs });
    expect(transferables(positions)).toHaveLength(2);

    const orbit = handleRequest(engine, { type: 'orbit', noradCatId: 25_544, atMs });
    expect(transferables(orbit)).toHaveLength(1);

    const missing = handleRequest(engine, { type: 'orbit', noradCatId: 1, atMs });
    expect(transferables(missing)).toHaveLength(0);

    const loaded = handleRequest(engine, { type: 'elements', satellites: [] });
    expect(transferables(loaded)).toHaveLength(0);
  });
});

describe('propagation cost', () => {
  it('propagates a thousand satellites well inside a worker frame budget', () => {
    // Acceptance criterion 2 is 1,000-plus satellites at 60fps, which is a 16.7 ms frame.
    // This runs in the worker rather than on the render thread, so the assertion is only
    // that the maths is nowhere near being the problem.
    //
    // The bound is 60 ms, not 16.7, and that is deliberate. `pnpm test` runs under v8
    // coverage instrumentation, which inflates this loop by roughly eight times: the same
    // work measures about 3.5 ms uninstrumented and 20 to 22 ms with coverage on. A 16.7 ms
    // assertion therefore passed on an idle machine and failed on a loaded one, which is a
    // flake rather than a regression guard, and it broke a build on 2026-08-20. 60 ms still
    // catches a real regression (anything worse than about 8 ms of actual work) while
    // leaving headroom for a busy CI box. If you want the true figure, run vitest without
    // --coverage.
    const engine = new SatelliteEngine();
    engine.load(
      Array.from({ length: 1000 }, (_, index) => makeSatellite({ norad_cat_id: 90_000 + index })),
    );
    const when = new Date('2026-08-19T18:00:00Z');
    // One warm-up pass, so the measurement is not paying for lazy initialisation.
    engine.positionsAt(when);

    const started = performance.now();
    const positions = engine.positionsAt(when);
    const elapsedMs = performance.now() - started;

    expect(positions.ids.length).toBe(1000);
    expect(elapsedMs).toBeLessThan(60);
  });
});
