/** CCTV camera panel (templates/layer-panels.html + src/ui/cctv*.js). */
export default {
  panel: {
    title: 'CCTV',
  },
  frameAlt: 'CCTV feed frame',
  selectAria: 'CCTV camera',
  toggle: {
    on: 'CCTV ON',
    off: 'CCTV OFF',
  },
  nearest: 'NEAREST',
  prev: 'PREV',
  next: 'NEXT',
  focus: 'FOCUS',
  coverage: {
    on: 'COVERAGE ON',
    off: 'COVERAGE OFF',
    viewshed: 'VIEWSHED ON',
  },
  autoHop: {
    on: 'AUTO HOP ON',
    off: 'AUTO HOP OFF',
  },
  projection: {
    on: 'PROJECTION ON',
    off: 'PROJECTION OFF',
  },
  cal: {
    title: 'CALIBRATION',
    adjust: 'ADJUST',
    adjustOn: 'ADJUST ON',
    adjustTooltip:
      'Drag the camera in the world: rings rotate, arrows move, handles set range/FOV',
    save: 'SAVE CAL',
    reset: 'RESET CAL',
    readoutAria: 'Camera pose — click a value to type',
    chip: 'CAL · {badge}',
    edited: 'CAL · EDITED (UNSAVED)',
    headingTooltip: 'Heading (compass °) — click to type',
    pitchTooltip: 'Pitch (° up/down) — click to type',
    fovTooltip: 'Horizontal FOV (°) — click to type',
    rangeTooltip: 'Range / monitor-plane distance (m) — click to type',
    heightTooltip: 'Mount height above ground (m) — click to type',
    northTooltip: 'North offset from catalog position (m) — click to type',
    eastTooltip: 'East offset from catalog position (m) — click to type',
  },
  badge: {
    calibrated: 'CALIBRATED',
    curated: 'CURATED',
    rawPrior: 'RAW PRIOR',
    none: '--',
  },
  meta: {
    idle: 'Enable CCTV to load camera intersections',
    monitor: 'MONITOR',
    off: 'OFF',
    configuredSource: 'Configured Source',
    loadedClick: '{n} cameras loaded · click a camera to activate',
    loadedEnable: '{n} cameras loaded · enable CCTV to activate',
  },
  source: {
    unknown: 'SOURCE · UNKNOWN',
  },
  frame: {
    loading: 'FRAME · LOADING',
    unavailable: 'FRAME · UNAVAILABLE',
  },
  // The busy sync label reuses `chrome.chips.cctvSync` ("loading frames").
  sync: {
    gridReady: 'camera grid ready',
  },
  summary: {
    label: 'SCENE SUMMARY',
    idle: 'Enable CCTV to start camera-linked intelligence summaries.',
    empty: 'No summary available.',
  },
  toast: {
    saved: 'CCTV calibration saved',
    reset: 'CCTV calibration reset',
  },
};
