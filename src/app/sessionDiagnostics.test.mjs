import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionDiagnostics, instanceId } from './sessionDiagnostics.js';

test('an object keeps its id and another object gets another one', () => {
  const a = {};
  const b = {};
  const fn = () => {};
  assert.equal(instanceId(a), instanceId(a));
  assert.notEqual(instanceId(a), instanceId(b));
  assert.equal(typeof instanceId(fn), 'number');
  assert.equal(instanceId(null), null);
  assert.equal(instanceId(undefined), null);
  assert.equal(instanceId(3), null);
});

test('the diagnostics read ids at the time they are asked for', () => {
  let shell = {};
  const voice = {};
  const diagnostics = createSessionDiagnostics(() => ({ shell, voice }));
  const first = diagnostics.ids;
  assert.equal(first.shell, instanceId(shell));
  assert.deepEqual(diagnostics.ids, first);
  shell = {};
  assert.notEqual(diagnostics.ids.shell, first.shell);
  assert.equal(diagnostics.ids.voice, first.voice);
});

test('counters start at zero and count each event', () => {
  const diagnostics = createSessionDiagnostics(() => ({}));
  assert.equal(diagnostics.attachments, 0);
  diagnostics.count('attachments');
  diagnostics.count('attachments');
  diagnostics.count('detaches');
  assert.equal(diagnostics.attachments, 2);
  assert.equal(diagnostics.detaches, 1);
  assert.deepEqual(diagnostics.counters, {
    applications: 0,
    attachments: 2,
    detaches: 1,
    rollbacks: 0,
  });
});
