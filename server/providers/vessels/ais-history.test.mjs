import test from 'node:test';
import assert from 'node:assert/strict';
import { openAisHistory, aisHistoryEnabled, historyIntFromEnv } from './ais-history.js';

// Real AIS epochs are current; retention would legitimately prune 1970 rows.
const NOW_SEC = Math.floor(Date.now() / 1000);

function memoryHistory(overrides = {}) {
  return openAisHistory({ dbPath: ':memory:', flushMs: 1e9, ...overrides });
}

test('aisHistoryEnabled reads the documented truthy spellings', () => {
  for (const value of ['1', 'true', 'YES', 'on'])
    assert.equal(aisHistoryEnabled({ GEV_AIS_HISTORY: value }), true);
  for (const value of ['', '0', 'false', undefined])
    assert.equal(aisHistoryEnabled({ GEV_AIS_HISTORY: value }), false);
});

test('historyIntFromEnv rejects non-positive and unparsable values', () => {
  assert.equal(historyIntFromEnv('45', 30), 45);
  assert.equal(historyIntFromEnv('0', 30), 30);
  assert.equal(historyIntFromEnv('-3', 30), 30);
  assert.equal(historyIntFromEnv('abc', 30), 30);
  assert.equal(historyIntFromEnv(undefined, 30), 30);
});

test('positions round-trip in chronological order', () => {
  const history = memoryHistory();
  history.queuePosition('111111111', 1.5, 2.5, NOW_SEC - 200, 8.1, 90);
  history.queuePosition('111111111', 1.6, 2.6, NOW_SEC - 100, 8.4, 91);
  history.queuePosition('222222222', 9, 9, NOW_SEC - 150, 0, 0);
  const track = history.readTrack('111111111');
  assert.equal(track.length, 2);
  assert.equal(track[0].t, NOW_SEC - 200);
  assert.equal(track[1].t, NOW_SEC - 100);
  assert.ok(Math.abs(track[1].lat - 1.6) < 1e-6);
  assert.equal(history.readTrack('222222222').length, 1);
  history.close();
});

test('duplicate (mmsi, t) fixes collapse rather than accumulating', () => {
  const history = memoryHistory();
  history.queuePosition('111111111', 1, 2, NOW_SEC - 500, null, null);
  history.queuePosition('111111111', 1, 2, NOW_SEC - 500, null, null);
  assert.equal(history.readTrack('111111111').length, 1);
  history.close();
});

test('sinceSec and limit bound the track read', () => {
  const history = memoryHistory();
  for (let i = 0; i < 10; i++)
    history.queuePosition('111111111', i, i, NOW_SEC - 1000 + i * 10, null, null);
  assert.equal(history.readTrack('111111111', { sinceSec: NOW_SEC - 950 }).length, 5);
  assert.equal(history.readTrack('111111111', { limit: 3 }).length, 3);
  history.close();
});

test('voyage rows are written only when intent changes', () => {
  const history = memoryHistory();
  const voyage = { destination: 'ROTTERDAM', eta: '05-01 12:00', draught: 12.2, navStatus: 0 };
  history.queueVoyage('111111111', voyage, NOW_SEC - 300);
  history.queueVoyage('111111111', voyage, NOW_SEC - 200); // identical — must not persist
  history.queueVoyage('111111111', { ...voyage, draught: 6.1 }, NOW_SEC - 100);
  const voyages = history.readVoyages('111111111');
  assert.equal(voyages.length, 2);
  assert.equal(voyages[0].draught, 6.1); // newest first
  assert.equal(voyages[1].destination, 'ROTTERDAM');
  history.close();
});

test('an entirely empty voyage is not recorded', () => {
  const history = memoryHistory();
  history.queueVoyage('111111111', {}, NOW_SEC - 100);
  assert.equal(history.readVoyages('111111111').length, 0);
  history.close();
});

