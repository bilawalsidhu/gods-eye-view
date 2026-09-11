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

  // ── Phase-3 runtime extraction (support surfaces), appended ───────────────

  // src/firstRunExperience.js — mission busy lines and status/error copy.
  // {detail} is the failed layer-id list (machine values, kept raw).
  'firstRun.busy.contacts': 'Starting live contacts…',
  'firstRun.busy.spaceMissions': 'Opening space missions…',
  'firstRun.busy.environmental': 'Scanning active events…',
  'firstRun.busy.working': 'Working…',
  'firstRun.status.failed': 'Could not open that mission{detail}. Retry or explore manually.',
  'firstRun.status.storageBlocked': 'This browser is blocking storage, so that could not be saved.',
  // The environmental tile is painted at init from ENVIRONMENTAL_LABEL_CHOICE;
  // the subcopy names BOTH feeds (pinned verbatim by firstRunExperience.test.mjs).
  'firstRun.choice.environmentalSub': 'Live earthquakes and active fires, from USGS and NASA',
  'firstRun.environmentalTitle.environmental': 'ENVIRONMENTAL',
  'firstRun.environmentalTitle.earthWatch': 'EARTH WATCH',
  'firstRun.environmentalTitle.activeEvents': 'ACTIVE EVENTS',

  // src/keySetup.js — chip counter, status line, and remove confirm.
  'keySetup.chipWaiting': { one: 'POWER UP · {count} KEY WAITING', other: 'POWER UP · {count} KEYS WAITING' },
  'keySetup.chipReady': 'POWERED UP',
  'keySetup.status.saveFailed': 'Save failed ({status}).',
  'keySetup.status.saveFailedDetail': 'Save failed: {detail}',
  'keySetup.status.pasteFirst': 'Paste at least one key first.',
  'keySetup.status.saved': 'Saved to {store}. Restarting — this page reloads itself.',
  'keySetup.status.removed': 'Removed from {store}. Restarting — this page reloads itself.',
  'keySetup.store.pinokio': 'your app configuration',
  'keySetup.store.env': 'your local .env',
  'keySetup.confirm.remove': 'Remove this key from your saved configuration?',

  // src/mapStackChips.js — unavailable-chip tooltip and aria templates.
  'mapStack.fallbackName': 'This map stack',
  'mapStack.unavailableReason': '{label} is unavailable',
  'mapStack.unavailableAriaLabel': '{label} unavailable: {hint}',

  // src/scenes/director.js — built-in recipe DISPLAY names only. Recipe ids
  // and the URL 'scene' param stay English; stored/renamed project titles are
  // user data and render verbatim.
  'scenes.recipe.flightsRadar': 'Global Flights Radar',
  'scenes.recipe.orbitalWatch': 'Orbital Watch',
  'scenes.recipe.thermalThreats': 'Thermal Threat Board',
  'scenes.recipe.cityOverload': 'City Overload',
  'scenes.recipe.omnisciencePullback': 'Omniscience Pullback',

  // src/voice/gevRealtime.js — mic chrome and connection/execution STATUS
  // text. Status enum keys (idle/connecting/…) are machine values; tool
  // names/schemas and model-facing results stay English (keep-English
  // boundary). Tier badges STD/MINI and the MIC/ON-OFF mic label stay machine
  // identifiers this phase.
  'voice.status.idle': 'OFF',
  'voice.status.connecting': 'CONNECTING',
  'voice.status.listening': 'LISTENING',
  'voice.status.executing': 'EXECUTING',
  'voice.status.error': 'ERROR',
  'voice.status.sessionCostCap': 'Session ended — cost cap {cost}',
  'voice.detail.standby': 'VOICE STANDBY',
  'voice.detail.active': 'VOICE ACTIVE',
  'voice.detail.unavailable': 'VOICE UNAVAILABLE',
  'voice.detail.microphoneUnavailable': 'WebRTC microphone support unavailable',
  'voice.detail.requestingMicrophone': 'Requesting microphone',
  'voice.detail.holdSpaceTalk': 'Hold Space to talk',
  'voice.detail.releaseSpaceSend': 'Release Space to send',
  'voice.detail.askOrCommand': 'Ask or command',
  'voice.detail.voiceOff': 'Voice off',
  'voice.detail.runningCommand': 'Running command',
  'voice.detail.radioDidNotStart': 'Radio did not start',
  'voice.hint.default': 'Hold Space to speak · click mic to toggle voice',
  'voice.error.sessionStart': 'Voice session could not be started.',
  'voice.error.trayTitle': 'VOICE SYSTEM ERROR',
  'voice.error.dismiss': 'DISMISS',
  'voice.error.hint': 'Check microphone permission and network access, then try again.',
  'voice.kicker.agent': 'AI AGENT',
  'voice.kicker.control': 'VOICE CONTROL',
  'voice.tier.appliesNextSession': '{tier} applies next session',
  'voice.tier.buttonTitle': 'Voice model tier — applies next session',
  'voice.cost.buttonTitle': 'Estimated session cost',
  'voice.button.ariaLabel': 'Voice control — hold Space to speak; click to toggle voice',

  // ── Stage-4 repair pass: src/scenes/director.js status corpus, appended ───
  // Status/confirm lines and the default shot title. {scene}/{shot} carry
  // stored project titles (user data, rendered verbatim); {mode} is the raw
  // context-mode identifier (machine value, keep-English boundary).
  'scenes.status.captureCameraNotReady': 'Cannot capture shot: camera not ready',
  'scenes.status.shotTitleDefault': 'Shot {n}',
  'scenes.status.captured': 'Captured: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Select a shot first',
  'scenes.status.updated': 'Updated: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Delete shot "{shot}"?',
  'scenes.status.loaded': 'Loaded: {scene} / {shot}',
  'scenes.status.cameraUnavailable': 'Camera unavailable — exit cockpit first',
  'scenes.status.noShotsToRun': 'No shots to run',
  'scenes.status.runningShot': 'Running {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Scene run complete',
  'scenes.status.runError': 'Error: {message}',
  'scenes.status.contextExitFailed': 'Could not exit {mode} — scene layers may be refused',
};
