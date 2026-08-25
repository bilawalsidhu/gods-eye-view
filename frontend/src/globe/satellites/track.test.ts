/**
 * Tests for the orbit split and the sentence that labels it.
 *
 * The expectations here are sourced from outside the module under test. The ISS orbital
 * period is 92.9 minutes, published by NASA and confirmed independently by the acceptance
 * test in `orbit.test.ts` against wheretheiss.at; the geostationary period is a sidereal day.
 * Neither figure is read back out of `orbit.ts`, so moving a constant in the implementation
 * moves nothing here.
 */

import { describe, expect, it } from 'vitest';

import { ORBIT_TRAIL_SAMPLES, SatelliteEngine } from './orbit';
import type { OrbitTrack } from './orbit';
import { forwardHorizonMs, splitTrack, trackProvenance } from './track';
import { issElements } from '../../testing/satellite';

/** ISS orbital period, 92.9 minutes. NASA's figure, not one read off our own code. */
const ISS_PERIOD_MS = 92.9 * 60_000;

/** A track with the shape the engine produces, without running the propagator for it. */
function track(overrides: Partial<OrbitTrack> = {}): OrbitTrack {
  const samples = 181;
  return {
    lonLatAlt: new Float64Array(samples * 3).map((_, index) => index),
    nowIndex: (samples - 1) / 2,
    epochMs: Date.parse('2026-08-19T12:48:46Z'),
    spanMs: ISS_PERIOD_MS,
    ...overrides,
  };
}

describe('splitTrack', () => {
  it('splits at the object and shares the sample under it with both halves', () => {
    // The shared vertex is the point of the test. Two polylines that split it between them
    // meet across one missing sample, which at 7.7 km/s is about 25 km of absent line
    // directly under the mark: it reads as a broken primitive, not as an off-by-one.
    const seven = Float64Array.from({ length: 7 * 3 }, (_, index) => index);
    const split = splitTrack(track({ nowIndex: 3, lonLatAlt: seven }));

    expect(split.behind.length / 3).toBe(4);
    expect(split.ahead.length / 3).toBe(4);
    // Last sample of `behind` and first of `ahead` are the same three numbers.
    expect([...split.behind.slice(-3)]).toEqual([...split.ahead.slice(0, 3)]);
  });

  it('covers every sample exactly once apart from the shared one', () => {
    const whole = track();
    const split = splitTrack(whole);

    expect(split.behind.length + split.ahead.length).toBe(whole.lonLatAlt.length + 3);
    expect([...split.behind, ...split.ahead.subarray(3)]).toEqual([...whole.lonLatAlt]);
  });

  it('is a view rather than a copy, so a transferred buffer is not duplicated', () => {
    // A thousand-sample track copied twice per selection is pure waste, and the buffer was
    // already handed over from the worker rather than cloned. Both halves point at it.
    const whole = track();
    const split = splitTrack(whole);

    expect(split.behind.buffer).toBe(whole.lonLatAlt.buffer);
    expect(split.ahead.buffer).toBe(whole.lonLatAlt.buffer);
  });

  it('gives the whole track to one half when the object sits at an end', () => {
    const atStart = splitTrack(track({ nowIndex: 0 }));
    expect(atStart.behind.length / 3).toBe(1);
    expect(atStart.ahead.length).toBe(ORBIT_TRAIL_SAMPLES * 3);
  });
});

describe('forwardHorizonMs', () => {
  it('is half a revolution for a track centred on the object', () => {
    // 181 samples with the object at index 90: 90 of the 180 intervals lie ahead of it.
    expect(forwardHorizonMs(track()) / 60_000).toBeCloseTo(46.45, 2);
  });

  it('is twelve hours in geostationary orbit, because half a revolution is half a day', () => {
    // A sidereal day, 23 h 56 min 4 s. The figure is the earth's rotation period, not
    // anything this repository computes.
    const sidereal = 86_164_090;
    expect(forwardHorizonMs(track({ spanMs: sidereal })) / 3_600_000).toBeCloseTo(11.97, 2);
  });

  it('is nothing at all for a track too short to have a direction', () => {
    const single = track({ lonLatAlt: new Float64Array(3), nowIndex: 0 });
    expect(forwardHorizonMs(single)).toBe(0);
  });
});

describe('trackProvenance', () => {
  const epochMs = Date.parse('2026-08-19T12:48:46Z');

  /** How the sentence reads for an element set `ms` old at the instant it is printed. */
  const age = (ms: number): string => trackProvenance(track(), epochMs + ms);

  it('says the half behind the object was computed and not observed', () => {
    // The one clause that must survive every rewrite of this sentence. It is the only line
    // in the product drawn through positions nobody reported, and the rest of the product's
    // honesty about position rests on that never happening silently.
    const sentence = age(5 * 3_600_000);

    expect(sentence).toContain('Neither half is an observed track');
    expect(sentence).toContain('propagated');
    expect(sentence).not.toContain('travelled');
  });

  it('names the horizon and the age of the elements it was computed from', () => {
    const sentence = age(5 * 3_600_000 + 11 * 60_000);

    expect(sentence).toContain('46 min ahead');
    expect(sentence).toContain('5 h 11 min old');
  });

  it('rounds an age down at every unit, so nothing reads older than it is', () => {
    // Each of these three is a value where rounding to nearest and rounding down disagree,
    // which is the only kind of value that proves which one is running. The days case is the
    // one that matters in the product: an element set 3 days 23 hours old is on the live side
    // of the 3.5-day staleness guard and reading "4 d" would put it the wrong side of the
    // number the whole satellite layer is judged on.
    expect(age(3 * 86_400_000 + 23 * 3_600_000)).toContain('3 d 23 h old');
    expect(age(5 * 3_600_000 + 50 * 60_000)).toContain('5 h 50 min old');
    expect(age(46 * 60_000 + 50_000)).toContain('46 min old');

    // And a whole unit drops the second unit rather than printing a zero.
    expect(age(3 * 86_400_000)).toContain('3 d old');
    expect(age(5 * 3_600_000)).toContain('5 h old');
  });

  it('never reports a negative age for elements dated after the instant asked about', () => {
    // CelesTrak publishes an element set whose epoch is sometimes minutes into the future,
    // and "-3 min old" on a card reads as a bug in the product rather than in the feed.
    expect(age(-3 * 60_000)).toContain('0 min old');
  });
});

describe('against a real propagated orbit', () => {
  it('splits the ISS orbit in half and dates it to the recorded element set', () => {
    // End to end through the real propagator, so the split is proved against a track the
    // engine actually produced rather than only against the fixture shape above.
    const engine = new SatelliteEngine();
    engine.load([issElements()]);
    const when = new Date('2026-08-19T18:00:00Z');

    const orbit = engine.orbitAt(25_544, when)!;
    const split = splitTrack(orbit);

    expect(split.behind.length / 3).toBe(91);
    expect(split.ahead.length / 3).toBe(91);
    expect(forwardHorizonMs(orbit) / 60_000).toBeCloseTo(46.45, 1);
    expect(trackProvenance(orbit, when.getTime())).toContain('5 h 11 min old');
  });
});
