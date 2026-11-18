// A launch without a Launch Library status gets our 'Unknown'. The record keeps
// it English; the mission panel translates it and shows provider statuses as sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import {
  launchStatusAllowsOrbit,
  normalizeRocketLaunches,
} from '../../data/rocketLaunches.js';
import { UNKNOWN_LAUNCH_STATUS } from './model.js';
import { createPanel } from './panel.js';

const NOW = new Date('2026-07-27T00:00:00Z');

function shownStatus(status) {
  const state = {
    _selectedLaunchId: 'mission-1',
    _launches: [
      {
        id: 'mission-1',
        name: 'Example',
        status,
        payloads: [],
        recoveryStages: [],
      },
    ],
    _replayTracks: new Map(),
  };
  return createPanel({
    state,
    parts: {
      overlays: { shortMissionLabel: (name) => name },
      policyHelpers: { missionPathPresentation: () => ({}) },
      replay: { presentReplay: () => ({}) },
    },
  }).presentMission().status;
}

test('a launch without a status keeps the English fallback in its record', () => {
  const [launch] = normalizeRocketLaunches(
    {
      results: [
        {
          id: 'no-status',
          name: 'Test Flight',
          net: '2026-07-20T10:00:00Z',
          pad: {
            name: 'Pad A',
            location: { name: 'Test Range', coordinates: '12.5,45.5' },
          },
        },
      ],
    },
    NOW,
  );
  assert.equal(UNKNOWN_LAUNCH_STATUS, 'Unknown');
  assert.equal(launch.status, 'Unknown');
  assert.equal(launchStatusAllowsOrbit(launch.status), true);
});

test('the mission panel translates only the fallback status', (t) => {
  t.after(() => setLocale('en'));
  setLocale('en');
  assert.equal(shownStatus(UNKNOWN_LAUNCH_STATUS), 'Unknown');
  setLocale('ru');
  assert.equal(shownStatus(UNKNOWN_LAUNCH_STATUS), 'Неизвестно');
  assert.equal(shownStatus('Go for Launch'), 'Go for Launch');
  setLocale('es');
  assert.equal(shownStatus(UNKNOWN_LAUNCH_STATUS), 'Desconocido');
  assert.equal(shownStatus('Launch Successful'), 'Launch Successful');
});

test('a confirmed landing position is worded apart from the CONFIRMED sightings chip', (t) => {
  t.after(() => setLocale('en'));
  const position = () =>
    createPanel({
      state: {
        _selectedLaunchId: 'mission-1',
        _launches: [
          {
            id: 'mission-1',
            name: 'Example',
            status: 'Launch Successful',
            payloads: [],
            recoveryStages: [
              {
                name: 'B1080',
                endpoint: { lat: 28.41, lon: -80.6, accuracy: 'CONFIRMED' },
              },
            ],
          },
        ],
        _replayTracks: new Map(),
      },
      parts: {
        overlays: { shortMissionLabel: (name) => name },
        policyHelpers: { missionPathPresentation: () => ({}) },
        replay: { presentReplay: () => ({}) },
      },
    }).presentMission().stages[0].position;
  assert.match(position(), / · CONFIRMED$/);
  // One landing, singular: sv BEKRÄFTAD, where the sightings chip says
  // BEKRÄFTADE.
  setLocale('sv');
  assert.match(position(), / · BEKRÄFTAD$/);
});
