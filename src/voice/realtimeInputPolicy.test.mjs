import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveVoicePresentationState,
  VOICE_PRESENTATION_STATES,
} from './realtimeInputPolicy.js';

test('voice presentation exposes one stable semantic vocabulary', () => {
  assert.deepEqual(VOICE_PRESENTATION_STATES, [
    'idle',
    'connecting',
    'ready',
    'listening',
    'working',
    'executing',
    'speaking',
    'interrupted',
    'error',
  ]);
  assert.equal(resolveVoicePresentationState(), 'idle');
  assert.equal(
    resolveVoicePresentationState({ sessionState: 'connecting' }),
    'connecting',
  );
  assert.equal(
    resolveVoicePresentationState({ sessionState: 'listening' }),
    'ready',
  );
});

test('unknown session state fails closed before activity flags', () => {
  for (const sessionState of [
    null,
    'closed',
    'Idle',
    'ready',
    'speaking',
    'interrupted',
    '',
    123,
  ]) {
    assert.equal(
      resolveVoicePresentationState({
        sessionState,
        speaker: 'user',
        interrupted: true,
        actionActive: true,
        outputAudible: true,
        responseActive: true,
      }),
      'idle',
      `unknown session state: ${String(sessionState)}`,
    );
  }
});

test('supported session states retain their settled baseline', () => {
  const expected = [
    ['idle', 'idle'],
    ['connecting', 'connecting'],
    ['listening', 'ready'],
    ['executing', 'executing'],
    ['error', 'error'],
  ];
  for (const [sessionState, state] of expected) {
    assert.equal(resolveVoicePresentationState({ sessionState }), state);
  }
});

test('only literal true activates interruption, action, audio and response', () => {
  for (const value of [undefined, null, 'false', 'true', 0, 1, [], {}]) {
    const label = `non-boolean: ${JSON.stringify(value)}`;
    assert.equal(
      resolveVoicePresentationState({
        sessionState: 'listening',
        speaker: 'ai',
        interrupted: value,
        outputAudible: true,
      }),
      'speaking',
      `interrupted, ${label}`,
    );
    assert.equal(
      resolveVoicePresentationState({
        sessionState: 'listening',
        speaker: 'ai',
        actionActive: value,
        responseActive: true,
      }),
      'working',
      `actionActive, ${label}`,
    );
    assert.equal(
      resolveVoicePresentationState({
        sessionState: 'listening',
        speaker: 'ai',
        outputAudible: value,
        responseActive: true,
      }),
      'working',
      `outputAudible, ${label}`,
    );
    assert.equal(
      resolveVoicePresentationState({
        sessionState: 'listening',
        speaker: 'ai',
        responseActive: value,
      }),
      'ready',
      `responseActive, ${label}`,
    );
  }
});

test('response ownership is working until output becomes measurably audible', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'ai',
      responseActive: true,
    }),
    'working',
    'response.created must not claim audible speech',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'ai',
      responseActive: true,
      outputAudible: true,
    }),
    'speaking',
  );
});

test('buffered output remains speaking after response.done', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'idle',
      responseActive: false,
      outputAudible: true,
    }),
    'speaking',
    'WebRTC output can drain after the response control event completes',
  );
});

test('the card may show action details while the pill shows current turn ownership', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'executing',
      speaker: 'ai',
      responseActive: true,
      actionActive: true,
      outputAudible: true,
    }),
    'executing',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'executing',
      speaker: 'user',
      responseActive: true,
      actionActive: true,
      outputAudible: true,
    }),
    'listening',
    'a post-barge-in user turn outranks lingering tool and audio state',
  );
});

test('successful interruption is distinct from a refused Space takeover', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'executing',
      speaker: 'ai',
      responseActive: true,
      actionActive: true,
      outputAudible: true,
      interrupted: true,
    }),
    'interrupted',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'ai',
      responseActive: true,
      outputAudible: true,
      interrupted: false,
    }),
    'speaking',
    'Space alone must not report interruption when Radio refused barge-in',
  );
});

test('session terminal states remain authoritative', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'error',
      speaker: 'user',
      interrupted: true,
    }),
    'error',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'idle',
      outputAudible: true,
      interrupted: true,
    }),
    'idle',
  );
});
