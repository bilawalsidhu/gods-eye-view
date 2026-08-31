/**
 * Satellite element sets for tests. Not imported by anything that ships.
 *
 * Two builders. `makeSatellite` is the shaped-by-the-contract default, so a required field
 * added to the backend breaks these tests rather than passing with a hole in it.
 * `issElements` reads the recorded CelesTrak payload off disk, because the one test that
 * proves the propagation maths has to run on real elements rather than plausible ones.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Satellite } from '../types/entities';

/** The ISS record as CelesTrak published it, straight off the recorded fixture. */
export interface OmmFixture {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE: number;
  CLASSIFICATION_TYPE: string;
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
}

/**
 * `tests/fixtures/celestrak_iss_omm.json`, the real recorded CelesTrak GP record for NORAD
 * 25544 at epoch 2026-08-19T12:48:46.640160Z.
 *
 * Read from the repository's own fixture directory rather than copied into the frontend, so
 * there is exactly one recorded payload and the backend and the browser are propagating the
 * same bytes.
 */
export function issOmm(): OmmFixture {
  const file = path.join(import.meta.dirname, '../../../tests/fixtures/celestrak_iss_omm.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as OmmFixture[];
  const record = parsed[0];
  if (record === undefined) {
    throw new Error(`${file} is empty`);
  }
  return record;
}

/**
 * The recorded ISS record mapped into the backend's domain contract.
 *
 * The mapping the backend adapter performs, done here so the frontend test propagates the
 * real elements through the real contract shape. UTC is attached to the naive `EPOCH`
 * exactly as the adapter does, and serialised with a `Z`: an offset-suffixed `+00:00` is the
 * one thing that turns every satellite into a silent NaN.
 */
export function issElements(overrides: Partial<Satellite> = {}): Satellite {
  const omm = issOmm();
  return {
    kind: 'satellite',
    norad_cat_id: omm.NORAD_CAT_ID,
    object_name: omm.OBJECT_NAME,
    object_id: omm.OBJECT_ID,
    classification_type: omm.CLASSIFICATION_TYPE,
    epoch: `${omm.EPOCH}Z`,
    mean_motion: omm.MEAN_MOTION,
    eccentricity: omm.ECCENTRICITY,
    inclination_deg: omm.INCLINATION,
    ra_of_asc_node_deg: omm.RA_OF_ASC_NODE,
    arg_of_pericenter_deg: omm.ARG_OF_PERICENTER,
    mean_anomaly_deg: omm.MEAN_ANOMALY,
    bstar: omm.BSTAR,
    mean_motion_dot: omm.MEAN_MOTION_DOT,
    mean_motion_ddot: omm.MEAN_MOTION_DDOT,
    ephemeris_type: omm.EPHEMERIS_TYPE,
    element_set_no: omm.ELEMENT_SET_NO,
    rev_at_epoch: omm.REV_AT_EPOCH,
    group: 'stations',
    fetched_at: '2026-08-19T13:00:00Z',
    source: 'celestrak',
    ...overrides,
  };
}

/**
 * A plausible element set, for tests that care about plumbing rather than about orbits.
 *
 * Built off the real ISS record so it propagates, with only the catalogue number moved, and
 * with a fresh epoch so the 3.5-day staleness guard does not silently swallow it.
 */
export function makeSatellite(overrides: Partial<Satellite> = {}): Satellite {
  return issElements({ norad_cat_id: 90_001, object_name: 'TEST OBJECT', ...overrides });
}
