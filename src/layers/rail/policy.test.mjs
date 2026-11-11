// Pure Rail layer decisions: category toggles from share links, train keys,
// report aging, the playback mode a train borrows from Transit, and the
// selected-train card. The copy builder stays free of i18n (tools import
// policy.js); the browser hands it t(), so a fake t() shows which words go
// through translation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RAIL_CATEGORY_VISIBILITY,
  RAIL_CARD_MAX_LINES,
  RAIL_CATEGORY_COLORS,
  TRAIN_MAX_FIX_AGE_MS,
  RAIL_LIVE_POSITION_SOURCES,
  buildRailSelectionCopy,
  createRailSelectedOverlayEntry,
  isLiveRailPositionSource,
  isStaleTrainFix,
  normalizeRailCategories,
  playbackModeFor,
  railTrainKey,
  trainFixAgeMs,
  trainReportTimeMs,
} from './policy.js';
import { RAIL_CATEGORIES } from '../../data/railFeeds.js';

const NOW = 1_794_000_000_000;
const feed = { name: 'MBTA', region: 'Boston, MA' };

/** A t() that marks every string it translates and fills placeholders. */
function fakeT() {
  const calls = [];
  const t = (text, values) => {
    calls.push({ text, values });
    const filled = String(text).replace(/\{(\w+)\}/g, (match, key) =>
      values && key in values ? String(values[key]) : match,
    );
    return `T(${filled})`;
  };
  return { t, calls };
}

const stampedTrain = Object.freeze({
  id: '1712',
  label: 'Train 1712',
  routeId: 'CR-Worcester',
  category: 'local',
  mode: 'rail',
  lat: 42.35,
  lon: -71.2,
  bearing: 90,
  speedMps: 20,
  timestamp: (NOW - 30_000) / 1000,
  timestampSource: 'vehicle',
  status: 'IN_TRANSIT_TO',
  stopId: 'place-sstat',
});

const unstampedMetro = Object.freeze({
  id: '77',
  label: '77',
  routeId: null,
  category: 'transit',
  mode: 'metro',
  lat: 42.36,
  lon: -71.06,
});

test('every category is on by default', () => {
  assert.deepEqual(Object.keys(DEFAULT_RAIL_CATEGORY_VISIBILITY), [
    ...RAIL_CATEGORIES,
  ]);
  assert.ok(
    Object.values(DEFAULT_RAIL_CATEGORY_VISIBILITY).every((on) => on === true),
  );
  assert.deepEqual(
    normalizeRailCategories({}),
    DEFAULT_RAIL_CATEGORY_VISIBILITY,
  );
  assert.deepEqual(
    normalizeRailCategories(null),
    DEFAULT_RAIL_CATEGORY_VISIBILITY,
  );
});

test('category toggles apply booleans and ignore anything else', () => {
  const current = {
    transit: true,
    local: false,
    regional: true,
    national: true,
    international: true,
  };
  assert.deepEqual(
    normalizeRailCategories(
      {
        transit: false,
        local: 'true',
        regional: 0,
        national: null,
        international: true,
        bus: false,
      },
      current,
    ),
    {
      transit: false,
      local: false,
      regional: true,
      national: true,
      international: true,
    },
  );
});

test('a share link can switch a hidden category back on', () => {
  const allOff = Object.fromEntries(RAIL_CATEGORIES.map((key) => [key, false]));
  assert.deepEqual(normalizeRailCategories({ regional: true }, allOff), {
    ...allOff,
    regional: true,
  });
});

test('train keys are namespaced so they never collide with Transit keys', () => {
  assert.equal(railTrainKey('mbta-rail', '1712'), 'rail:mbta-rail:1712');
  assert.notEqual(
    railTrainKey('mbta-rail', '1712'),
    railTrainKey('mbta-rail', '1713'),
  );
  assert.notEqual(
    railTrainKey('mta-lirr', '7'),
    railTrainKey('mta-metro-north', '7'),
  );
});

test('a stamped report is aged from its own time', () => {
  assert.equal(trainFixAgeMs(stampedTrain, NOW), 30_000);
  // The fetch time does not override the train's own stamp.
  assert.equal(trainFixAgeMs(stampedTrain, NOW, NOW - 1_000), 30_000);
  assert.equal(trainReportTimeMs(stampedTrain, NOW - 1_000), NOW - 30_000);
});

test('a stamp ahead of now ages to zero, never below', () => {
  assert.equal(trainFixAgeMs({ timestamp: (NOW + 5_000) / 1000 }, NOW), 0);
});

