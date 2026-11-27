// The launches layer presents its roster and selected mission as plain views
// and publishes them to subscribers; Core's mission components render them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanel } from './panel.js';
import { normalizeRocketLaunches } from '../../data/rocketLaunches.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createState } from './state.js';

function fixture() {
  const state = createState({
    services: { overlays: {}, render: {} },
  });
  state._enabled = true;
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
      missionMarkerCss: () => 'rgb(1, 2, 3)',
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
      name: 'Mission a',
      missionName: null,
      ariaLabel: 'Select MISSION A',
      provider: 'SpaceX',
      date: '2026-11-01',
      status: 'Go',
      launchAt: Date.parse('2026-11-01T10:00:00Z'),
    },
  ]);
  // A launch without a time has no launchAt, and lists last in Inspect.
  state._launches = [launch('b', { launchTime: null })];
  panel.renderMissionRoster();
  const [undated] = views.at(-1).roster.entries;
  assert.equal(undated.launchAt, null);
  assert.equal(undated.date, 'DATE UNAVAILABLE');
  const late = [];
  panel.subscribePanel((view) => late.push(view));
  assert.equal(late[0], views.at(-1));
  panel.clearMissionPanel();
  assert.deepEqual(views.at(-1), { roster: null, mission: null });
});

test('NET precision reaches the launch time and the roster without inventing a day or hour', () => {
  const { state, panel, views } = fixture();
  const now = new Date('2026-12-03T00:00:00Z');
  const launchDate = '2026-12-01T00:00:00Z';
  const precisions = ['Day', 'Month', 'Quarter', 'Year', 'Minute'];
  state._launches = normalizeRocketLaunches(
    {
      results: precisions.map((name) => ({
        id: name,
        name: 'Civilian weather mission',
        net: launchDate,
        net_precision: { name },
        status: { name: 'Launch On Hold' },
        pad: { latitude: 45, longitude: -75 },
      })),
    },
    now,
  );
  panel.createMissionPanel();
  try {
    panel.renderMissionRoster();
    const expected = [
      'Dec 1, 2026',
      'Dec 2026',
      new Intl.DateTimeFormat('en', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).formatRange(new Date('2026-10-01T00:00:00Z'), new Date(launchDate)),
      '2026',
      '2026-12-01',
    ];
    assert.deepEqual(
      views.at(-1).roster.entries.map(({ date }) => date),
      expected,
    );
    for (const [i, id] of precisions.entries()) {
      state._selectedLaunchId = id;
      const shown = id === 'Minute' ? 'Dec 1, 2026, 12:00 AM UTC' : expected[i];
      assert.equal(panel.presentMission().when, shown);
    }
  } finally {
    panel.clearMissionPanel();
  }
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
  panel.commands.rosterReset();
  assert.equal(state._hoveredRosterLaunchId, null);
  assert.equal(state._missionRosterHoverTimer, null);
  panel.clearMissionPanel();
});

test('a followed camera stays put while browsing the roster, and layer selection still focuses', async (t) => {
  const { state, panel, calls } = fixture();
  state._viewer = {};
  state._launches = [launch('a')];
  t.after(
    bindRenderer(state._viewer, { camera: { followed: { key: 'flights:a' } } }),
  );
  panel.createMissionPanel();
  panel.renderMissionRoster();

  panel.commands.rosterFocus(0);
  assert.equal(state._hoveredRosterLaunchId, 'a');
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(calls, [['overlays']]);
  panel.commands.selectMissionAt(0, { keepFollow: true });
  assert.deepEqual(calls.at(-1), ['select', 'a', true]);
  panel.commands.selectMissionAt(0);
  assert.deepEqual(calls.at(-1), ['focus-mission', 'a']);
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
  assert.equal(first.id, 'b');
  assert.equal(first.when, 'Nov 1, 2026, 10:00 AM UTC');
  // A launch without a site position has no map or pin.
  assert.equal(first.lat, null);
  assert.equal(first.lon, null);
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
  commands.selectMissionAt(0);
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
    ['focus-site', 'b'],
    ['replay', 'b'],
    ['pause'],
    ['resume'],
    ['cancel'],
    ['speed', '2'],
    ['select', null, undefined],
  ]);
});

test('a roster row hovered or focused while the layer goes off moves no camera', async () => {
  const { state, panel, calls } = fixture();
  state._launches = [launch('a'), launch('b')];
  panel.createMissionPanel();
  panel.renderMissionRoster();

  // Hovered just before the layer goes off: the pending preview is dropped.
  panel.commands.rosterPointerEnter(0);
  state._enabled = false;
  await new Promise((resolve) => setTimeout(resolve, 160));

  // Hovered or focused after it went off, while the panel still shows.
  panel.commands.rosterPointerEnter(1);
  panel.commands.rosterFocus(1);
  assert.equal(state._missionRosterHoverTimer, null, 'no preview is pending');
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(
    calls.filter(([name]) => name === 'preview'),
    [],
  );
  panel.clearMissionPanel();
});
