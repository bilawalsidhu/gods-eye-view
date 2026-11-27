import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const NEW_KEYS = ['OPENAQ_API_KEY'];

test('dev-fresh reports shell-supplied air-quality keys as external', () => {
  const script = readFileSync(
    new URL('../scripts/dev-fresh.sh', import.meta.url),
    'utf8',
  );
  for (const name of NEW_KEYS) {
    assert.match(
      script,
      new RegExp(`KEY_SETUP_EXTERNAL_KEYS\\+=\\(${name}\\)`),
      `${name} missing from dev-fresh external-key tracking`,
    );
  }
});
