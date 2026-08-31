/**
 * A minimal valid `Aircraft` for tests. Not imported by anything that ships.
 *
 * Shaped by the generated contract, so a required field added to the backend breaks the
 * tests here rather than passing with a hole in it. Values are plausible rather than
 * meaningful: any test that cares about a field sets it.
 */

import type { Aircraft } from '../types/entities';

export function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    kind: 'aircraft',
    icao24: '4ca7b5',
    point: { lon: -0.45, lat: 51.47, altitude_m: 3000 },
    observed_at: '2026-08-19T12:00:00Z',
    position_age_s: 1.2,
    source: 'adsb.lol',
    callsign: 'BAW123',
    aircraft_class: 'commercial',
    emergency: 'none',
    is_military: false,
    message_source: 'adsb_icao',
    messages_received: 4200,
    non_icao_address: false,
    on_ground: false,
    on_ladd: false,
    providers: [],
    uses_privacy_address: false,
    ground_speed_mps: 220,
    track_deg: 94.5,
    ...overrides,
  };
}
