import test from 'node:test';
import { consoleTextParts } from './agentConsole.js';
import assert from 'node:assert/strict';
import commandAr from '../i18n/supplements/command-ar.json' with { type: 'json' };
import { getCatalog, setLocale, t } from '../i18n/index.js';
import { normalizeLocale } from '../i18n/locale.js';
import { extractMessages } from '../../scripts/i18n.mjs';

test('COMMAND Arabic supplement has translated messages with exact placeholders', () => {
  const messages = extractMessages();
  assert.equal(Object.keys(commandAr).length, 32);
  for (const [key, value] of Object.entries(commandAr)) {
    assert.ok(messages.has(key), `stale Arabic COMMAND key: ${key}`);
    assert.match(value, /[\u0600-\u06ff]/, key);
    assert.deepEqual(
      value.match(/\{\w+\}/g) ?? [],
      key.match(/\{\w+\}/g) ?? [],
    );
  }
});

test('Arabic extension activates only with the independently owned Arabic locale', () => {
  if (!normalizeLocale('ar')) {
    assert.equal(getCatalog('ar'), null);
    return;
  }
  setLocale('ar');
  try {
    for (const [key, value] of Object.entries(commandAr))
      assert.equal(getCatalog('ar')[key], value);
    assert.equal(
      t('set {envVar}', { envVar: 'OPENAI_API_KEY' }),
      'اضبط \u2068OPENAI_API_KEY\u2069',
    );
  } finally {
    setLocale('en');
  }
  assert.equal(t('Continue with ChatGPT'), 'Continue with ChatGPT');
});

test('mixed Arabic transcript isolates coordinates and codes without rewriting their data', () => {
  const text = 'تم الانتقال إلى ABC-123 عند (-27.367, -55.896) باتجاه HDG 68°';
  const parts = consoleTextParts(text);
  assert.equal(parts.map((p) => p.text).join(''), text);
  assert.deepEqual(
    parts.filter((p) => p.ltr).map((p) => p.text),
    ['ABC-123', '(-27.367, -55.896)', 'HDG 68°'],
  );
  assert.deepEqual(consoleTextParts('fly to ABC-123 (-27.367, -55.896)'), [
    { text: 'fly to ABC-123 (-27.367, -55.896)', ltr: false },
  ]);
});
