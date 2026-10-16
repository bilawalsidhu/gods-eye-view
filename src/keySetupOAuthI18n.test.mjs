// Every status line of the ChatGPT OAuth flow in Provider Settings goes
// through t(), and the i18n check treats say() as a place UI text lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractMessages,
  readCatalog,
  shippedLocales,
  unmarkedScript,
} from '../scripts/i18n.mjs';

// Status-line texts of the ChatGPT OAuth flow in Provider Settings
// (src/keySetup.js, handler of [data-cloud-voice-auth-toggle]).
const OAUTH_STATUS_TEXTS = [
  'Cloud voice will use OPENAI_API_KEY on the next session.',
  'Checking local ChatGPT OAuth sign-in…',
  'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
  'ChatGPT sign-in expired. Opening sign-in again…',
  'Opening ChatGPT sign-in in your browser…',
  'Finish ChatGPT sign-in in the browser. Waiting for it to complete…',
  'ChatGPT sign-in timed out. Click {button} to try again.',
  'OAuth check failed: {detail}',
  'Could not check ChatGPT sign-in.',
  'Could not check ChatGPT sign-in. Try again.',
  'Could not start ChatGPT sign-in on this machine.',
  'ChatGPT sign-in complete. OAuth will be used for the next cloud voice session.',
];

test('OAuth status-line texts are extractable messages with es/ru entries', () => {
  const messages = extractMessages();
  const missing = OAUTH_STATUS_TEXTS.filter((text) => !messages.has(text));
  assert.deepEqual(missing, [], 'texts not wrapped in t() in src/keySetup.js');
  for (const locale of shippedLocales()) {
    const catalog = readCatalog(locale);
    const untranslated = OAUTH_STATUS_TEXTS.filter((text) => !catalog[text]);
    assert.deepEqual(untranslated, [], `${locale}.json lacks entries`);
  }
});

test('the i18n check sees an unmarked literal passed to say()', () => {
  const sample =
    "const say = (x) => { el.textContent = x; };\nsay('Checking local ChatGPT OAuth sign-in…');\n";
  const found = unmarkedScript('sample.js', sample);
  assert.ok(
    found.some((f) => f.text.includes('Checking local ChatGPT OAuth')),
    'say(...) is not among JS_SINKS in scripts/i18n.mjs',
  );
});

test('src/keySetup.js has no unmarked say() literals', () => {
  const source = readFileSync(
    new URL('./keySetup.js', import.meta.url),
    'utf8',
  );
  const literal = /\bsay\(\s*['"`]/g;
  const hits = [...source.matchAll(literal)].map(
    (m) => source.slice(0, m.index).split('\n').length,
  );
  assert.deepEqual(
    hits,
    [],
    `say() called with a bare literal at lines ${hits.join(', ')}`,
  );
});
