// Loading-cover health roster copy and NDJSON parsing, exercised without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeNdjson,
  healthNoticeCopy,
  healthProblems,
  healthStateLabel,
  healthStateSeverity,
  summarizeLoadingHealth,
} from './loadingHealth.js';

test('state labels and severities cover every probe state', () => {
  assert.equal(healthStateLabel('ok'), 'LIVE');
  assert.equal(healthStateLabel('configured'), 'KEY SET');
  assert.equal(healthStateLabel('key-missing'), 'NO KEY');
  assert.equal(healthStateLabel('key-invalid'), 'KEY REJECTED');
  assert.equal(healthStateLabel('down'), 'DOWN');
  assert.equal(healthStateLabel('bogus'), 'CHECKING');
  assert.equal(healthStateSeverity('ok'), 'good');
  assert.equal(healthStateSeverity('configured'), 'good');
  assert.equal(healthStateSeverity('degraded'), 'warn');
  assert.equal(healthStateSeverity('key-missing'), 'muted');
  assert.equal(healthStateSeverity('key-invalid'), 'error');
  assert.equal(healthStateSeverity('down'), 'error');
  assert.equal(healthStateSeverity(undefined), 'pending');
});

test('summary shows progress while probes are still settling', () => {
  const s = summarizeLoadingHealth([{ state: 'ok' }, { state: 'down' }], 5);
  assert.deepEqual(s, { tone: 'pending', text: 'CHECKING APIS 2/5' });
});

test('summary counts outcomes and flags a failed required service', () => {
  const rows = [
    { state: 'ok', tier: 'required' },
    { state: 'ok' }, { state: 'configured' },
    { state: 'degraded' },
    { state: 'key-missing' }, { state: 'key-missing' },
    { state: 'down' }, { state: 'key-invalid' },
  ];
  assert.deepEqual(summarizeLoadingHealth(rows), { tone: 'warn', text: '3 LIVE · 1 DEGRADED · 2 NO KEY · 2 DOWN' });
  const requiredDown = [{ state: 'key-missing', tier: 'required' }, { state: 'ok' }];
  assert.equal(summarizeLoadingHealth(requiredDown).tone, 'error');
  assert.deepEqual(summarizeLoadingHealth([{ state: 'ok' }]), { tone: 'good', text: '1 LIVE' });
});

test('timed-out run reports unanswered rows; unavailable endpoint is explicit', () => {
  const s = summarizeLoadingHealth([{ state: 'ok' }], 4, { timedOut: true });
  assert.equal(s.text, '1 LIVE · 3 UNANSWERED');
  assert.equal(summarizeLoadingHealth([], 0, { unavailable: true }).text, 'API HEALTH CHECK UNAVAILABLE');
});

test('consumeNdjson yields complete lines and keeps the partial tail', () => {
  const events = [];
  let buffer = consumeNdjson('', '{"a":1}\n{"b":2}\n{"c"', (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.equal(buffer, '{"c"');
  buffer = consumeNdjson(buffer, ':3}\nnot json\n', (e) => events.push(e));
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(buffer, '');
});

test('healthProblems keeps only down / rejected / degraded rows', () => {
  const rows = [
    { id: 'a', state: 'ok' }, { id: 'b', state: 'configured' }, { id: 'c', state: 'key-missing' },
    { id: 'd', state: 'degraded' }, { id: 'e', state: 'key-invalid' }, { id: 'f', state: 'down' },
  ];
  assert.deepEqual(healthProblems(rows).map((r) => r.id), ['d', 'e', 'f']);
});

test('healthNoticeCopy names the failures and is silent for a clean roster', () => {
  assert.equal(healthNoticeCopy([{ state: 'ok' }, { state: 'key-missing' }]), null);
  const notice = healthNoticeCopy([
    { label: 'AISStream vessels', state: 'degraded' },
    { label: 'GBFS bikeshare', state: 'down' },
    { label: 'Cesium ion', state: 'key-invalid' },
    { label: 'USGS earthquakes', state: 'down' },
    { label: 'Open-Meteo weather', state: 'ok' },
  ]);
  assert.equal(notice.label, 'API HEALTH: AISStream vessels DEGRADED · GBFS bikeshare DOWN · Cesium ion KEY REJECTED +1');
  assert.equal(notice.detail, '3 DOWN · 1 DEGRADED');
  assert.equal(notice.state, 'error');
  const warnOnly = healthNoticeCopy([{ label: 'X', state: 'degraded' }]);
  assert.equal(warnOnly.state, 'cancelled');
  const unanswered = healthNoticeCopy([{ label: 'X', state: 'ok' }], { timedOut: true, total: 3 });
  assert.equal(unanswered.label, 'API HEALTH: 2 UNANSWERED');
  assert.equal(unanswered.detail, '2 UNANSWERED');
});
