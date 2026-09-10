// UNTRANSLATED STAGE-3 SEED — Spanish catalog, shell namespace.
//
// The key set mirrors locales/en/shell.js exactly (catalog parity tests
// enforce: no extra keys, matching placeholder names). Values are still
// English so phase 1 is a zero-visible-change foundation: selecting 'es'
// renders identical text until stage-4 translation replaces these values.
// Stage-2/3 workers append new keys to BOTH files; keep them in sync.
export const NAMESPACE = 'shell';

export default {
  'title.subtitle': 'NO PLACE LEFT BEHIND',
  'loading.initialStatus': 'Initializing photorealistic world...',
  'loading.status.configuring': 'Configuring viewer...',
  'loading.status.tilesUnavailable': 'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
  'loading.status.flying': 'Flying to Austin, TX...',
  'loading.status.restoring': 'Restoring shared view...',
  'status.loadingLiveData': 'LOADING LIVE DATA',
  'status.loadComplete': 'LOAD COMPLETE',
  'status.loadFailed': 'LOAD FAILED',
  'status.loadCancelled': 'LOAD CANCELLED',
  'status.trafficSyncing': 'syncing road network',
  'actions.clearLayers.ariaLabel': 'Clear selected data layers',
  'actions.clearLayers.title': 'Turn off all selected data layers',
  'actions.share.ariaLabel': 'Copy share link',
  'actions.resetView.ariaLabel': 'Reset to full globe view',
  'panels.dataLayers': 'DATA LAYERS',
};
