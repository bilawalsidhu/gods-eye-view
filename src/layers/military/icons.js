import { createAircraftIcons } from '../../data/aircraftIconLayer.js';
import { placeAircraftAt } from '../flights/placed.js';
import {
  COCKPIT_CONTACT_SIZE_PX,
  COURSE_MAX_DPS,
  STALE_ALPHA,
  followsClock,
} from './policy.js';

/** The military layer's contacts as one icon set (`createAircraftIcons`). */
export function createIcons({ flightState, services, parts, resolveAsset }) {
  return createAircraftIcons({
    state: flightState,
    services,
    parts,
    resolveAsset,
    layerId: 'military',
    displayDelay: flightState._displayDelay,
    followsClock: () => followsClock(flightState),
    staleAlpha: STALE_ALPHA,
    courseMaxDps: COURSE_MAX_DPS,
    cockpitContactSizePx: COCKPIT_CONTACT_SIZE_PX,
    // A host-supplied placement, if any, draws a live contact where it places it.
    placeAt: services.placement
      ? (icao24, wallMs, info, history, out) =>
          placeAircraftAt(
            services.placement,
            icao24,
            wallMs,
            info,
            history,
            out,
          )
      : null,
  });
}
