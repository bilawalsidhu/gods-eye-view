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
};
