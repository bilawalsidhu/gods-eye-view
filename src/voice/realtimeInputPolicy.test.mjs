import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVoicePresentationState } from './realtimeInputPolicy.js';

test('voice presentation separates session, turn, action and audible output', () => {
  assert.equal(resolveVoicePresentationState(), 'idle');
  assert.equal(
    resolveVoicePresentationState({ sessionState: 'connecting' }),
    'connecting',
  );
  assert.equal(
    resolveVoicePresentationState({ sessionState: 'listening' }),
    'ready',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'user',
    }),
    'listening',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      speaker: 'ai',
      responseActive: true,
    }),
    'working',
    'response ownership alone must not claim audible speech',
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
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'executing',
      speaker: 'ai',
      responseActive: true,
      outputAudible: true,
    }),
    'executing',
    'typed action ownership is more specific than audio activity',
  );
});

test('interruption is distinct from disconnect and error', () => {
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'listening',
      responseActive: true,
      interrupted: true,
    }),
    'interrupted',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'error',
      interrupted: true,
    }),
    'error',
  );
  assert.equal(
    resolveVoicePresentationState({
      sessionState: 'idle',
      interrupted: true,
    }),
    'idle',
  );
});
