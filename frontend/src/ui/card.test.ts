import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARD_ICON_PX,
  DEFAULT_FEED_INTERVAL_SECONDS,
  LOOKING_UP,
  LOOKUP_FAILED,
  NOT_HELD,
  NOT_IN_REGISTER,
  NO_OWNER_RECORDED,
  ageSeverity,
  aircraftIconShape,
  cardIconElement,
  emergencyText,
  fixAgeSeconds,
  formatAge,
  ownerText,
  paintCardIcon,
  providerText,
} from './card';
import { iconImage } from '../globe/icons';
import type { IconShape } from '../globe/icons';
import { AIRCRAFT_ICON_PX, AIRCRAFT_SELECTED_ICON_PX, colourFor } from '../globe/palette';
import { makeAircraft } from '../testing/aircraft';
import type { Aircraft, AircraftDetail } from '../types/entities';

/**
 * How much of a selected icon is silhouette rather than halo.
 *
 * `icons.ts` draws the plain variant in a 96-unit box and the selected variant in a 160-unit
 * one, so the shape itself is 96/160 of whatever pixel size it is asked for. Not exported from
 * there, because both view boxes are private to it, so it is restated here with its arithmetic
 * rather than reached for.
 */
const SELECTED_SILHOUETTE_FRACTION = 96 / 160;

/**
 * The card head icon, shared by all four cards.
 *
 * Painted against a fake element, because the runner has no document. What is asserted here is
 * that the icon comes out of `globe/icons.ts` rather than being drawn twice, that it is the
 * selected variant at the size this module claims, and that the state a colour carries on the
 * globe reaches the card instead of being flattened to one hue.
 */
describe('the card head icon', () => {
  /** Just enough of an element for `cardIconElement` to write into and a test to read back. */
  class FakeElement {
    readonly attributes: Record<string, string> = {};
    className = '';

    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
    }
  }

  function icon(): FakeElement {
    return cardIconElement() as unknown as FakeElement;
  }

  /**
   * One cast, here, rather than one at every call site.
   *
   * `IconShape` rather than a hand-written union of the three shapes these tests use. That
   * module renamed a shape mid-flight once already and the import is what failed loudly; a
   * local union would have gone on compiling against a name that no longer exists.
   */
  function paint(element: FakeElement, shape: IconShape, fill: string): void {
    paintCardIcon(element as unknown as HTMLElement, shape, fill);
  }

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (): FakeElement => new FakeElement(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is never smaller than the largest mark on the globe', () => {
    // "Fewer and clearer, never smaller" is the rule, and the card has room.
    expect(CARD_ICON_PX).toBeGreaterThan(AIRCRAFT_SELECTED_ICON_PX);
  });

  it('draws a bigger silhouette than the globe does, not just a bigger box', () => {
    // The assertion that caught a real mistake. The selected view box is 160 units against the
    // plain variant's 96, so only 60 per cent of the figure above is silhouette. At 44px that
    // is 26.4px of aircraft against the globe's plain 26px mark: an icon that looked larger
    // than anything on the globe while drawing a shape no clearer than the smallest one.
    expect(CARD_ICON_PX * SELECTED_SILHOUETTE_FRACTION).toBeGreaterThan(AIRCRAFT_ICON_PX);
  });

  it('is decorative, because everything it says is already on the card in words', () => {
    // An empty alt rather than a missing one. A screen reader announcing "aircraft" before
    // reading "Aircraft · Boeing 737" is noise, and the emergency state it colours for has its
    // own alert line.
    const element = icon();

    expect(element.attributes['alt']).toBe('');
    expect(element.className).toBe('card-icon');
  });

  it('carries its own dimensions, so it needs no sizing CSS', () => {
    const element = icon();

    expect(element.attributes['width']).toBe('56');
    expect(element.attributes['height']).toBe('56');
  });

  it('draws the silhouette icons.ts generates, rather than a second copy of it', () => {
    // The whole reason this goes through `globe/icons.ts`: one set of geometry, so a card and
    // the globe cannot disagree about what a ship looks like.
    const element = icon();
    paint(element, 'ship', '#2ec8d8');

    expect(element.attributes['src']).toBe(iconImage('ship', '#2ec8d8', true, CARD_ICON_PX));
    expect(element.attributes['src']).toContain('data:image/svg+xml,');
  });

  it('draws the selected variant, which is what carries the contrast on a dark panel', () => {
    // The globe's casing is black, which is nearly the card panel's own value, so the halo is
    // what stops a stopped vessel's #4d6373 sitting at 2.95:1 against it.
    const element = icon();
    paint(element, 'ship', '#4d6373');

    expect(element.attributes['src']).toBe(iconImage('ship', '#4d6373', true, CARD_ICON_PX));
    expect(element.attributes['src']).not.toBe(iconImage('ship', '#4d6373', false, CARD_ICON_PX));
  });

  it('repaints to the identical string, so an unchanged icon is not re-decoded', () => {
    // `iconImage` caches on its arguments and Cesium relies on the same fact. The aircraft card
    // repaints on every fix, so a fresh string per paint would drop and re-decode the image
    // several times a minute.
    const element = icon();
    paint(element, 'plane', '#4da3ff');
    const first = element.attributes['src'];
    paint(element, 'plane', '#4da3ff');

    expect(element.attributes['src']).toBe(first);
  });

  it('lets the class colour through, so military still reads military', () => {
    const military = icon();
    const commercial = icon();
    paint(military, 'plane', colourFor('military', false));
    paint(commercial, 'plane', colourFor('commercial', false));

    expect(military.attributes['src']).not.toBe(commercial.attributes['src']);
  });

  it('lets the emergency colour through, so the state is not lost on the way to the card', () => {
    // `colourFor` overrides the class hue with red in an emergency. If that did not reach the
    // icon, the one card that most needs to look different would look like every other one.
    const emergency = icon();
    const normal = icon();
    paint(emergency, 'plane', colourFor('commercial', true));
    paint(normal, 'plane', colourFor('commercial', false));

    expect(emergency.attributes['src']).not.toBe(normal.attributes['src']);
    expect(emergency.attributes['src']).toContain(
      encodeURIComponent(colourFor('commercial', true)),
    );
  });
});

