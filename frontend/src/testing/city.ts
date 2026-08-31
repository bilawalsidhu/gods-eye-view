/**
 * A minimal valid `City` for tests. Not imported by anything that ships.
 *
 * Shaped by the generated contract, so a required field added to the backend breaks the
 * tests here rather than passing with a hole in it. The defaults are the real London GB
 * row from `cities15000.txt`, measured 2026-08-19: geonames id 2643743, population
 * 8,961,989, feature code PPLC, admin1 `ENG` rather than a FIPS code. Any test that cares
 * about a field sets it.
 */

import type { City } from '../types/entities';

export function makeCity(overrides: Partial<City> = {}): City {
  return {
    kind: 'city',
    geonames_id: 2_643_743,
    name: 'London',
    ascii_name: 'London',
    point: { lon: -0.12574, lat: 51.50853, altitude_m: null },
    feature_code: 'PPLC',
    country_code: 'GB',
    admin1_code: 'ENG',
    population: 8_961_989,
    timezone: 'Europe/London',
    elevation_m: 25,
    modification_date: '2026-08-18',
    ...overrides,
  };
}
