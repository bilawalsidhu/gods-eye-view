// English catalog — cockpit namespace (phase-1 seed).
//
// Owns the first-person cockpit HUD, its Contact summary, and the briefing
// carousel. Keys are namespace-relative; the registry prefixes them with
// `cockpit.`.
export const NAMESPACE = 'cockpit';

export default {
  // index.html #cockpit-hud section aria-label
  'hud.sectionLabel': 'Aircraft cockpit view',
  // index.html #map-view-switch button label
  'exit.label': 'EXIT COCKPIT',
  // index.html .cockpit-readout-label
  'readout.groundSpeed': 'GROUND SPEED',
  'readout.altitude': 'ALTITUDE',
  // index.html .cockpit-context-kicker / #cockpit-context-subject (initial)
  'context.kicker': 'CONTACT',
  'context.subjectWindow': 'CONTACTS · 250 KM',
  // index.html #cockpit-brief-kicker / #cockpit-brief-subtitle (initial)
  'brief.kicker': 'LIVE SIGNALS',
  'brief.subtitle': 'OBSERVED / MAPPED PINGS',
  // index.html #cockpit-vision-current small label
  'vision.current': 'CURRENT',
  // index.html #cockpit-radio-station (initial)
  'radio.station.ready': 'READY',
};
