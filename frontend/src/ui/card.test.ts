import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEED_INTERVAL_SECONDS,
  ageSeverity,
  emergencyText,
  fixAgeSeconds,
  formatAge,
} from './card';
import { makeAircraft } from '../testing/aircraft';

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
