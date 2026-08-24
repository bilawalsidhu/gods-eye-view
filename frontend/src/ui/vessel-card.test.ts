/**
 * The vessel card's pure logic. The painting is covered by the Playwright suite, which has
 * a real document; this file is the node-environment half, same split as `card.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VESSEL_FEED_INTERVAL_SECONDS,
  etaText,
  flagText,
  navStatusText,
  speedText,
  vesselFixAgeSeconds,
  vesselIconFill,
  vesselIconShape,
} from './vessel-card';
import { STOPPED_COLOUR, UNDER_WAY_COLOUR } from '../globe/layers/vessels';
// The bearing wording is one function for both cards: an aircraft's track and a vessel's
// course are the same measurement, so this is the shared one being exercised on vessel data.
import { ageSeverity, bearingText } from './card';
import { makeVessel } from '../testing/vessel';
import type { Vessel } from '../domain/vessel';

/**
 * The one card icon that carries a state rather than labelling a type.
 *
 * Asserted against the layer's own constants rather than against hex strings, because the point
 * of importing them is that the card and the globe answer the same for the same ship.
 */
/** A vessel with `course_over_ground_deg` genuinely absent rather than set to undefined. */
function withoutCourse(): Vessel {
  const record: Record<string, unknown> = { ...makeVessel() };
  delete record['course_over_ground_deg'];
  return record as unknown as Vessel;
}

describe('vesselIconShape', () => {
  it('draws a hull when a course over ground was reported', () => {
    expect(vesselIconShape(makeVessel({ course_over_ground_deg: 187.4 }))).toBe('ship');
    // `cog` legitimately reads 0.0, which is why 360.0 is the provider's not-available value.
    expect(vesselIconShape(makeVessel({ course_over_ground_deg: 0 }))).toBe('ship');
  });

  it('refuses to draw a bow direction for a ship that reported no course', () => {
    // 110 of 1,058 live records sent the 360.0 not-available course, which the adapter maps to
    // null. Pointing a hull somewhere on the strength of a sentinel is inventing a course.
    expect(vesselIconShape(makeVessel({ course_over_ground_deg: null }))).toBe('block');
  });

  it('refuses it just as firmly when the server omitted the field altogether', () => {
    // The field is optional in the generated contract, so absent and null both arrive, and
    // `exactOptionalPropertyTypes` will not let the second be written as an explicit undefined.
    expect(vesselIconShape(withoutCourse())).toBe('block');
  });

  it('agrees with the globe about the same record', () => {
    // `layers/vessels.ts` branches on `record.course_over_ground_deg ?? null` for exactly this.
    const steering = makeVessel({ course_over_ground_deg: 90 });
    const adrift = makeVessel({ course_over_ground_deg: null });

    expect(vesselIconShape(steering)).not.toBe(vesselIconShape(adrift));
  });
});

describe('vesselIconFill', () => {
  it('paints a moving ship in the globe under-way colour', () => {
    const moving = makeVessel({ speed_over_ground_mps: 6.2, course_over_ground_deg: 187.4 });

    expect(vesselIconFill(moving)).toBe(UNDER_WAY_COLOUR);
  });

  it('paints a stopped ship in the globe stopped colour', () => {
    const moored = makeVessel({ speed_over_ground_mps: 0, course_over_ground_deg: 187.4 });

    expect(vesselIconFill(moored)).toBe(STOPPED_COLOUR);
  });

  it('treats a ship with no reported course as stopped, because it cannot be tracked', () => {
    // 110 of 1,058 live records sent the 360.0 not-available course, which the adapter maps to
    // null. Dead reckoning has nothing to extrapolate along, so the globe holds it still and
    // the card says the same.
    const noCourse = makeVessel({ speed_over_ground_mps: 6.2, course_over_ground_deg: null });

    expect(vesselIconFill(noCourse)).toBe(STOPPED_COLOUR);
  });

  it('believes the speed over the broadcast status, the way the globe does', () => {
    // A ship set to "moored" and making six knots is a ship that is moving. The status is typed
    // in by the master; the speed is a measurement.
    const movingButMoored = makeVessel({
      speed_over_ground_mps: 6.2,
      course_over_ground_deg: 12,
      navigational_status: 'moored',
    });

    expect(vesselIconFill(movingButMoored)).toBe(UNDER_WAY_COLOUR);
  });

  it('gives the two states different colours, or the icon would say nothing', () => {
    expect(UNDER_WAY_COLOUR).not.toBe(STOPPED_COLOUR);
  });
});

