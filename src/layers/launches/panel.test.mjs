// The launches layer presents its roster and selected mission as plain views
// and publishes them to subscribers; Core's mission components render them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanel } from './panel.js';
import { createState } from './state.js';

function fixture() {
  const state = createState({
    services: { overlays: {}, render: {} },
  });
  const calls = [];
  const parts = {
    overlays: {
      shortMissionLabel: (name) => name,
      syncMissionOverlayEntries: () => calls.push(['overlays']),
    },
    policyHelpers: {
      missionRosterEntries: (launches) =>
        launches.map((launch, index) => ({ launch, index })),
      missionPathPresentation: () => ({ orbit: 'LEO', ascent: 'ESTIMATED' }),
      previewMissionFromRoster: (launch) => calls.push(['preview', launch.id]),
    },
    model: {
      missionMarkerColor: () => ({ toCssColorString: () => 'rgb(1, 2, 3)' }),
    },
    selection: {
      setSelectedMission: (id, isolate) => calls.push(['select', id, isolate]),
      focusMission: (launch) => calls.push(['focus-mission', launch.id]),
      focusLaunchSite: (launch) => calls.push(['focus-site', launch.id]),
    },
    replay: {
      presentReplay: () => ({ available: false }),
      startMissionReplay: (id) => calls.push(['replay', id]),
      stopMissionReplay: () => calls.push(['cancel']),
      pauseMissionReplay: () => calls.push(['pause']),
      resumeMissionReplay: () => calls.push(['resume']),
      setReplaySpeed: (value) => calls.push(['speed', value]),
    },
  };
  const panel = createPanel({ state, parts });
  const views = [];
  panel.subscribePanel((view) => views.push(view));
  return { state, panel, views, calls };
}

const launch = (id, extra = {}) => ({
  id,
  name: `Mission ${id}`,
  provider: 'SpaceX',
  status: 'Go',
  launchSite: 'Unknown launch site',
  launchTime: '2026-11-01T10:00:00Z',
  payloads: [],
  recoveryStages: [],
  ...extra,
});

test('the panel publishes only once the layer starts presenting', () => {
  const { state, panel, views } = fixture();
  state._launches = [launch('a')];
  panel.renderMissionRoster();
  assert.equal(views.length, 0);
  panel.createMissionPanel();
  assert.deepEqual(views, [{ roster: null, mission: null }]);
  panel.renderMissionRoster();
  const { roster } = views.at(-1);
  assert.equal(roster.count, '1 / 30D');
  assert.deepEqual(roster.entries, [
    {
      index: 0,
      id: 'a',
      color: 'rgb(1, 2, 3)',
      label: 'MISSION A',
      ariaLabel: 'Select MISSION A',
      provider: 'SpaceX',
      date: '2026-11-01',
    },
  ]);
  const late = [];
  panel.subscribePanel((view) => late.push(view));
  assert.equal(late[0], views.at(-1));
  panel.clearMissionPanel();
  assert.deepEqual(views.at(-1), { roster: null, mission: null });
});

test('an unchanged roster keeps its view and the preview; a changed one drops it', async () => {
  const { state, panel, views, calls } = fixture();
  state._launches = [launch('a'), launch('b')];
  panel.createMissionPanel();
  panel.renderMissionRoster();
  const published = views.length;
  const roster = views.at(-1).roster;
  panel.commands.rosterFocus(1);
  assert.equal(state._hoveredRosterLaunchId, 'b');
  panel.renderMissionRoster();
  assert.equal(views.length, published);
  assert.equal(state._hoveredRosterLaunchId, 'b');
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(calls.at(-1), ['preview', 'b']);
  state._launches = [launch('b'), launch('a')];
  panel.renderMissionRoster();
  assert.equal(state._hoveredRosterLaunchId, null);
  assert.notEqual(views.at(-1).roster, roster);
  // The list restores focus on the mission, which takes the preview back.
  panel.commands.rosterFocus(0);
  assert.equal(state._hoveredRosterLaunchId, 'b');
  panel.clearMissionPanel();
});

test('the selected mission is presented with its rows and returns to the top', () => {
  const { state, panel, views } = fixture();
  state._launches = [
    launch('a'),
    launch('b', {
      payloads: Array.from({ length: 6 }, (_, index) => ({
        name: `Sat ${index}`,
        amount: index === 0 ? 2 : 1,
        manufacturer: 'Maker',
        massKg: 500,
      })),
      recoveryStages: [
        {
          name: 'B1080',
          status: 'Landed',
          flightNumber: 9,
          reused: true,
          endpoint: { lat: 28.4, lon: -77.1, accuracy: 'DRONESHIP' },
        },
      ],
    }),
  ];
  panel.createMissionPanel();
  state._selectedLaunchId = 'b';
  panel.renderMissionPanel();
  const first = views.at(-1).mission;
  assert.equal(first.title, 'MISSION B');
  assert.equal(first.site, null);
  assert.equal(first.orbit, 'LEO');
  assert.equal(first.index, '2 / 2');
  assert.equal(first.previousDisabled, false);
  assert.equal(first.nextDisabled, true);
  assert.equal(first.payloads.length, 5);
  assert.deepEqual(first.payloads[0], {
    name: 'Sat 0 ×2',
    detail: 'Maker · 500 KG',
    type: 'UNSPECIFIED',
    destination: 'UNAVAILABLE',
  });
  assert.equal(first.payloadsMore, '+1 additional payload records');
  assert.deepEqual(first.stages, [
    {
      name: 'B1080',
      detail: 'FLIGHT 9 · REUSED',
      status: 'Landed',
      destination: 'UNAVAILABLE',
      position: '28.40, -77.10 · DRONESHIP',
    },
  ]);
  panel.renderMissionPanel();
  assert.equal(views.at(-1).mission.scrollRequest, first.scrollRequest + 1);
  state._selectedLaunchId = null;
  panel.renderMissionPanel();
  assert.equal(views.at(-1).mission, null);
});

test('the panel commands act on the selected mission', () => {
  const { state, panel, calls } = fixture();
  state._launches = [launch('a'), launch('b'), launch('c')];
  state._selectedLaunchId = 'b';
  const { commands } = panel;
  commands.selectPreviousMission();
  commands.selectNextMission();
  commands.selectMissionAt(9);
  commands.focusSelectedLaunchSite();
  commands.startSelectedReplay();
  commands.toggleReplayPause();
  state._replayPaused = true;
  commands.toggleReplayPause();
  commands.cancelReplay();
  commands.setReplaySpeed('2');
  commands.deselectMission();
  assert.deepEqual(calls, [
    ['select', 'a', true],
    ['focus-mission', 'a'],
    ['select', 'c', true],
    ['focus-mission', 'c'],
    ['focus-site', 'b'],
    ['replay', 'b'],
    ['pause'],
    ['resume'],
    ['cancel'],
    ['speed', '2'],
    ['select', null, undefined],
  ]);
});
