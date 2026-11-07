import { readRealtimeSource } from '../testSupport/readRealtimeSource.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { responseInstructionForToolResult } from './realtimeProtocol.js';
import { attachVoiceResult } from './speech.js';

const voiceConfig = readFileSync(
  new URL('../../server/providers/openai/instructions.js', import.meta.url),
  'utf8',
);
const realtime = readRealtimeSource();

test('aircraft identity narration acknowledges missing enrichment', () => {
  const start = voiceConfig.indexOf('\'For "what is this aircraft?"');
  assert.ok(start >= 0, 'aircraft identity honesty instruction is missing');
  const text = voiceConfig.slice(start, voiceConfig.indexOf('\n', start));
  assert.match(text, /get_entity_context/);
  assert.match(
    text,
    /callsign, operator, type and route from returned fields only/,
  );
  assert.match(text, /airport codes verbatim/);
  assert.match(text, /Never infer them from the callsign/);
  assert.match(
    text,
    /Other questions about the selection answer from its properties/,
  );

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
  assert.doesNotMatch(realtime, /Operator details are unavailable/);
});
