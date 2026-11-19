import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageOf,
  forecastTimes,
  nearestForecastTime,
  selectAt,
  selectionKey,
} from './time.js';
import { REPORT_WINDOW_MS } from './records.js';

const H = 3_600_000;
const T0 = Date.parse('2026-11-17T15:00:00Z');
const forecast = (hours, id = `f${hours}`) => ({
  id,
  kind: 'forecast',
  validAt: T0 + hours * H,
});
const warning = (id, from, to) => ({
  id,
  kind: 'warning',
  validFrom: T0 + from * H,
  validTo: T0 + to * H,
});
const report = (id, at) => ({ id, kind: 'report', observedAt: T0 + at * H });

const snapshot = {
  forecasts: [0, 3, 6, 9, 12].flatMap((h) => [
    forecast(h),
    forecast(h, `g${h}`),
  ]),
  warnings: [warning('w1', 1, 5), warning('w2', 4, 8)],
  reports: [report('r1', 4), report('r2', 5.5)],
};

test('forecast times are the distinct snapshots, ascending', () => {
  assert.deepEqual(
    forecastTimes(snapshot),
    [0, 3, 6, 9, 12].map((h) => T0 + h * H),
  );
});

test('the nearest snapshot is chosen, within half the spacing', () => {
  assert.equal(nearestForecastTime(snapshot, T0), T0);
  assert.equal(nearestForecastTime(snapshot, T0 + 1 * H), T0);
  assert.equal(nearestForecastTime(snapshot, T0 + 2 * H), T0 + 3 * H);
  assert.equal(nearestForecastTime(snapshot, T0 + 5.3 * H), T0 + 6 * H);
  // Outside the snapshots by more than half a spacing: none.
  assert.equal(nearestForecastTime(snapshot, T0 - 2 * H), null);
  assert.equal(nearestForecastTime(snapshot, T0 + 14 * H), null);
  assert.equal(nearestForecastTime({ forecasts: [] }, T0), null);
});

test('exactly halfway between snapshots reads as the later one', () => {
  assert.equal(nearestForecastTime(snapshot, T0 + 1.5 * H), T0 + 3 * H);
  assert.equal(nearestForecastTime(snapshot, T0 + 10.5 * H), T0 + 12 * H);
});

test('a single snapshot is shown for 1.5 h either side', () => {
  const one = { forecasts: [forecast(6)] };
  assert.equal(nearestForecastTime(one, T0 + 4.5 * H), T0 + 6 * H);
  assert.equal(nearestForecastTime(one, T0 + 7.5 * H), T0 + 6 * H);
  assert.equal(nearestForecastTime(one, T0 + 7.6 * H), null);
});

test('selectAt: one snapshot, warnings in force, reports in the window', () => {
  const at = selectAt(snapshot, T0 + 4.5 * H);
  assert.equal(at.forecastValidAt, T0 + 6 * H, 'tie at 4.5 h goes to 6 h');
  assert.deepEqual(
    at.forecasts.map((r) => r.id),
    ['f6', 'g6'],
  );
  assert.deepEqual(
    at.warnings.map((r) => r.id),
    ['w1', 'w2'],
  );
  assert.deepEqual(
    at.reports.map((r) => r.id),
    ['r1'],
  );

  const later = selectAt(snapshot, T0 + 6 * H);
  assert.deepEqual(
    later.warnings.map((r) => r.id),
    ['w2'],
  );
  assert.deepEqual(
    later.reports.map((r) => r.id),
    ['r1', 'r2'],
  );
});

test('windows are half-open: a warning ends at its end time', () => {
  assert.deepEqual(
    selectAt(snapshot, T0 + 5 * H).warnings.map((r) => r.id),
    ['w2'],
  );
  assert.deepEqual(
    selectAt(snapshot, T0 + 4 * H).warnings.map((r) => r.id),
    ['w1', 'w2'],
  );
  const leave = T0 + 4 * H + REPORT_WINDOW_MS;
  assert.deepEqual(
    selectAt(snapshot, leave - 1).reports.map((r) => r.id),
    ['r1', 'r2'],
  );
  assert.deepEqual(
    selectAt(snapshot, leave).reports.map((r) => r.id),
    ['r2'],
  );
});

test('the key changes exactly when what is shown changes', () => {
  const shown = (t) => {
    const at = selectAt(snapshot, t);
    return JSON.stringify([
      at.forecastValidAt,
      at.warnings.map((r) => r.id),
      at.reports.map((r) => r.id),
    ]);
  };
  // Every 5 minutes across the whole span: equal keys mean equal content,
  // and a content change always comes with a key change.
  let previous = null;
  for (let t = T0 - 3 * H; t <= T0 + 15 * H; t += 5 * 60_000) {
    const now = { key: selectionKey(snapshot, t), shown: shown(t) };
    if (previous) {
      if (now.shown !== previous.shown)
        assert.notEqual(now.key, previous.key, `content changed at ${t}`);
      if (now.key === previous.key)
        assert.equal(now.shown, previous.shown, `key hid a change at ${t}`);
    }
    previous = now;
  }
  // And at the boundaries themselves.
  for (const t of [T0 + 5 * H, T0 + 4 * H + REPORT_WINDOW_MS]) {
    assert.notEqual(selectionKey(snapshot, t - 1), selectionKey(snapshot, t));
  }
});

test('coverage spans the snapshots, the warnings and the reporting window', () => {
  const now = T0 + 5 * H;
  const covered = coverageOf(snapshot, now);
  assert.equal(covered.start, T0 - 1.5 * H);
  assert.equal(covered.end, T0 + 13.5 * H);
  // With only reports, the window before now.
  const reportsOnly = coverageOf(
    { forecasts: [], warnings: [], reports: [report('r', 4)] },
    now,
  );
  assert.deepEqual(reportsOnly, { start: now - REPORT_WINDOW_MS, end: now });
  assert.equal(
    coverageOf({ forecasts: [], warnings: [], reports: [] }, now),
    null,
  );
  assert.equal(coverageOf(null, now), null);
});