test('an unstamped report is aged from the snapshot fetch time', () => {
  assert.equal(trainFixAgeMs(unstampedMetro, NOW, NOW - 45_000), 45_000);
  assert.equal(trainReportTimeMs(unstampedMetro, NOW - 45_000), NOW - 45_000);
  // Zero and negative stamps count as no stamp.
  assert.equal(trainFixAgeMs({ timestamp: 0 }, NOW, NOW - 2_000), 2_000);
  assert.equal(trainFixAgeMs({ timestamp: -1 }, NOW, NOW - 2_000), 2_000);
  // With neither a stamp nor a fetch time there is nothing to age from.
  assert.equal(trainFixAgeMs(unstampedMetro, NOW), 0);
});

test('a report is stale only past the ten-minute limit', () => {
  assert.equal(TRAIN_MAX_FIX_AGE_MS, 10 * 60_000);
  const at = (ageMs) => ({ timestamp: (NOW - ageMs) / 1000 });
  assert.equal(isStaleTrainFix(at(TRAIN_MAX_FIX_AGE_MS), NOW), false);
  assert.equal(isStaleTrainFix(at(TRAIN_MAX_FIX_AGE_MS + 1_000), NOW), true);
});

test('an unstamped report from an old snapshot is stale, not live', () => {
  const oldFetch = NOW - TRAIN_MAX_FIX_AGE_MS - 1;
  assert.equal(isStaleTrainFix(unstampedMetro, NOW, oldFetch), true);
  assert.equal(isStaleTrainFix(unstampedMetro, NOW, NOW - 60_000), false);
});

test('rail modes map onto the Transit playback modes', () => {
  assert.equal(playbackModeFor('metro'), 'subway');
  assert.equal(playbackModeFor('tram'), 'tram');
  assert.equal(playbackModeFor('rail'), 'rail');
  assert.equal(playbackModeFor('monorail'), 'rail');
  assert.equal(playbackModeFor(undefined), 'rail');
});

test('the card for a train with its own timestamp', () => {
  const { t, calls } = fakeT();
  const copy = buildRailSelectionCopy(feed, stampedTrain, NOW, NOW, null, t);
  assert.equal(copy.title, '🚆 T(Route CR-Worcester)');
  assert.deepEqual(copy.details, [
    'T(Local rail) · T(Train) · MBTA · Boston, MA',
    'T(Reported 30 s ago)',
    'T(reported 72 km/h) · T(reported hdg 90°)',
    'T(Last report: next stop place-sstat)',
    'T(Vehicle 1712) · Train 1712',
  ]);
  // Operator names and regions are data, never sent through t().
  assert.ok(calls.every(({ text }) => !text.includes('MBTA')));
});

test('the card for an unstamped metro train says the time is the feed’s', () => {
  const { t } = fakeT();
  const copy = buildRailSelectionCopy(
    feed,
    unstampedMetro,
    NOW,
    NOW - 120_000,
    null,
    t,
  );
  assert.equal(copy.title, '🚆 T(Vehicle 77)');
  assert.deepEqual(copy.details, [
    'T(Urban rail) · T(Subway) · MBTA · Boston, MA',
    'T(T(Reported 2 min ago) (feed time))',
    'T(Shown at street level · depth not in the feed)',
    'T(Vehicle 77)',
  ]);
});

test('a header-stamped report is feed time even with a timestamp', () => {
  const { t } = fakeT();
  const copy = buildRailSelectionCopy(
    feed,
    { ...stampedTrain, timestampSource: 'header' },
    NOW,
    NOW,
    null,
    t,
  );
  assert.equal(copy.details[1], 'T(T(Reported 30 s ago) (feed time))');
});

test('only metro trains carry the street-level note', () => {
  const { t } = fakeT();
  const note = 'T(Shown at street level · depth not in the feed)';
  for (const mode of ['rail', 'tram']) {
    const copy = buildRailSelectionCopy(
      feed,
      { ...unstampedMetro, mode },
      NOW,
      NOW,
      null,
      t,
    );
    assert.equal(copy.details.includes(note), false, mode);
  }
  const metro = buildRailSelectionCopy(
    feed,
    { ...stampedTrain, mode: 'metro', category: 'transit' },
    NOW,
    NOW,
    null,
    t,
  );
  assert.equal(metro.details.includes(note), true);
});

