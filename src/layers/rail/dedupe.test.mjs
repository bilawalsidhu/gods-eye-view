// One physical train in several loaded live feeds is drawn once: copies are
// matched by train number, or by line and category when near each other,
// and the copy with the better position source and line is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NUMBER_RADIUS_KM,
  chooseCopies,
  createDuplicateFilter,
  labelNumbers,
  matchCopies,
  recordNumbers,
  recordTrainNumber,
  sameTrain,
  scoreCopy,
  trainNumber,
} from './dedupe.js';
import * as dedupe from './dedupe.js';

const ROSENHEIM = { lat: 47.85, lon: 12.119 };
const SALZBURG = { lat: 47.813, lon: 13.046 };
const LINZ = { lat: 48.29, lon: 14.291 };

/** A fake copy of a live train. */
function copy(key, feedId, extra = {}) {
  return {
    key,
    feedId,
    lat: ROSENHEIM.lat,
    lon: ROSENHEIM.lon,
    number: null,
    line: null,
    category: null,
    position: 'gps',
    onShape: false,
    ...extra,
  };
}

test('train numbers compare across feeds', () => {
  assert.equal(trainNumber('RJX 160'), '160');
  assert.equal(trainNumber('160'), '160');
  assert.equal(trainNumber('09725'), '9725');
  assert.equal(trainNumber('TGV 10465'), '10465');
  for (const none of [null, '', 'S', '0', 'RJX'])
    assert.equal(trainNumber(none), null, String(none));
});

test('the same number is one train; another number is not', () => {
  const a = copy('a', 'feed-a', { number: '160' });
  assert.equal(sameTrain(a, copy('b', 'feed-b', { number: '160' })), true);
  assert.equal(sameTrain(a, copy('b', 'feed-b', { number: '161' })), false);
  // Never within one feed, never far apart.
  assert.equal(sameTrain(a, copy('b', 'feed-a', { number: '160' })), false);
  assert.equal(
    sameTrain(a, copy('b', 'feed-b', { number: '160', ...LINZ })),
    false,
  );
  // Two feeds report one train at different moments: 70 km on
  // (Rosenheim–Salzburg) it is still the same numbered train.
  assert.ok(NUMBER_RADIUS_KM > 70);
  assert.equal(
    sameTrain(a, copy('b', 'feed-b', { number: '160', ...SALZBURG })),
    true,
  );
  assert.equal(
    matchCopies([a, copy('b', 'feed-b', { number: '160', ...SALZBURG })])
      .length,
    1,
  );
});

test('the filter matches nothing from timetables: no stops, dates or homes', () => {
  // Copies are live trains only; nothing in the filter reads a schedule.
  for (const gone of [
    'scheduleRunStops',
    'scheduleHomeCountry',
    'copyCountry',
    'shareTimedStops',
    'serviceDateKey',
  ])
    assert.equal(dedupe[gone], undefined, gone);
  // Unnumbered copies off any line are never joined, however close.
  assert.equal(sameTrain(copy('a', 'feed-a'), copy('b', 'feed-b')), false);
});

test('a bare-number headsign is the number when there is no name', () => {
  assert.equal(
    recordTrainNumber({ label: null, headsign: '839162' }),
    '839162',
  );
  assert.equal(
    recordTrainNumber({ label: 'RJX 160', headsign: '9999' }),
    '160',
  );
  assert.equal(recordTrainNumber({ label: null, headsign: 'Paris-Est' }), null);
  assert.equal(recordTrainNumber({ label: null, headsign: 'S 12' }), null);
});

