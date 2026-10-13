import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_COLOR,
  DELAY_BANDS,
  UNREPORTED_COLOR,
  buildCrossingCard,
  crossingTitle,
  delayBandKey,
  delayColor,
  laneLine,
  selectLabelCohort,
} from './cards.js';
import { normalizeBorderWaitSnapshot } from './records.js';
import { cbpPort, cbpPedestrianPort, FIXTURE_LOCATIONS } from './fixture.mjs';

const rowsOf = (...ports) =>
  normalizeBorderWaitSnapshot(ports, FIXTURE_LOCATIONS).rows;
const row = (overrides = {}) => ({ ...rowsOf(cbpPort())[0], ...overrides });

test('delay bands split at 15, 30 and 60 minutes', () => {
  const color = (key) => DELAY_BANDS.find((band) => band.key === key).color;
  for (const [minutes, key] of [
    [0, 'short'],
    [14, 'short'],
    [15, 'moderate'],
    [29, 'moderate'],
    [30, 'long'],
    [59, 'long'],
    [60, 'severe'],
    [240, 'severe'],
  ]) {
    const candidate = row({ delayMinutes: minutes });
    assert.equal(delayBandKey(candidate), key, `${minutes} min`);
    assert.equal(delayColor(candidate), color(key), `${minutes} min`);
  }
});

test('closed and unreported crossings read differently from a short wait', () => {
  const closedPort = row({ portStatus: 'closed', delayMinutes: 0 });
  assert.equal(delayBandKey(closedPort), 'closed');
  assert.equal(delayColor(closedPort), CLOSED_COLOR);
  const closedLanes = row({ delayStatus: 'lanes closed', delayMinutes: null });
  assert.equal(delayColor(closedLanes), CLOSED_COLOR);
  const pending = row({ delayStatus: 'update pending', delayMinutes: null });
  assert.equal(delayBandKey(pending), 'unreported');
  assert.equal(delayColor(pending), UNREPORTED_COLOR);
});

test('a crossing card lists each reported lane with its wait and timing', () => {
  const card = buildCrossingCard(row());
  assert.equal(card.id, 'border-waits-card:380001');
  assert.equal(card.title, 'BORDER · Detroit · Ambassador Bridge');
  assert.equal(card.interactive, false);
  assert.equal(card.selected, true);
  assert.deepEqual(card.details, [
    'Into the U.S. from Canada',
    'Cars · 5 min · 2 open',
    'Cars NEXUS/SENTRI · 5 min · 3 open',
    'Cars Ready · closed',
    'Trucks · 5 min · 5 open',
    'Trucks FAST · 5 min · 2 open',
    'updated 9:00 am EDT · 24 hrs/day',
    'A Ready Lane is available from 11am-2pm Monday through Friday. More at: https://www.cbp.gov/travel',
  ]);
  assert.equal(card.accent, delayColor(row()));
});

test('a stale or closed crossing says so on its card', () => {
  const pedestrian = rowsOf(cbpPedestrianPort())[0];
  const card = buildCrossingCard(
    { ...pedestrian, portStatus: 'closed' },
    { stale: true },
  );
  assert.equal(card.title, 'BORDER · San Ysidro · PedWest');
  assert.equal(card.details[0], 'Port closed · into the U.S. from Mexico');
  assert.equal(
    card.details.at(-1),
    'CBP unreachable · showing the last update',
  );
  assert.ok(card.details.includes('Walk · 75 min · 4 open'));
  assert.ok(card.details.includes('Walk Ready · update pending'));
});

test('titles avoid repeating a port name CBP also uses as the crossing name', () => {
  assert.equal(crossingTitle(row({ crossing: null })), 'Detroit');
  assert.equal(crossingTitle(row({ crossing: 'DETROIT' })), 'Detroit');
  assert.equal(
    laneLine({ mode: 'passenger', kind: 'standard', status: 'delay' }),
    'Cars · delay',
  );
});

test('minute labels favour the longest waits and skip crossings with nothing to say', () => {
  const rows = [
    row({ id: 'a', delayMinutes: 10 }),
    row({ id: 'b', delayMinutes: 90 }),
    row({ id: 'c', delayMinutes: null, delayStatus: 'update pending' }),
    row({ id: 'd', portStatus: 'closed', delayMinutes: null }),
    row({ id: 'e', delayMinutes: 90 }),
  ];
  const labels = selectLabelCohort(rows);
  assert.deepEqual(
    labels.map(({ rowId, title }) => `${rowId}:${title}`),
    ['b:90 min', 'e:90 min', 'a:10 min', 'd:closed'],
  );
  assert.equal(labels[0].id, 'border-waits-label:b');
  assert.equal(labels[0].interactive, false);
  assert.equal(selectLabelCohort(rows, 2).length, 2);
});
