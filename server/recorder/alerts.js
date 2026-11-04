import { aircraftEmergency } from '../../src/data/aircraftEmergency.js';

const MAX_ACTIVE = 50000;
/** A contact quiet for this long and then broadcasting again raises a new alert. */
const REARM_SEC = 30 * 60;

/**
 * Raises one alert when a contact starts broadcasting an emergency squawk or
 * ADS-B emergency status, not one per poll. The same status from the same
 * contact stays quiet until it has gone unseen for half an hour. The status is
 * only what the transponder broadcast: crews pass through 7x00 codes while
 * dialling, so an alert is a prompt to look, not a finding.
 */
export function createEmergencyWatcher() {
  /** @type {Map<string, number>} layer:id:kind -> last time it was broadcast */
  const active = new Map();
  return function check(point) {
    if (!point.squawk && !point.emergency) return null;
    const status = aircraftEmergency({
      squawk: point.squawk,
      emergency: point.emergency,
    });
    if (!status) return null;
    const key = `${point.layer}:${point.id}:${status.kind}`;
    const last = active.get(key);
    active.delete(key);
    active.set(key, point.ts);
    if (active.size > MAX_ACTIVE) active.delete(active.keys().next().value);
    if (last !== undefined && point.ts - last < REARM_SEC) return null;
    return {
      ts: point.ts,
      code: status.kind,
      severity: status.severity,
      id: point.id,
      layer: point.layer,
      name: point.name ?? '',
      lat: point.lat,
      lon: point.lon,
      detail: status.squawk ?? '',
    };
  };
}
