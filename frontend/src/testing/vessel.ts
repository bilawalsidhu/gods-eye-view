/**
 * A minimal valid `Vessel` for tests. Not imported by anything that ships.
 *
 * Shaped by the generated contract, so a required field added to the backend breaks the
 * tests here rather than passing with a hole in it. The values are a real shape rather
 * than a real ship: the MMSI is a valid Finnish ship-station number, which is what the
 * contract's MMSI rules demand, and any test that cares about a field sets it.
 */

import type { Vessel } from '../domain/vessel';

export function makeVessel(overrides: Partial<Vessel> = {}): Vessel {
  return {
    kind: 'vessel',
    mmsi: '230123450',
    point: { lon: 24.95, lat: 60.16, altitude_m: null },
    observed_at: '2026-08-19T12:00:00Z',
    position_age_s: 12,
    source: 'digitraffic',
    // Every provider that saw the ship, freshest first, so the first is `source`. The
    // backend attaches it at the merge, so a served record always has at least one.
    providers: ['digitraffic'],
    name: 'FINNMAID',
    call_sign: 'OJPQ',
    ship_type: 60,
    course_over_ground_deg: 187.4,
    speed_over_ground_mps: 8.2,
    true_heading_deg: 190,
    navigational_status: 'under_way_using_engine',
    ...overrides,
  };
}