describe('speedText', () => {
  it('leads with knots, because that is the unit AIS and the bridge both use', () => {
    expect(speedText(8.2)).toBe('15.9 kt (8.2 m/s)');
    expect(speedText(0)).toBe('0.0 kt (0.0 m/s)');
  });

  it('says nothing when the feed reported no speed', () => {
    // 9 of 1,058 live records carried the 102.3-knot not-available sentinel, which the
    // adapter mapped to null.
    expect(speedText(null)).toBe('not reported');
    expect(speedText(undefined)).toBe('not reported');
  });
});

describe('bearingText', () => {
  it('reads in whole degrees true', () => {
    expect(bearingText(187.4)).toBe('187° true');
    expect(bearingText(0)).toBe('0° true');
  });

  it('says nothing when the feed reported no bearing', () => {
    // 184 of 1,058 live records sent heading 511, the not-available value.
    expect(bearingText(null)).toBe('not reported');
    expect(bearingText(undefined)).toBe('not reported');
  });
});

describe('flagText', () => {
  it('names the MID and refuses to name a country', () => {
    // The MID is a fact off the MMSI. The flag state needs the ITU table, which is phase
    // 5, and one MID can cover several territories, so nothing here guesses one.
    expect(flagText(makeVessel({ mmsi: '230123450' }))).toBe('not resolved (MMSI MID 230)');
  });
});

describe('navStatusText', () => {
  it('reads the status back in words and marks it as broadcast', () => {
    expect(navStatusText('moored')).toBe('Moored (as broadcast)');
    expect(navStatusText('under_way_using_engine')).toBe('Under way using engine (as broadcast)');
    expect(navStatusText('ais_sart_active')).toBe('Ais sart active (as broadcast)');
  });

  it('says nothing for the undefined and reserved codes', () => {
    // Code 15 alone was 47 of 1,058 live records, and the adapter maps it to null along
    // with the three reserved codes.
    expect(navStatusText(null)).toBe('not reported');
    expect(navStatusText(undefined)).toBe('not reported');
  });
});

describe('etaText', () => {
  it('reads month, day and time, and says out loud that there is no year', () => {
    // The AIS field is 20 packed bits with no year in it, so an ETA can never become a
    // date. 562112 decoded to this on the live feed for SERENADA.
    expect(etaText({ month: 8, day: 18, hour: 15, minute: 0 })).toBe(
      '18 Aug, 15:00 (no year broadcast)',
    );
    expect(etaText({ month: 9, day: 1, hour: 4, minute: 5 })).toBe(
      '1 Sep, 04:05 (no year broadcast)',
    );
  });

  it('says nothing when the ETA was unusable', () => {
    // 238 of 950 live records, mostly the 1596 not-available value.
    expect(etaText(null)).toBe('not reported');
    expect(etaText(undefined)).toBe('not reported');
  });

  it('degrades a month it cannot name to its number rather than dropping the ETA', () => {
    expect(etaText({ month: 13, day: 2, hour: 1, minute: 2 })).toBe(
      '2 13, 01:02 (no year broadcast)',
    );
  });
});

describe('vesselFixAgeSeconds', () => {
  it('adds the age the feed reported to the time since it arrived here', () => {
    const tracked = { vessel: makeVessel({ position_age_s: 12 }), receivedAtMs: 10_000 };

    expect(vesselFixAgeSeconds(tracked, 15_000)).toBe(17);
  });

  it('carries a genuinely old fix through rather than flattening it', () => {
    // Digitraffic's default query window is 24 hours, so this is a real answer and the
    // card has to show it as what it is.
    const tracked = { vessel: makeVessel({ position_age_s: 80_000 }), receivedAtMs: 10_000 };

    expect(vesselFixAgeSeconds(tracked, 10_000)).toBe(80_000);
    expect(ageSeverity(80_000, DEFAULT_VESSEL_FEED_INTERVAL_SECONDS)).toBe('red');
  });
});

describe('DEFAULT_VESSEL_FEED_INTERVAL_SECONDS', () => {
  it('matches the union cadence floor, so a healthy ship does not read as stale', () => {
    // Sixty seconds, from VESSEL_UNION_MIN_INTERVAL_SECONDS in src/tracker/app.py. On the
    // aircraft card's eight-second default, every vessel on the globe would be red.
    expect(DEFAULT_VESSEL_FEED_INTERVAL_SECONDS).toBe(60);
    expect(ageSeverity(90, DEFAULT_VESSEL_FEED_INTERVAL_SECONDS)).toBe('fresh');
    expect(ageSeverity(90, 8)).toBe('red');
  });
});
