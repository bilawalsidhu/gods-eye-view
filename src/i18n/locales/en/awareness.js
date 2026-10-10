/** Global Context (Contacts) panel (src/layers/awareness). */
export default {
  count: {
    atLeast: 'At least {n}',
  },
  standby: {
    ready: 'CONTEXT READY',
    off: 'GLOBAL CONTEXT OFF',
    selectPrompt: 'SELECT A FLIGHT, VESSEL, OR MAPPED INSTALLATION',
    enablePrompt: 'ENABLE TO LOAD OBSERVED / MAPPED PROXIMITY',
  },
  cohort: {
    flights: 'Flights',
    military: 'Military flights',
    aisLiveVessels: 'AIS vessels',
    militaryInstallations: 'Mapped installations',
  },
  coverage: {
    currentViewportOnly: 'CURRENT VIEWPORT ONLY',
  },
  reason: {
    feedUnavailable: 'feed unavailable',
    feedStale: 'feed stale',
    nearby: 'observed or mapped nearby context',
    none: 'no observed or mapped objects in current feeds',
  },
  row: {
    unavailableAria: 'Unavailable',
    focusAria: 'Focus {label}',
    pageLabel: ' · {page}/{pages}',
  },
  namedAreas: 'Named areas ({n})',
  subject: {
    window: '{subject} · {distance} FLIGHT / VESSEL WINDOW',
  },
  nav: {
    aria: 'Global Context navigation',
    prevTitle: 'Previous — prior visited contact in the 250 km window',
    prev: 'PREVIOUS',
    focus: 'FOCUS',
    nextTitle: 'Next — nearest unvisited contact in the 250 km window',
    next: 'NEXT',
  },
  note: {
    disclaimer:
      'Open-source mapped/observed context. Missing broadcasts, unloaded map areas, or unmapped sites are not evidence of absence.',
  },
};
