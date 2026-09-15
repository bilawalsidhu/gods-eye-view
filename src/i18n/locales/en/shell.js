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

  // Locale selector (index.html #control-panel tray): the group container is
  // static; its buttons are runtime-rendered by ui.js _initLocaleSelector()
  // from the configured locale pair (keys at the end of this file).
  'locale.groupAriaLabel': 'Language',

  // ── Phase-3 runtime extraction (support worker), appended ─────────────────
  // src/main.js init() loaderStatus write sites without a phase-1/2 key.
  'loading.status.tilesGoogle': 'Loading Google 3D Tiles...',
  'loading.status.tilesKeyless': 'Loading the keyless globe...',
  'loading.status.systems': 'Initializing systems...',
  // src/loadingFeedback.js presentLoadingFeedback() labels beyond the phase-1
  // seeds. 'OpenStreetMap · Overpass' detail strings are provider names and
  // stay verbatim at the call site.
  'status.liveDataOff': 'LIVE DATA OFF',
  'status.mappedSitesLoaded': 'MAPPED SITES LOADED',
  'status.retryingMappedSites': 'RETRYING MAPPED SITES',
  'status.fetchingMappedSites': 'FETCHING MAPPED SITES',
  'status.turningOffLiveData': 'TURNING OFF LIVE DATA',
  'status.refreshingLiveData': 'REFRESHING LIVE DATA',

  // ── Configurable locale pair (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE,
  // vite.config.js client defines), appended ────────────────────────────
  // ui.js _initLocaleSelector() renders one runtime button per offered
  // locale and reads shell.locale.<code>.ariaLabel for its aria-label.
  // Only SHIPPED locales get a key: each locale PR appends its label to every
  // shipped catalog (docs/TRANSLATORS.md), so an unshipped locale can never
  // render a selector button.
  'locale.en.ariaLabel': 'Switch to English',

  'credits.closeAria': 'Close data attribution',
};
