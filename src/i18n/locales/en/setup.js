// English catalog — setup namespace (phase-1 seed).
//
// Owns first-launch onboarding, in-app key setup (Provider Settings), scene
// recipes, and voice-control chrome. Keys are namespace-relative; the registry
// prefixes them with `setup.`.
export const NAMESPACE = 'setup';

export default {
  // index.html #first-run-launcher header/title/choices
  'firstRun.kicker': 'MISSION CONTROL · FIRST LAUNCH',
  'firstRun.title': 'Choose your first view',
  'firstRun.choice.contacts': 'LIVE CONTACTS',
  'firstRun.suppress': "Don't show this again",
  // index.html #key-setup-chip / #key-setup dialog
  'keySetup.chip': 'POWER UP',
  'keySetup.kicker': 'GROUND STATION · PROVIDER SETTINGS',
  'keySetup.title': 'Power up the globe',
  'keySetup.apply': 'SAVE KEYS',
  // src/keySetup.js submitUpdates() status announcement
  'keySetup.status.saving': 'Saving…',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (ai_docs/i18n-ownership.md cross-surface rule); these keys cover the
  // support-worker surfaces (first-run, key setup, scene director) whose
  // runtime paths land here in phase 3.

  // index.html #first-run-launcher
  // Owner-authored persuasive line, pinned verbatim by firstRunExperience.test.mjs
  // (unspaced em dash included) — keep the exact string when translating.
  'firstRun.description': 'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
  'firstRun.choice.contactsSub': 'Aircraft, vessels and nearby intelligence',
  'firstRun.choice.spaceMissions': 'SPACE MISSIONS',
  'firstRun.choice.spaceMissionsSub': 'Launches, spacecraft and orbital context',
  'firstRun.choice.explore': 'EXPLORE MANUALLY',
  'firstRun.choice.exploreSub': 'Begin with a clean globe',
  'firstRun.dismissHint': 'ESC to dismiss',
  // Initial status tip; firstRunExperience.js swaps it for progress/errors.
  'firstRun.note': 'Tip: the GEV MIC button in the dock lets you talk to the map.',
  // NOT seeded: the environmental tile's <strong>/<small> are pinned verbatim
  // by firstRunExperience.test.mjs (and the title is painted from
  // ENVIRONMENTAL_LABEL_CHOICE at init) — the support worker wires them in
  // phase 3 together with the test update.

  // index.html #key-setup
  'keySetup.closeAriaLabel': 'Close key setup',
  'keySetup.description': 'The globe already flies keyless. Every key below switches on another real feed — paste one and it\'s saved into this app\'s local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.',
  'keySetup.hint': 'ESC to close',
  'keySetup.note': 'The Google Maps key buys the photorealistic planet — everything else stacks on top.',

  // index.html scene director panel chrome (src/scenes/director.js surface)
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
