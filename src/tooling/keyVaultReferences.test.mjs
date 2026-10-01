import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUnresolvedKeyVaultReference,
  scrubUnresolvedKeyVaultReferences,
} from '../../scripts/secret-env.mjs';
import { resolveGoogleServerKey } from '../../scripts/google-server-key.mjs';
import standaloneConfig from '../../server/standalone/vite.config.js';

// T3 (LOW-3): when App Service cannot resolve a Key Vault reference it hands
// the app the literal "@Microsoft.KeyVault(...)" string. That must read as
// "no key configured", never be sent upstream as if it were a key.

const REF = '@Microsoft.KeyVault(VaultName=kv-gev;SecretName=openai-api-key)';

test('T3: an unresolved Key Vault reference is recognised, a real value is not', () => {
  assert.equal(isUnresolvedKeyVaultReference(REF), true);
  assert.equal(isUnresolvedKeyVaultReference(`  ${REF}`), true);
  assert.equal(isUnresolvedKeyVaultReference('sk-real-looking-key'), false);
  assert.equal(isUnresolvedKeyVaultReference(''), false);
  assert.equal(isUnresolvedKeyVaultReference(undefined), false);
});

test('T3: scrubbing unsets unresolved references and warns once per name', () => {
  const env = {
    OPENAI_API_KEY: REF,
    TOMTOM_API_KEY: 'tomtom-real',
    FIRMS_MAP_KEY: REF.replace('openai-api-key', 'firms-map-key'),
  };
  const warnings = [];
  const warn = (message) => warnings.push(message);
  scrubUnresolvedKeyVaultReferences(env, warn);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('FIRMS_MAP_KEY' in env, false);
  assert.equal(env.TOMTOM_API_KEY, 'tomtom-real');
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /OPENAI_API_KEY/);

  env.OPENAI_API_KEY = REF;
  scrubUnresolvedKeyVaultReferences(env, warn);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal(warnings.length, 2, 'one warning per name, not per scrub');
});

test('T3: the Google server key skips an unresolved reference', () => {
  assert.equal(
    resolveGoogleServerKey({
      GOOGLE_MAPS_SERVER_API_KEY: REF,
      GOOGLE_MAPS_API_KEY: 'browser-key',
    }),
    'browser-key',
  );
  assert.equal(resolveGoogleServerKey({ GOOGLE_MAPS_API_KEY: REF }), '');
});

test('T3: the standalone server treats unresolved references as unset', (t) => {
  for (const name of ['OPENAI_API_KEY', 'AISSTREAM_API_KEY']) {
    const before = process.env[name];
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  process.env.OPENAI_API_KEY = REF;
  process.env.AISSTREAM_API_KEY = 'ais-real';
  standaloneConfig({ command: 'serve', mode: 'test' });
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.AISSTREAM_API_KEY, 'ais-real');
});