test('draughtExtremes spans every recorded voyage', () => {
  const history = memoryHistory();
  history.queueVoyage('111111111', { draught: 12.5 }, NOW_SEC - 300);
  history.queueVoyage('111111111', { draught: 6.0 }, NOW_SEC - 200);
  history.queueVoyage('111111111', { draught: 9.2 }, NOW_SEC - 100);
  history.flush();
  assert.deepEqual(history.draughtExtremes('111111111'), { min: 6.0, max: 12.5 });
  assert.equal(history.draughtExtremes('999999999'), null);
  history.close();
});

test('identity upsert preserves known fields against later blanks', () => {
  const history = memoryHistory();
  history.queueIdentity('111111111', {
    imo: '9999999', name: 'EVER GIVEN', callSign: 'H3RC', type: 'Cargo', length: 400, beam: 59,
  });
  history.flush();
  history.queueIdentity('111111111', { name: '', imo: '' });
  history.flush();
  const identity = history.readIdentity('111111111');
  assert.equal(identity.name, 'EVER GIVEN');
  assert.equal(identity.imo, '9999999');
  assert.equal(identity.length, 400);
  history.close();
});

test('prune drops rows past the retention horizon', () => {
  let nowMs = 10_000_000_000;
  const history = openAisHistory({
    dbPath: ':memory:', flushMs: 1e9, retentionDays: 1, now: () => nowMs,
  });
  const nowSec = Math.floor(nowMs / 1000);
  history.queuePosition('111111111', 1, 1, nowSec - 2 * 86400, null, null); // stale
  history.queuePosition('111111111', 2, 2, nowSec - 3600, null, null); // fresh
  history.flush();
  history.prune();
  const track = history.readTrack('111111111');
  assert.equal(track.length, 1);
  assert.equal(track[0].t, nowSec - 3600);
  history.close();
});

test('reads and writes after close are inert, not throwing', () => {
  const history = memoryHistory();
  history.queuePosition('111111111', 1, 1, NOW_SEC - 100, null, null);
  history.close();
  assert.doesNotThrow(() =>
    history.queuePosition('111111111', 2, 2, NOW_SEC - 50, null, null),
  );
  assert.deepEqual(history.readTrack('111111111'), []);
  assert.deepEqual(history.readVoyages('111111111'), []);
});

test('an unopenable path degrades to disabled instead of throwing', () => {
  const history = openAisHistory({ dbPath: '/proc/definitely/not/writable/x.db' });
  assert.equal(history.disabled, true);
  assert.ok(history.error);
});

test('lastFix returns the newest stored point, not the oldest', () => {
  const history = memoryHistory();
  history.queuePosition('111111111', 1, 1, NOW_SEC - 3600, 5, 90);
  history.queuePosition('111111111', 2, 2, NOW_SEC - 60, 9, 180);
  history.queuePosition('111111111', 3, 3, NOW_SEC - 1800, 7, 270);
  const last = history.lastFix('111111111');
  assert.equal(last.t, NOW_SEC - 60, 'newest wins regardless of insert order');
  assert.equal(last.lat, 2);
  assert.equal(history.lastFix('999999999'), null);
  history.close();
});

test('identity search matches name and identifiers', () => {
  const history = memoryHistory();
  history.queueIdentity('636018600', { name: 'OI MARU', imo: '9749922', type: '70' });
  history.queueIdentity('431209000', { name: 'OITA MARU', imo: '9398151', type: '70' });
  history.flush();
  assert.equal(history.searchIdentities('OI MARU')[0].name, 'OI MARU', 'exact name ranks first');
  assert.equal(history.searchIdentities('636018600')[0].mmsi, '636018600');
  assert.equal(history.searchIdentities('9749922')[0].name, 'OI MARU', 'found by IMO');
  assert.equal(history.searchIdentities('MARU').length, 2);
  assert.deepEqual(history.searchIdentities('x'), [], 'too short');
  history.close();
});
