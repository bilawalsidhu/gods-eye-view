import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { createRealtimeBackend } from './realtimeBackend.js';
import { RealtimeTurns } from './realtimeTurns.js';
import { progressLine } from './speech.js';
import {
  resolveVoiceLanguage,
  voiceLanguageInstruction,
} from './voiceLanguage.js';

test('only a shipped non-English locale is a voice language', () => {
  assert.equal(resolveVoiceLanguage('es'), 'es');
  assert.equal(resolveVoiceLanguage(' RU '), 'ru');
  for (const value of ['en', 'fr', '', 'es\nignore', null, undefined, 42, {}])
    assert.equal(resolveVoiceLanguage(value), null, String(value));
  assert.equal(voiceLanguageInstruction('en'), '');
  assert.equal(voiceLanguageInstruction('fr'), '');
  assert.match(voiceLanguageInstruction('es'), /^LANGUAGE: .* Speak Spanish,/);
  assert.match(voiceLanguageInstruction('ru'), /Speak Russian,/);
});

test('a voice language is the canonical shipped code, as the app resolves ?lang=', () => {
  for (const value of ['zh-CN', 'zh-cn', 'ZH-CN', 'zh', 'zh_CN'])
    assert.equal(resolveVoiceLanguage(value), 'zh-CN', value);
  // Traditional Chinese readers are not given Simplified, as in locale.js.
  for (const value of ['zh-Hant', 'zh-TW', 'zh-HK'])
    assert.equal(resolveVoiceLanguage(value), null, value);
  assert.equal(resolveVoiceLanguage('es-MX'), 'es');
  assert.equal(resolveVoiceLanguage('en-GB'), null);
  assert.match(voiceLanguageInstruction('zh-CN'), /Speak Chinese/);
});

test('session instructions only gain a closing LANGUAGE line for a voice language', () => {
  const english = realtimeInstructions();
  assert.equal(realtimeInstructions(undefined, {}), english);
  assert.equal(realtimeInstructions(undefined, { language: 'en' }), english);
  assert.equal(realtimeInstructions(undefined, { language: 'fr' }), english);
  assert.doesNotMatch(english, /^LANGUAGE: /m);
  assert.equal(
    realtimeInstructions(undefined, { language: 'es' }),
    `${english}\n${voiceLanguageInstruction('es')}`,
  );
});

test('the token request names the interface language only when it is not English', async () => {
  const calls = [];
  const backend = createRealtimeBackend({
    tokenTransport: async (input) => {
      calls.push(input);
      return Response.json({
        value: 'ephemeral-test',
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
    },
  });
  for (const language of [undefined, 'en', 'fr', 'es'])
    await backend.requestToken({ language });
  assert.deepEqual(calls, [
    '/api/realtime/token?tier=standard',
    '/api/realtime/token?tier=standard',
    '/api/realtime/token?tier=standard',
    '/api/realtime/token?tier=standard&lang=es',
  ]);
});

function followUpResponses(locale, followUp = 'Say the result.') {
  const sent = [];
  const turns = new RealtimeTurns({
    readChannel: () => ({ readyState: 'open' }),
    radio: {},
    operations: {
      progressGenerating: () => false,
      sendRealtimeEvent: (event) => {
        sent.push(event);
        return true;
      },
    },
  });
  setLocale(locale);
  turns.queueResponseCreate(followUp);
  return sent.map((event) => event.response);
}

test('tool follow-ups keep the voice language, since they replace the session instructions', (t) => {
  t.after(() => setLocale('en'));
  assert.deepEqual(followUpResponses('en'), [
    { instructions: 'Say the result.' },
  ]);
  assert.deepEqual(followUpResponses('es'), [
    { instructions: `Say the result. ${voiceLanguageInstruction('es')}` },
  ]);
});

test('a follow-up that disables tools keeps that restriction in every language', (t) => {
  t.after(() => setLocale('en'));
  // Globe refusals queue a response object, not a string; the language line
  // joins its text and must not drop tool_choice.
  const refusal = { instructions: 'Ask for a reset.', tool_choice: 'none' };
  assert.deepEqual(followUpResponses('en', refusal), [refusal]);
  assert.deepEqual(followUpResponses('es', refusal), [
    {
      instructions: `Ask for a reset. ${voiceLanguageInstruction('es')}`,
      tool_choice: 'none',
    },
  ]);
});

test('progress lines are spoken in the interface language, and English is unchanged', (t) => {
  t.after(() => setLocale('en'));
  setLocale('en');
  assert.equal(progressLine('resolve', 'Austin'), 'Finding Austin on the map.');
  assert.equal(progressLine('resolve', ''), 'Finding those places.');
  assert.equal(progressLine('fly', 'Austin'), 'Heading to Austin.');
  assert.equal(progressLine('still', ''), 'Still working on it.');
  setLocale('es');
  assert.equal(
    progressLine('resolve', 'Austin'),
    'Buscando Austin en el mapa.',
  );
  assert.equal(progressLine('refresh'), 'Cargando las aeronaves de la zona.');
});
