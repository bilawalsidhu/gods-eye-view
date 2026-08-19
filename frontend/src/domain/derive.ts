/**
 * Values derived from an entity rather than carried on the wire.
 *
 * These deliberately mirror properties of the same name on the backend contracts
 * (`Aircraft.label` and `Aircraft.in_emergency` in `src/tracker/contracts/aircraft.py`).
 * They are computed here rather than serialised because a pydantic computed field cannot
 * be validated back in under `extra="forbid"`, which would leave the published wire format
 * unable to round-trip. See the comment block on the `Aircraft` contract.
 *
 * Because the definitions are duplicated across two languages, keep them trivial and keep
 * them tested. Anything that needs real logic belongs on the wire instead.
 */

import type { components } from '../types/api';

type Aircraft = components['schemas']['Aircraft'];

/**
 * Squawk codes that mean distress by convention: hijack, radio failure, general emergency.
 * Mirrors `_EMERGENCY_SQUAWKS` in the backend contract.
 */
const EMERGENCY_SQUAWKS: ReadonlySet<string> = new Set(['7500', '7600', '7700']);

/**
 * The best available human label, preferring what a controller would actually say.
 *
 * Falls back through callsign, then registration, then the uppercased ICAO address. The
 * address is always present, so this never returns an empty string.
 */
export function aircraftLabel(aircraft: Aircraft): string {
  return aircraft.callsign ?? aircraft.registration ?? aircraft.icao24.toUpperCase();
}

/**
 * True when either the broadcast emergency state or the squawk indicates distress.
 *
 * Both are checked because an aircraft may set one without the other: a crew squawking
 * 7700 has not necessarily set the ADS-B emergency field, and vice versa.
 */
export function inEmergency(aircraft: Aircraft): boolean {
  // No null check on `emergency`: the contract makes it a required enum, so 'none' is the
  // only way it says "nothing declared". A null guard here reads as if the field were
  // optional and would quietly survive the contract making it so.
  if (aircraft.emergency !== 'none') {
    return true;
  }
  return aircraft.squawk !== null && aircraft.squawk !== undefined
    ? EMERGENCY_SQUAWKS.has(aircraft.squawk)
    : false;
}