/**
 * Which silhouette an aircraft gets, which is a claim about the data rather than a style pick.
 *
 * The rule the whole set of card icons turns on: never draw an arrow for a record that reported
 * no direction. Roughly half of live ADS-B records arrive without `track`, so this is the
 * ordinary case.
 */
/** An aircraft with `track_deg` genuinely absent rather than set to undefined. */
function withoutTrack(): Aircraft {
  const record: Record<string, unknown> = { ...makeAircraft() };
  delete record['track_deg'];
  return record as unknown as Aircraft;
}

describe('aircraftIconShape', () => {
  it('draws an aircraft when a track was reported', () => {
    expect(aircraftIconShape(makeAircraft({ track_deg: 187.4 }))).toBe('plane');
    // Zero is a real bearing, not a missing one.
    expect(aircraftIconShape(makeAircraft({ track_deg: 0 }))).toBe('plane');
  });

  it('refuses to draw an arrow for an aircraft that reported no track', () => {
    // The silhouette is a swept plan view, so it is an arrow whether or not it is rotated, and
    // a reader who has watched the same shape point at real headings on the globe reads its
    // nose as one. Inventing a heading nobody reported is the failure this prevents.
    expect(aircraftIconShape(makeAircraft({ track_deg: null }))).toBe('disc');
  });

  it('refuses it just as firmly when the server omitted the field altogether', () => {
    // Both shapes of absent, and they are not the same shape to the compiler. `track_deg` is
    // optional in the generated contract, so the server may send null or send nothing, and
    // `exactOptionalPropertyTypes` forbids writing the second as `{ track_deg: undefined }`.
    // It is the same value at runtime and it is the one a missing key produces.
    expect(aircraftIconShape(withoutTrack())).toBe('disc');
  });

  it('agrees with the globe about the same record', () => {
    // `layers/aircraft.ts` branches on `record.track_deg ?? null` for exactly this. Two
    // different shapes for one aircraft is the disagreement importing from one module exists
    // to prevent, and it would have shown up on the records where the data is thinnest.
    const tracked = makeAircraft({ track_deg: 90 });
    const untracked = makeAircraft({ track_deg: null });

    expect(aircraftIconShape(tracked)).not.toBe(aircraftIconShape(untracked));
  });
});

describe('formatAge', () => {
  it('reads in seconds under a minute', () => {
    expect(formatAge(0)).toBe('0s ago');
    expect(formatAge(1.4)).toBe('1s ago');
    expect(formatAge(59)).toBe('59s ago');
  });

  it('reads in minutes and seconds up to an hour', () => {
    expect(formatAge(60)).toBe('1m 0s ago');
    expect(formatAge(95)).toBe('1m 35s ago');
    expect(formatAge(3599)).toBe('59m 59s ago');
  });

  it('reads in hours and minutes beyond that', () => {
    expect(formatAge(3600)).toBe('1h 0m ago');
    expect(formatAge(7500)).toBe('2h 5m ago');
  });

  it('never shows a negative age, which a clock nudge could otherwise produce', () => {
    expect(formatAge(-4)).toBe('0s ago');
  });
});

describe('ageSeverity', () => {
  const interval = 8;

  it('treats anything up to two intervals as fresh, because one missed poll is noise', () => {
    expect(ageSeverity(0, interval)).toBe('fresh');
    expect(ageSeverity(8, interval)).toBe('fresh');
    expect(ageSeverity(16, interval)).toBe('fresh');
  });

  it('turns amber past two intervals', () => {
    expect(ageSeverity(16.1, interval)).toBe('amber');
    expect(ageSeverity(32, interval)).toBe('amber');
  });

  it('turns red past four intervals', () => {
    expect(ageSeverity(32.1, interval)).toBe('red');
    expect(ageSeverity(600, interval)).toBe('red');
  });

  it('scales with the feed, so a slow feed is not permanently red', () => {
    // The military endpoint is polled every 30 seconds, so 40 seconds old is normal there
    // and badly stale on the eight-second viewport feed.
    expect(ageSeverity(40, 30)).toBe('fresh');
    expect(ageSeverity(40, 8)).toBe('red');
  });

  it('falls back to the documented adsb.lol cadence', () => {
    expect(DEFAULT_FEED_INTERVAL_SECONDS).toBe(8);
    expect(ageSeverity(40)).toBe('red');
  });
});