test('playback state adds the motion word and the display delay', () => {
  const { t, calls } = fakeT();
  const entry = {
    sample: {
      latestReportAgeMs: 5_000,
      actualDelayMs: 42_400,
      phase: 'playing',
      motion: 'stopped',
    },
  };
  const copy = buildRailSelectionCopy(feed, stampedTrain, NOW, NOW, entry, t);
  assert.equal(copy.details[1], 'T(Stopped)');
  assert.deepEqual(calls.find(({ text }) => text === 'Stopped').values, {
    context: 'vehicle motion',
  });
  assert.equal(copy.details[2], 'T(Reported 5 s ago) · T(shown 42 s behind)');

  const moving = buildRailSelectionCopy(
    feed,
    stampedTrain,
    NOW,
    NOW,
    { sample: { ...entry.sample, motion: 'moving' } },
    t,
  );
  assert.equal(moving.details[1], 'T(Moving)');
});

test('without a t() the card reads in plain English', () => {
  const copy = buildRailSelectionCopy(feed, stampedTrain, NOW, NOW);
  assert.equal(copy.title, '🚆 Route CR-Worcester');
  assert.equal(copy.details[0], 'Local rail · Train · MBTA · Boston, MA');
  assert.equal(copy.details[1], 'Reported 30 s ago');
});

test('the selected card is accented in the category colour', () => {
  const copy = { title: 'Route 550', details: ['Local rail'] };
  const position = () => ({ x: 1, y: 2, z: 3 });
  for (const category of RAIL_CATEGORIES) {
    const card = createRailSelectedOverlayEntry(
      'rail:capmetro-rail:101',
      position,
      copy,
      category,
    );
    assert.equal(card.accent, RAIL_CATEGORY_COLORS[category], category);
  }
  const card = createRailSelectedOverlayEntry(
    'rail:capmetro-rail:101',
    position,
    copy,
    'bus',
  );
  assert.equal(card.accent, RAIL_CATEGORY_COLORS.local);
  assert.equal(card.id, 'rail:capmetro-rail:101');
  assert.equal(card.position, position);
  assert.equal(card.title, 'Route 550');
  assert.deepEqual(card.details, ['Local rail']);
  assert.equal(card.selected, true);
});

test('no card without a key or a position', () => {
  const copy = { title: '', details: [] };
  assert.equal(
    createRailSelectedOverlayEntry('', () => null, copy),
    null,
  );
  assert.equal(createRailSelectedOverlayEntry('rail:a:1', null, copy), null);
});

/** Two stops as the schedule pack's tripStops() lists them. */
const tripStopsNearYonkers = Object.freeze([
  Object.freeze({
    stopId: 'riv',
    name: 'Riverdale',
    lat: 40.9,
    lon: -73.91,
    state: 'passed',
    expectedArrival: '14:23',
    expectedDeparture: '14:24',
    arrivalDelaySec: 180,
    departureDelaySec: 180,
    relative: 'T+3',
  }),
  Object.freeze({
    stopId: 'yon',
    name: 'Yonkers',
    lat: 40.93,
    lon: -73.9,
    state: 'next',
    atStop: false,
    expectedArrival: '14:32',
    expectedDeparture: '14:33',
    arrivalDelaySec: 200,
    departureDelaySec: 200,
    relative: 'T−4',
  }),
]);

test('with the trip’s stops the card names the next and previous stops', () => {
  const { t } = fakeT();
  const copy = buildRailSelectionCopy(feed, stampedTrain, NOW, NOW, null, t, {
    stops: tripStopsNearYonkers,
    headsign: 'Poughkeepsie',
  });
  assert.equal(copy.title, '🚆 T(Route CR-Worcester) · T(To Poughkeepsie)');
  assert.deepEqual(copy.details, [
    'T(Local rail) · T(Train) · MBTA · Boston, MA',
    'T(Next Yonkers 14:32 T−4) T((+3 min late))',
    'T(Prev Riverdale 14:24 T+3)',
    'T(Reported 30 s ago)',
    'T(reported 72 km/h) · T(reported hdg 90°)',
    'T(Vehicle 1712) · Train 1712',
  ]);
  // The feed's bare stop id is not repeated beside the stop names.
  assert.ok(copy.details.every((line) => !line.includes('place-sstat')));
});

test('an on-time next stop has no lateness, and English reads plainly', () => {
  const onTime = tripStopsNearYonkers.map((stop) => ({
    ...stop,
    arrivalDelaySec: 20,
  }));
  const copy = buildRailSelectionCopy(
    feed,
    stampedTrain,
    NOW,
    NOW,
    null,
    undefined,
    {
      stops: onTime,
    },
  );
  assert.equal(copy.details[1], 'Next Yonkers 14:32 T−4');
  assert.equal(copy.details[2], 'Prev Riverdale 14:24 T+3');
});

