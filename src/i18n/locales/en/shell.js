// English catalog — shell namespace (phase-1 seed).
//
// Owns the global application chrome: title bar, loader status, top-center
// actions, panel titles, and the shared global status surface. Keys are
// namespace-relative; the registry in src/i18n/index.js prefixes them with
// `shell.`. Values are plain strings or { one, other } plural variant objects
// with named {placeholder} interpolation.
export const NAMESPACE = 'shell';

export default {
  // index.html #title-bar .subtitle
  'title.subtitle': 'NO PLACE LEFT BEHIND',
  // index.html .loader-status (initial paint)
  'loading.initialStatus': 'Initializing photorealistic world...',
  // src/main.js init() loaderStatus writes
  'loading.status.configuring': 'Configuring viewer...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
  'loading.status.flying': 'Flying to Austin, TX...',
  'loading.status.restoring': 'Restoring shared view...',
  // index.html #global-loading-label (initial) and
  // src/loadingFeedback.js presentLoadingFeedback() labels
  'status.loadingLiveData': 'LOADING LIVE DATA',
  'status.loadComplete': 'LOAD COMPLETE',
  'status.loadFailed': 'LOAD FAILED',
  'status.loadCancelled': 'LOAD CANCELLED',
  // index.html #traffic-sync-label (initial) and
  // src/loadingFeedback.js reduceTrafficSyncFeedback() neutral fallback
  'status.trafficSyncing': 'syncing road network',
  // index.html #top-center-actions buttons
  'actions.clearLayers.ariaLabel': 'Clear selected data layers',
  'actions.clearLayers.title': 'Turn off all selected data layers',
  'actions.share.ariaLabel': 'Copy share link',
  'actions.resetView.ariaLabel': 'Reset to full globe view',
  // index.html #data-toggles panel header
  'panels.dataLayers': 'DATA LAYERS',
  // index.html .panel-collapse-btn on #data-panel
  'panels.collapseTitle': 'Collapse panel',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // index.html #command-dock nav region
  'dock.ariaLabel': 'Navigation, voice, and visual preset controls',
  // index.html #top-center-actions nav
  'actions.navAriaLabel': 'Globe actions',
  'actions.share.title': 'Copy share link',
  'actions.resetView.title': 'Reset camera and return to full globe view',
  // index.html #cctv-sync-label (initial); src/ui.js setSplitFlapText() fallback
  'status.framesLoading': 'loading frames',

  // Locale selector (index.html #control-panel tray). Static EN|ES buttons here;
  // the click → persistLocaleAndReload wiring belongs to the phase-3 core-ui
  // worker, which owns the pressed-state sync.
  'locale.groupAriaLabel': 'Language',
  'locale.english.ariaLabel': 'Switch to English',
  'locale.spanish.ariaLabel': 'Switch to Spanish',
};