describe('fixAgeSeconds', () => {
  it('adds elapsed local time to the age the feed reported', () => {
    const tracked = {
      aircraft: makeAircraft({ position_age_s: 2.5 }),
      layer: 'aircraft' as const,
      receivedAtMs: 1_000_000,
    };

    expect(fixAgeSeconds(tracked, 1_000_000)).toBeCloseTo(2.5, 6);
    expect(fixAgeSeconds(tracked, 1_012_000)).toBeCloseTo(14.5, 6);
  });

  it('ignores the server clock, so browser clock skew cannot fake staleness', () => {
    // observed_at is years in the past; the age must not be affected by it.
    const tracked = {
      aircraft: makeAircraft({ position_age_s: 0, observed_at: '2001-01-01T00:00:00Z' }),
      layer: 'aircraft' as const,
      receivedAtMs: 5000,
    };

    expect(fixAgeSeconds(tracked, 9000)).toBeCloseTo(4, 6);
  });
});

describe('emergencyText', () => {
  it('says nothing for a normal aircraft', () => {
    expect(emergencyText('none', '2000')).toBeNull();
    expect(emergencyText('none', null)).toBeNull();
  });

  it('names the squawk code, which is what a controller would say', () => {
    expect(emergencyText('none', '7700')).toBe('Squawk 7700, general emergency');
    expect(emergencyText('none', '7600')).toBe('Squawk 7600, radio failure');
    expect(emergencyText('none', '7500')).toBe('Squawk 7500, unlawful interference');
  });

  it('falls back to the broadcast emergency field when the squawk is ordinary', () => {
    expect(emergencyText('minfuel', '1200')).toBe('Minimum fuel');
    expect(emergencyText('downed', null)).toBe('Downed aircraft');
  });
});

describe('providerText', () => {
  it('names every provider that saw the aircraft, freshest first', () => {
    const record = makeAircraft({
      source: 'airplanes.live',
      providers: ['airplanes.live', 'adsb.lol'],
    });

    expect(providerText(record)).toBe('airplanes.live, adsb.lol');
  });

  it('falls back to the record own source when no merge has touched it', () => {
    expect(providerText(makeAircraft({ source: 'adsb.fi', providers: [] }))).toBe('adsb.fi');
  });
});

function detail(overrides: Partial<AircraftDetail> = {}): AircraftDetail {
  return {
    aircraft: makeAircraft(),
    registry: null,
    registry_attribution: null,
    joined_at: null,
    conflicts: [],
    degraded_reason: null,
    ...overrides,
  };
}

describe('ownerText', () => {
  it('says it is still looking while the answer is in flight', () => {
    expect(ownerText('pending')).toBe(LOOKING_UP);
  });

  it('separates a request that failed from one still in flight', () => {
    // Nothing retries, so a swallowed rejection used to read "looking up" for as long as the
    // card stayed open: a failed request and a request in progress looked identical.
    expect(ownerText('unreachable')).toBe(LOOKUP_FAILED);
    expect(ownerText('unreachable')).not.toBe(LOOKING_UP);
  });

  it('separates the server no longer holding the aircraft from either of those', () => {
    expect(ownerText('not-held')).toBe(NOT_HELD);
    expect(ownerText('not-held')).not.toBe(LOOKING_UP);
  });

  it('reads whether the register holds the airframe off registry, not off the owner', () => {
    // owner is optional by contract, so a register that answered and holds the airframe with
    // no owner recorded is reachable by design. Branching on the owner string called that
    // "not in this register" while the card footer printed that register's own credit.
    const held = detail({ registry: 'adsbdb', aircraft: makeAircraft({ owner: null }) });

    expect(ownerText(held)).toBe(NO_OWNER_RECORDED);
    expect(ownerText(held)).not.toBe(NOT_IN_REGISTER);
  });

  it('prints the registered owner when the register holds the airframe', () => {
    const held = detail({
      aircraft: makeAircraft({ owner: 'Adobe Inc' }),
      registry: 'adsbdb',
    });

    expect(ownerText(held)).toBe('Adobe Inc');
  });

  it('separates a register that does not hold it from one that did not answer', () => {
    // About one live aircraft in five is genuinely absent from adsbdb, which is normal
    // operation rather than a fault, so the two must not read the same on the card.
    expect(ownerText(detail())).toBe(NOT_IN_REGISTER);
    expect(ownerText(detail({ degraded_reason: 'ConnectTimeout' }))).toBe(
      'registry unavailable (ConnectTimeout)',
    );
  });
});
