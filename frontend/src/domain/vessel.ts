/**
 * Values derived from a `Vessel` rather than carried on the wire.
 *
 * Same rule as `derive.ts` for aircraft: these mirror properties of the same name on the
 * backend contract (`Vessel.label` and `Vessel.flag_mid` in
 * `src/tracker/contracts/vessel.py`), computed here because a pydantic computed field
 * cannot be validated back in under `extra="forbid"`. Keep them trivial and keep them
 * tested; anything that needs real logic belongs on the wire instead.
 *
 * The ship-type table is the one thing here with no backend counterpart. The contract
 * carries the raw AIS ship-and-cargo-type code and deliberately says nothing about
 * labelling it, so the label is a display value and display values are computed in the
 * frontend.
 */

export type { Vessel } from '../types/entities';
import type { Vessel } from '../types/entities';

/**
 * AIS ship-and-cargo-type codes that name a specific craft, per ITU-R M.1371.
 *
 * A Map rather than an object literal for the same reason as the squawk table in
 * `ui/card.ts`: the code comes off the wire, and `Object.prototype` has no business being
 * reachable from it.
 */
const SHIP_TYPE_EXACT: ReadonlyMap<number, string> = new Map([
  [30, 'Fishing'],
  [31, 'Towing'],
  [32, 'Towing, long or wide'],
  [33, 'Dredging or underwater operations'],
  [34, 'Diving operations'],
  [35, 'Military operations'],
  [36, 'Sailing'],
  [37, 'Pleasure craft'],
  [50, 'Pilot vessel'],
  [51, 'Search and rescue'],
  [52, 'Tug'],
  [53, 'Port tender'],
  [54, 'Anti-pollution'],
  [55, 'Law enforcement'],
  [58, 'Medical transport'],
  [59, 'Noncombatant'],
]);

/**
 * The tens digit, where it names a category on its own.
 *
 * The units digit inside 20s, 40s, 70s and 80s encodes an IMO hazardous-cargo category
 * (A to D) rather than a different kind of ship, so it is dropped: the category is what a
 * card can state without qualification. 3 and 5 are absent on purpose, because their tens
 * digit is not a category. Everything inside them is listed above, and what is not listed
 * (38, 39, 56, 57) is reserved or locally assigned and so has no meaning to report.
 */
const SHIP_TYPE_GROUPS: ReadonlyMap<number, string> = new Map([
  [2, 'Wing in ground'],
  [4, 'High-speed craft'],
  [6, 'Passenger'],
  [7, 'Cargo'],
  [8, 'Tanker'],
  [9, 'Other type'],
]);

/**
 * What kind of ship this is, or `null` when the code says nothing.
 *
 * `null` covers three cases and they all display the same way: the feed sent 0 (not
 * available, which the adapter already mapped away), the code is in the 1 to 19 range the
 * standard reserves, or it is one of the four reserved and locally assigned codes. None of
 * them is a type, so none of them gets a substitute.
 */
export function shipTypeLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined) {
    return null;
  }
  return SHIP_TYPE_EXACT.get(code) ?? SHIP_TYPE_GROUPS.get(Math.floor(code / 10)) ?? null;
}

/**
 * The best available human label, preferring what a port would call her.
 *
 * Mirrors `Vessel.label`. 108 of 1,058 positions on the live feed had no static record
 * and so no name, which is normal rather than an error, and the MMSI is always there.
 */
export function vesselLabel(vessel: Vessel): string {
  return vessel.name ?? vessel.call_sign ?? vessel.mmsi;
}

/**
 * The ITU MID, the first three digits of the MMSI. Mirrors `Vessel.flag_mid`.
 *
 * This is as far as the flag goes today, and it is a fact rather than a guess. Turning a
 * MID into a flag state needs the published ITU table, which is a phase 5 job on the
 * backend, and one MID can cover several territories (306 is Bonaire, Curacao and Sint
 * Maarten), so a MID narrows a flag rather than asserting one. Nothing here guesses a
 * country from three digits.
 */
export function flagMid(vessel: Vessel): string {
  return vessel.mmsi.slice(0, 3);
}

/**
 * Whether this vessel is actually moving, which the layer uses for both dead reckoning
 * and labelling.
 *
 * Course over ground, not true heading: the heading is where the bow points and a vessel
 * in a tideway carries one well off its track. Extrapolating along the heading would draw
 * a course no receiver reported.
 *
 * The navigational status is not consulted. It is typed in by the master and disagrees
 * with the vessel's behaviour often enough that the contract says so; the speed is a
 * measurement. A ship reporting way on while set to "moored" is a ship that is moving.
 */
export function isUnderWay(vessel: Vessel): boolean {
  const speed = vessel.speed_over_ground_mps;
  return (
    speed !== null &&
    speed !== undefined &&
    speed > 0 &&
    vessel.course_over_ground_deg !== null &&
    vessel.course_over_ground_deg !== undefined
  );
}
