// UNTRANSLATED STAGE-3 SEED — Spanish catalog, setup namespace.
// Key set mirrors locales/en/setup.js exactly; values are still English
// until stage-4 translation (see locales/es/shell.js header for the rules).
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'MISSION CONTROL · FIRST LAUNCH',
  'firstRun.title': 'Choose your first view',
  'firstRun.choice.contacts': 'LIVE CONTACTS',
  'firstRun.suppress': "Don't show this again",
  'keySetup.chip': 'POWER UP',
  'keySetup.kicker': 'GROUND STATION · PROVIDER SETTINGS',
  'keySetup.title': 'Power up the globe',
  'keySetup.apply': 'SAVE KEYS',
  'keySetup.status.saving': 'Saving…',

  // Phase-2 static markup extraction (mirrors locales/en/setup.js appendix).
  'firstRun.description': 'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
  'firstRun.choice.contactsSub': 'Aircraft, vessels and nearby intelligence',
  'firstRun.choice.spaceMissions': 'SPACE MISSIONS',
  'firstRun.choice.spaceMissionsSub': 'Launches, spacecraft and orbital context',
  'firstRun.choice.explore': 'EXPLORE MANUALLY',
  'firstRun.choice.exploreSub': 'Begin with a clean globe',
  'firstRun.dismissHint': 'ESC to dismiss',
  'firstRun.note': 'Tip: the GEV MIC button in the dock lets you talk to the map.',
  'keySetup.closeAriaLabel': 'Close key setup',
  'keySetup.description': 'The globe already flies keyless. Every key below switches on another real feed — paste one and it\'s saved into this app\'s local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.',
  'keySetup.hint': 'ESC to close',
  'keySetup.note': 'The Google Maps key buys the photorealistic planet — everything else stacks on top.',
  'scenes.panelTitle': 'SCENES',
  'scenes.collapseTitle': 'Collapse panel',
  'scenes.recipeAriaLabel': 'Scene recipe',
  'scenes.new': 'NEW',
  'scenes.delete': 'DEL',
  'scenes.capture': 'CAPTURE SHOT',
  'scenes.updateShot': 'UPDATE SHOT',
  'scenes.start': 'START',
  'scenes.stop': 'STOP',
  'scenes.next': 'NEXT',
  'scenes.exportPresets': 'EXPORT PRESETS',
  'scenes.import': 'IMPORT',
  'scenes.runLog': 'RUN LOG',
  'scenes.statusReady': 'Ready',
};
