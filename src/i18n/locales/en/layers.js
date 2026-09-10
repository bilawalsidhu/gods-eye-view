// English catalog — layers namespace (phase-1 seed).
//
// Owns data-layer presentation copy: display names, feed-state labels, and
// layer batch toasts. Machine-readable values (layer ids, status enum keys,
// provider names) are intentionally NOT here — see ai_docs/i18n-ownership.md
// for the keep-English boundary. Keys are namespace-relative; the registry
// prefixes them with `layers.`.
export const NAMESPACE = 'layers';

export default {
  // src/data/manager.js FEED_STATE_LABELS value
  'status.unavailable': 'UNAVAILABLE',
  // src/data/flights.js / src/data/earthquakes.js layer display names
  'name.liveFlights': 'Live Flights',
  'name.earthquakes': 'Earthquakes (24h)',
  // src/ui.js clearSelectedLayers() result toasts (genuine plural copy)
  'clear.toast.noneSelected': 'No selected data layers',
  'clear.toast.cleared': {
    one: 'Cleared {count} data layer',
    other: 'Cleared {count} data layers',
  },
  'clear.toast.notCleared': {
    one: '{count} data layer could not be cleared',
    other: '{count} data layers could not be cleared',
  },

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (ai_docs/i18n-ownership.md cross-surface rule); these keys cover the
  // layers-worker surfaces (world overlay, CCTV panel, Radio panel) whose
  // runtime presentation paths land here in phase 3.

  // index.html #world-overlay-actions region (src/overlays/worldOverlay.js)
  'overlay.regionAriaLabel': 'Visible map targets',

  // index.html CCTV panel chrome. Button texts marked as states (toggleOff,
  // coverageOff, autoHopOff, projectionOn) are the shipped initial values; the
  // phase-3 layer worker adds the flipped-state siblings.
  'cctv.panelTitle': 'CCTV',
  'cctv.collapseTitle': 'Collapse panel',
  'cctv.sourceUnknown': 'SOURCE · UNKNOWN',
  'cctv.metaIdle': 'Enable CCTV to load camera intersections',
  'cctv.toggleOff': 'CCTV OFF',
  'cctv.nearest': 'NEAREST',
  'cctv.prev': 'PREV',
  'cctv.cameraAriaLabel': 'CCTV camera',
  'cctv.next': 'NEXT',
  'cctv.focus': 'FOCUS',
  'cctv.coverageOff': 'COVERAGE OFF',
  'cctv.autoHopOff': 'AUTO HOP OFF',
  'cctv.projectionOn': 'PROJECTION ON',
  'cctv.calibrationLabel': 'CALIBRATION',
  'cctv.adjustLabel': 'ADJUST',
  'cctv.adjustTitle': 'Drag the camera in the world: rings rotate, arrows move, handles set range/FOV',
  'cctv.calPoseAriaLabel': 'Camera pose — click a value to type',
  'cctv.calHeadingTitle': 'Heading (compass °) — click to type',
  'cctv.calPitchTitle': 'Pitch (° up/down) — click to type',
  'cctv.calFovTitle': 'Horizontal FOV (°) — click to type',
  'cctv.calRangeTitle': 'Range / monitor-plane distance (m) — click to type',
  'cctv.calHeightTitle': 'Mount height above ground (m) — click to type',
  'cctv.calNorthTitle': 'North offset from catalog position (m) — click to type',
  'cctv.calEastTitle': 'East offset from catalog position (m) — click to type',
  'cctv.saveCal': 'SAVE CAL',
  'cctv.resetCal': 'RESET CAL',
  'cctv.summaryLabel': 'SCENE SUMMARY',
  'cctv.summaryIdle': 'Enable CCTV to start camera-linked intelligence summaries.',

  // index.html Radio panel chrome (right rail #radio-panel)
  'radio.panelAriaLabel': 'Internet radio companion',
  'radio.panelTitle': 'RADIO',
  'radio.expandTitle': 'Expand Radio',
  'radio.expandAriaLabel': 'Expand Radio section',
  'radio.enable': 'ENABLE',
  'radio.stationTagLabel': 'STATION TAG',
  'radio.filterAriaLabel': 'Filter stations by station tag',
  'radio.filterAll': 'All',
  'radio.noStation': 'NO STATION SELECTED',
  'radio.stationHint': 'Enable Radio, then choose a globe marker or use next.',
  // Key-only: the #radio-tuner-band-label span text is pinned verbatim by
  // radioMarkup.test.mjs, so the attribute must be wired by a later phase.
  'radio.bandLabel': 'DIRECTORY BAND',
  'radio.dragToTune': 'DRAG TO TUNE',
  'radio.tunerIdle': 'ALL · DRAG THE NEEDLE',
  'radio.snapsNote': 'SNAPS TO AVAILABLE STATIONS',
  'radio.transportAriaLabel': 'Radio playback',
  'radio.prev': 'PREV',
  'radio.prevAriaLabel': 'Previous filtered station',
  'radio.play': 'PLAY',
  'radio.playAriaLabel': 'Play selected station',
  'radio.next': 'NEXT',
  'radio.nextAriaLabel': 'Next filtered station',
  'radio.stop': 'STOP',
  'radio.stopAriaLabel': 'Stop radio playback',
  'radio.volumeLabel': 'VOLUME',
  'radio.volumeAriaLabel': 'Radio volume',
  // Initial idle announcement; the runtime states land with the layers worker.
  'radio.playbackOff': 'Radio off',
  'radio.stationSite': 'STATION SITE',
  'radio.privacyNote': 'Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.',
};
