import assert from 'node:assert/strict';
import test from 'node:test';
import { responseInstructionForToolResult } from './realtimeProtocol.js';
import { attachVoiceResult } from './speech.js';

test('the aircraft identity follow-up speaks the identity line', () => {
  // The follow-up now speaks the code-built say line, which always covers
  // operator, type and route (see speech.test.mjs for the field rules).
  const followup = responseInstructionForToolResult(
    attachVoiceResult('get_entity_context', {
      ok: true,
      action: 'get_entity_context',
      selected: {
        id: 'a',
        layerId: 'flights',
        properties: { callsign: 'UAL1' },
      },
    }),
  );
  assert.match(
    followup,
    /asked what the aircraft is, speak its identityLine and add nothing/,
  );
  assert.match(
    followup,
    /any other question \(altitude, speed, registration\), answer from selected\.properties/,
  );
});