test('the card never grows past six lines', () => {
  const { t } = fakeT();
  const entry = {
    sample: {
      latestReportAgeMs: 5_000,
      actualDelayMs: 30_000,
      phase: 'playing',
      motion: 'moving',
    },
  };
  const busy = { ...stampedTrain, mode: 'metro', positionSource: 'gps' };
  const copy = buildRailSelectionCopy(feed, busy, NOW, NOW, entry, t, {
    stops: tripStopsNearYonkers,
  });
  assert.equal(copy.details.length, RAIL_CARD_MAX_LINES);
  assert.equal(RAIL_CARD_MAX_LINES, 6);
  // What stays: who, motion, next, previous, report age and the depth note;
  // the reported speed and the vehicle line give way first.
  assert.deepEqual(copy.details, [
    'T(Local rail) · T(Subway) · MBTA · Boston, MA',
    'T(Moving) · T(Live GPS)',
    'T(Next Yonkers 14:32 T−4) T((+3 min late))',
    'T(Prev Riverdale 14:24 T+3)',
    'T(Reported 5 s ago) · T(shown 30 s behind)',
    'T(Shown at street level · depth not in the feed)',
  ]);
  // Without stops a full card also stays within the limit.
  const noStops = buildRailSelectionCopy(feed, busy, NOW, NOW, entry, t);
  assert.ok(noStops.details.length <= RAIL_CARD_MAX_LINES);
});

test('the card says where the position comes from', () => {
  const { t } = fakeT();
  const words = {
    gps: 'T(Live GPS)',
    event: 'T(Estimated from station reports)',
  };
  for (const [positionSource, word] of Object.entries(words)) {
    const copy = buildRailSelectionCopy(
      feed,
      { ...stampedTrain, positionSource },
      NOW,
      NOW,
      null,
      t,
    );
    // No playback state: the source stands on its own line.
    assert.equal(copy.details[1], word, positionSource);
  }
  // A source the layer does not draw, a timetable's included, is never
  // named as one.
  for (const positionSource of ['psychic', 'schedule']) {
    const unknown = buildRailSelectionCopy(
      feed,
      { ...stampedTrain, positionSource },
      NOW,
      NOW,
      null,
      t,
    );
    assert.equal(unknown.details[1], 'T(Reported 30 s ago)', positionSource);
  }
});

test('only live positions are drawn: GPS and station reports', () => {
  assert.deepEqual([...RAIL_LIVE_POSITION_SOURCES], ['gps', 'event']);
  for (const source of ['gps', 'event', undefined, null])
    assert.equal(isLiveRailPositionSource(source), true, String(source));
  for (const source of ['schedule', 'psychic', ''])
    assert.equal(isLiveRailPositionSource(source), false, source);
});

test('without a route the title prefers the headsign, then the label', () => {
  const { t } = fakeT();
  const lirr = { ...stampedTrain, routeId: null, id: '7259', label: '7259' };
  assert.equal(
    buildRailSelectionCopy(feed, lirr, NOW, NOW, null, t).title,
    '🚆 T(Vehicle 7259)',
  );
  assert.equal(
    buildRailSelectionCopy(
      feed,
      { ...lirr, label: 'Train 2715' },
      NOW,
      NOW,
      null,
      t,
    ).title,
    '🚆 Train 2715',
  );
  assert.equal(
    buildRailSelectionCopy(
      feed,
      { ...lirr, headsign: 'Ronkonkoma' },
      NOW,
      NOW,
      null,
      t,
    ).title,
    '🚆 T(To Ronkonkoma)',
  );
  assert.equal(
    buildRailSelectionCopy(feed, lirr, NOW, NOW, null, t, {
      headsign: 'Babylon',
      stops: [],
    }).title,
    '🚆 T(To Babylon)',
  );
  assert.equal(
    buildRailSelectionCopy(feed, { ...lirr, label: null }, NOW, NOW, null, t)
      .title,
    '🚆 T(Vehicle 7259)',
  );
});

test('the card names a platform stop by its station', () => {
  const stops = tripStopsNearYonkers.map((stop) => ({
    ...stop,
    name: `${stop.name} Platform 2`,
    parentName: `${stop.name} Station`,
  }));
  const copy = buildRailSelectionCopy(
    feed,
    stampedTrain,
    NOW,
    NOW,
    null,
    undefined,
    {
      stops,
    },
  );
  assert.equal(copy.details[1], 'Next Yonkers Station 14:32 T−4 (+3 min late)');
  assert.equal(copy.details[2], 'Prev Riverdale Station 14:24 T+3');
});
