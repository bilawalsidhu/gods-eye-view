/**
 * One fixed hue per aircraft class, plus the alert encoding.
 *
 * CSS colour strings rather than Cesium colours so the same values drive the map, the
 * info card and the status banner, and so the mapping can be tested without importing a
 * renderer. Red and orange are held back for alert states: nothing routine is allowed to
 * use them, or an emergency stops standing out.
 */

import type { AircraftClass } from '../types/entities';

/**
 * Total by construction: `Record` over the union means adding a class to the contract
 * fails to compile until it has a colour, rather than rendering as an invisible point.
 */
export const CLASS_COLOURS: Record<AircraftClass, string> = {
  unknown: '#8fa3b8',
  commercial: '#4da3ff',
  business_jet: '#b98cff',
  general_aviation: '#4ddbb0',
  military: '#ffd24d',
  helicopter: '#7ee081',
  anonymous: '#6f7a88',
};

/** Alert colour. Reserved: no class hue may be red. */
export const EMERGENCY_COLOUR = '#ff4d4d';

/** Colour of the selection outline, on top of whichever hue the class already has. */
export const SELECTION_COLOUR = '#ffffff';

export const POINT_PIXEL_SIZE = 7;

/**
 * Emergency aircraft are drawn larger as well as red.
 *
 * Colour alone would exclude anyone with a red/green deficiency, which is roughly one in
 * twelve men. Size is the redundant channel, so the state is legible without hue.
 */
export const EMERGENCY_PIXEL_SIZE = 13;

export const SELECTED_PIXEL_SIZE = 11;

/** The colour an aircraft of this class and state is drawn in. */
export function colourFor(aircraftClass: AircraftClass, inEmergency: boolean): string {
  return inEmergency ? EMERGENCY_COLOUR : CLASS_COLOURS[aircraftClass];
}

/** Point size in pixels for this state. Emergency wins over selection. */
export function pixelSizeFor(inEmergency: boolean, selected: boolean): number {
  if (inEmergency) {
    return EMERGENCY_PIXEL_SIZE;
  }
  return selected ? SELECTED_PIXEL_SIZE : POINT_PIXEL_SIZE;
}

/** Human label for a class, for the card and any list view. */
export const CLASS_LABELS: Record<AircraftClass, string> = {
  unknown: 'Unclassified',
  commercial: 'Commercial',
  business_jet: 'Business jet',
  general_aviation: 'General aviation',
  military: 'Military',
  helicopter: 'Helicopter',
  anonymous: 'Anonymous (privacy address)',
};
