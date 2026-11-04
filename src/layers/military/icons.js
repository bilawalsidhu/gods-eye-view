import { createAircraftIcons } from '../../data/aircraftIconLayer.js';
import {
  COCKPIT_CONTACT_SIZE_PX,
  COURSE_MAX_DPS,
  RENDER_DELAY_SEC,
} from './policy.js';

/** The military layer's contacts as one icon set (`createAircraftIcons`). */
export function createIcons({ flightState, services, parts }) {
  return createAircraftIcons({
    state: flightState,
    services,
    parts,
    layerId: 'military',
    renderDelaySec: RENDER_DELAY_SEC,
    courseMaxDps: COURSE_MAX_DPS,
    cockpitContactSizePx: COCKPIT_CONTACT_SIZE_PX,
  });
}