test('a live vehicle labelled with its own car number takes the number from its trip', () => {
  // A live feed's vehicle 8306 runs train 530.
  const live = { id: '8306', label: '8306', tripId: 'AM:530' };
  assert.equal(recordTrainNumber(live), '530');
  // A label that is not the vehicle id is the train's name.
  assert.equal(
    recordTrainNumber({ id: 'v1', label: '531', tripId: 'AM:530' }),
    '531',
  );
  // Long trip ids are not train numbers.
  assert.equal(
    recordTrainNumber({ id: '7', label: '7', tripId: '0519321010VRFV' }),
    null,
  );
  // The GPS copy matches a station-report copy of train 530, and wins over
  // it even on the operator's line.
  const groups = matchCopies([
    copy('gps', 'gps-feed', { number: recordTrainNumber(live) }),
    copy('event', 'event-feed', {
      number: '530',
      position: 'event',
      shape: 'operator',
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(chooseCopies(groups).winners.get('event'), 'gps');
});

test('a group never holds two trains of one feed (coupled trains)', () => {
  // Two coupled TGVs side by side in one feed; the other feed names one of
  // them. Each pairs with its own number only.
  const groups = matchCopies([
    copy('fr-6194', 'feed-fr', { number: '6194' }),
    copy('fr-6906', 'feed-fr', { number: '6906' }),
    copy('ch-6194', 'feed-ch', { number: '6194' }),
    copy('ch-6906', 'feed-ch', { number: '6906' }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.map((c) => c.key).sort()).sort(),
    [
      ['ch-6194', 'fr-6194'],
      ['ch-6906', 'fr-6906'],
    ],
  );
  // On one line, one feed's two copies still never share a group.
  const s1 = { ...recordNumbers({ label: 'S1' }), category: 'local' };
  const unnamed = matchCopies([
    copy('a1', 'feed-a', s1),
    copy('a2', 'feed-a', { ...s1, lat: ROSENHEIM.lat + 0.01 }),
    copy('b1', 'feed-b', s1),
  ]);
  assert.equal(unnamed.length, 1);
  assert.equal(new Set(unnamed[0].map((c) => c.feedId)).size, 2);
});

test('a copy resembling two different trains never joins them', () => {
  // An unnumbered S1 lies near two numbered trains on its line; the two
  // carry different numbers, so the three are never one train.
  const s1 = { line: { product: 'S', number: '1' }, category: 'local' };
  const groups = matchCopies([
    copy('n1', 'feed-a', { number: '1211', ...s1 }),
    copy('n2', 'feed-s', { number: '22739', ...s1 }),
    copy('s1', 'feed-c', s1),
  ]);
  assert.ok(
    groups.every((group) => group.length < 3),
    'never all three',
  );
});

test('the score: position source, then the line', () => {
  const base = copy('a', 'x');
  assert.deepEqual(scoreCopy(base), [2, 0]);
  assert.deepEqual(scoreCopy({ ...base, position: 'event' }), [1, 0]);
  assert.deepEqual(scoreCopy({ ...base, onShape: true }), [2, 1]);
  // A source the layer does not know scores nothing.
  assert.deepEqual(scoreCopy({ ...base, position: 'psychic' }), [0, 0]);
});

test('equal copies never trade places: the one drawn stays drawn', () => {
  const twins = [
    copy('a', 'f1', { number: '160', position: 'event' }),
    copy('b', 'f2', { number: '160', position: 'event' }),
  ];
  const first = chooseCopies([twins]);
  const drawn = first.winners.get('a');
  for (let i = 0; i < 3; i++) {
    const again = chooseCopies([[...twins].reverse()], first.winners);
    assert.equal(again.winners.get('a'), drawn);
  }
  // A GPS copy takes over from a station-report one at once.
  const live = chooseCopies(
    [[twins[0], { ...twins[1], position: 'gps' }]],
    new Map([
      ['a', 'a'],
      ['b', 'a'],
    ]),
  );
  assert.equal(live.winners.get('a'), 'b');
});

/**
 * A layer's state with one live train per feed, both train RJX 160, and
 * spies for what the filter calls.
 */
function fakeLayer({ selected = null } = {}) {
  const entry = (feedId, onShape) => ({
    key: `${feedId}:v160`,
    feedId,
    record: {
      id: 'v160',
      tripId: 't1',
      label: 'RJX 160',
      ...ROSENHEIM,
      positionSource: 'gps',
    },
    path: onShape ? { shapeIndex: 0 } : null,
  });
  const trains = [entry('feed-a', false), entry('feed-b', true)];
  const state = {
    _trains: new Map(trains.map((t) => [t.key, t])),
    _selectedKey: selected,
  };
  const calls = { paint: [], selected: [] };
  const parts = {
    rendering: {
      paint: (e) => calls.paint.push([e.key, e.duplicate]),
      schedulePlayback: () => {},
    },
    selection: {
      selectTrain: (key) => {
        calls.selected.push(key);
        state._selectedKey = key;
      },
    },
  };
  return { state, parts, calls, trains };
}

test('the filter hides the weaker copy and the selection follows its train', () => {
  const layer = fakeLayer({ selected: 'feed-a:v160' });
  const filter = createDuplicateFilter({ ...layer, defer: (fn) => fn() });
  assert.deepEqual(filter.refresh(), { groups: 1, hidden: 1 });
  const [unbound, operator] = layer.trains;
  assert.equal(unbound.duplicate, true, 'not on the operator’s line');
  assert.equal(operator.duplicate, false);
  assert.deepEqual(layer.calls.selected, [operator.key]);
  // When the copy on the operator's line goes (its feed left the view), the
  // other is drawn.
  layer.state._trains.delete(operator.key);
  filter.scheduleRefresh();
  assert.equal(unbound.duplicate, false);
  assert.deepEqual(filter.stats(), { groups: 0, hidden: 0 });
});

test('a copy a first-person view holds stays drawn, with the selection', () => {
  const pair = [
    copy('a', 'f1', { number: '160', position: 'event' }),
    copy('b', 'f2', { number: '160', position: 'gps' }),
  ];
  assert.equal(chooseCopies([pair]).winners.get('a'), 'b');
  const held = chooseCopies([pair], new Map(), 'a');
  assert.equal(held.winners.get('b'), 'a', 'drawn whatever the scores');
  assert.deepEqual([...held.hidden], ['b']);
  // Let go, the better copy takes over.
  assert.equal(chooseCopies([pair], held.winners).winners.get('a'), 'b');

  const layer = fakeLayer({ selected: 'feed-a:v160' });
  layer.state._cockpitSubjectKey = 'feed-a:v160';
  const filter = createDuplicateFilter({ ...layer, defer: (fn) => fn() });
  filter.refresh();
  const [unbound, operator] = layer.trains;
  assert.equal(unbound.duplicate, false, 'the held copy');
  assert.equal(operator.duplicate, true);
  assert.deepEqual(layer.calls.selected, [], 'the selection stays on it');
  layer.state._cockpitSubjectKey = null;
  filter.refresh();
  assert.equal(unbound.duplicate, true);
  assert.deepEqual(layer.calls.selected, [operator.key]);
});

test('a short number after a local product names a line, not a train (S1, RB 1, U6)', () => {
  for (const label of ['S1', 'RB 1', 'U6', 'S 12', 'RE5'])
    assert.equal(recordTrainNumber({ label }), null, label);
  assert.deepEqual(labelNumbers('RB 1').line, { product: 'RB', number: '1' });
  // Three digits, or a long-distance product's own short number, are a
  // train's.
  assert.equal(recordTrainNumber({ label: 'EC 7' }), '7');
  assert.equal(recordTrainNumber({ label: 'NJ 40' }), '40');
  assert.equal(recordTrainNumber({ label: 'S 1264' }), '1264');
  // A line name gives way to a trip id that is the train's number.
  assert.equal(recordTrainNumber({ label: '5', tripId: 'AM:5' }), '5');

  // An S1 and an RB 1 25 km apart are never joined as one train numbered 1.
  const s1 = copy('s1', 'feed-a', {
    ...recordNumbers({ label: 'S1' }),
    lat: 48.14,
    lon: 11.56,
    category: 'local',
  });
  const rb1 = copy('rb1', 'feed-b', {
    ...recordNumbers({ label: 'RB 1' }),
    lat: 48.14 + 25 / 111.32,
    lon: 11.56,
    category: 'regional',
  });
  assert.equal(sameTrain(s1, rb1), false);
  assert.deepEqual(matchCopies([s1, rb1]), []);
  // Nearer, still two lines.
  assert.equal(sameTrain(s1, { ...rb1, lat: 48.15, category: 'local' }), false);
});

test('copies on one line are one train in one category, the nearest first', () => {
  const at = (key, feedId, km, extra = {}) =>
    copy(key, feedId, {
      ...recordNumbers({ label: extra.label ?? 'S1' }),
      lat: 48.14 + km / 111.32,
      lon: 11.56,
      category: 'local',
      ...extra,
    });
  const gps = at('gps', 'feed-a', 0);
  // The other feed reports two S1 trains near it; the nearer is the same.
  const near = at('near', 'feed-b', 1, { position: 'event' });
  const next = at('next', 'feed-b', 6, { label: 'S 1', position: 'event' });
  assert.equal(sameTrain(gps, near), true);
  assert.deepEqual(
    matchCopies([next, gps, near]).map((group) =>
      group.map((c) => c.key).sort(),
    ),
    [['gps', 'near']],
  );
  // Another category, or beyond the match radius: not one train.
  assert.equal(sameTrain(gps, { ...near, category: 'regional' }), false);
  assert.equal(sameTrain(gps, at('far', 'feed-b', 20)), false);
});

test('copies on one line 14 km apart east-west at 60°N are compared', () => {
  // A 0.25° grid column is 13.9 km wide there: the copies sit two columns
  // apart.
  const line = { ...recordNumbers({ label: 'R1' }), category: 'regional' };
  const west = copy('west', 'feed-a', { lat: 60, lon: 10.24, ...line });
  const east = copy('east', 'feed-b', { lat: 60, lon: 10.5, ...line });
  assert.equal(sameTrain(west, east), true);
  assert.equal(matchCopies([west, east]).length, 1);
});

test('the filter reads lines and categories from the trains it compares', () => {
  const entry = (feedId, label, category, lat) => ({
    key: `${feedId}:${label}`,
    feedId,
    category,
    record: {
      id: `v-${feedId}`,
      label,
      lat,
      lon: 11.56,
      positionSource: 'gps',
    },
  });
  const trains = [
    entry('munich-live', 'S1', 'local', 48.14),
    entry('other-live', 'S 1', 'local', 48.15),
    entry('third-live', 'RB 1', 'regional', 48.16),
  ];
  const state = {
    _trains: new Map(trains.map((t) => [t.key, t])),
    _pathPacks: new Map(),
    _selectedKey: null,
  };
  const parts = {
    rendering: { paint() {}, schedulePlayback() {} },
    selection: { selectTrain() {} },
  };
  const filter = createDuplicateFilter({
    state,
    parts,
    defer: (fn) => fn(),
  });
  assert.deepEqual(filter.refresh(), { groups: 1, hidden: 1 });
  assert.equal(trains[2].duplicate, false, 'the RB 1 is its own train');
});

test('a Swiss IC line name is not a train number', () => {
  assert.deepEqual(labelNumbers('IC 1'), {
    number: null,
    line: { product: 'IC', number: '1' },
  });
  assert.deepEqual(labelNumbers('IC 2010'), { number: '2010', line: null });
  assert.deepEqual(labelNumbers('EC 7'), { number: '7', line: null });
});
