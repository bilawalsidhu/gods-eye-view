/**
 * These pin logic that is deliberately duplicated in Python
 * (`Aircraft.label` and `Aircraft.in_emergency` in `src/tracker/contracts/aircraft.py`).
 *
 * Duplication across two languages is the cost of keeping derived values off the wire, and
 * a test is what stops the two copies drifting apart silently. The cases below mirror
 * `test_derived_properties_still_work_server_side` in `tests/contracts/test_aircraft.py`.
 */

import { describe, expect, it } from 'vitest';

import { makeAircraft } from '../testing/aircraft';
import { aircraftLabel, inEmergency } from './derive';

describe('aircraftLabel', () => {
  it('prefers the callsign, which is what a controller would say', () => {
    expect(aircraftLabel(makeAircraft({ callsign: 'GAF123', registration: '10+27' }))).toBe(
      'GAF123',
    );
  });

  it('falls back to the registration when there is no callsign', () => {
    expect(aircraftLabel(makeAircraft({ callsign: null, registration: '10+27' }))).toBe('10+27');
  });

  it('falls back to the uppercased address when nothing else is known', () => {
    expect(
      aircraftLabel(makeAircraft({ icao24: '3c6444', callsign: null, registration: null })),
    ).toBe('3C6444');
  });

  it('never returns an empty string, because the address is always present', () => {
    expect(aircraftLabel(makeAircraft({ callsign: null, registration: null }))).not.toBe('');
  });
});

describe('inEmergency', () => {
  it('is false for an ordinary aircraft', () => {
    expect(inEmergency(makeAircraft({ emergency: 'none', squawk: '1200' }))).toBe(false);
  });

  it.each(['7500', '7600', '7700'])('is true for the distress squawk %s', (squawk) => {
    expect(inEmergency(makeAircraft({ emergency: 'none', squawk }))).toBe(true);
  });

  it('is true on a broadcast emergency even when the squawk is routine', () => {
    // A crew may set one without the other, so neither signal alone is sufficient.
    expect(inEmergency(makeAircraft({ emergency: 'general', squawk: '1200' }))).toBe(true);
  });

  it('is false for a squawk that merely looks alarming', () => {
    expect(inEmergency(makeAircraft({ emergency: 'none', squawk: '7000' }))).toBe(false);
    expect(inEmergency(makeAircraft({ emergency: 'none', squawk: '7501' }))).toBe(false);
  });

  it('handles a missing squawk rather than throwing', () => {
    expect(inEmergency(makeAircraft({ emergency: 'none', squawk: null }))).toBe(false);
  });
});
