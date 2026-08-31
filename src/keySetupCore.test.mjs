import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEY_SETUP_APPEND_HEADER,
  KEY_SETUP_KEYS,
  KEY_SETUP_VALUE_LIMIT,
  commandCompletedSuccessfully,
  isKeySetupExternallyManaged,
  keySetupStatus,
  knownKeySetupEnvVars,
  parseWindowsUserSid,
  upsertDotenvValues,
  validateKeySetupUpdates,
} from './keySetupCore.mjs';

test('the boot provenance snapshot survives in-process Vite config re-evaluation', () => {
  // server.restart() re-evaluates vite.config.js in the SAME process after a
  // panel save has already set its values live on process.env. A recomputed
  // snapshot would classify the panel's own keys as external (read-only) until
  // a full process relaunch, so the first evaluation's snapshot must win.
  const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /const PROVIDER_ENV_AT_BOOT = globalThis\.__GEV_PROVIDER_ENV_AT_BOOT \?\?= Object\.freeze\(/,
  );
});

test('external ownership uses boot provenance even when store and shell values match', () => {
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'same-value',
    storedValue: 'same-value',
    wasExternalAtBoot: true,
  }), true, 'equal bytes cannot turn a shell/Keychain value into a file-owned value');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'file-value',
    storedValue: 'file-value',
  }), false, 'a value loaded only from the owned store remains editable');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: 'shell-value',
    storedValue: 'stale-file-value',
  }), true, 'a differing live value remains external');
  assert.equal(isKeySetupExternallyManaged({
    effectiveValue: '',
    storedValue: 'stale-file-value',
    wasExternalAtBoot: true,
  }), false, 'an absent live credential has no external owner');
});

test('the status payload reports presence without any credential material', () => {
  const env = {
    GOOGLE_MAPS_API_KEY: 'AIzaSyFakeFakeFakeFake1234',
    OPENSKY_CLIENT_ID: 'client-id-abcdef',
    // Secret missing: the OpenSky pair must read as NOT set.
  };
  const status = keySetupStatus(env);
  assert.equal(status.total, KEY_SETUP_KEYS.length);
  const google = status.keys.find((key) => key.id === 'google-maps');
  assert.equal(google.set, true);
  const opensky = status.keys.find((key) => key.id === 'opensky');
  assert.equal(opensky.set, false, 'half a credential pair is not configured');
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('AIzaSyFakeFakeFakeFake1234'), 'a value leaked into status');
  assert.ok(!serialized.includes('client-id-abcdef'), 'a value leaked into status');
  assert.ok(!serialized.includes('1234'), 'a credential suffix leaked into status');
  assert.ok(!serialized.includes('abcdef'), 'a credential suffix leaked into status');
  assert.ok(!serialized.includes('tails'), 'status must not expose a credential-tail field');
  assert.equal(status.setCount, 1);
});

test('whitespace-only env values do not count as configured', () => {
  const status = keySetupStatus({ OPENAI_API_KEY: '   ' });
  assert.equal(status.keys.find((key) => key.id === 'openai').set, false);
});

test('subprocess success requires a clean zero exit', () => {
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: null }), true);
  assert.equal(commandCompletedSuccessfully({ status: 1, signal: null }), false);
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: 'SIGTERM' }), false);
  assert.equal(commandCompletedSuccessfully({ status: 0, signal: null, error: new Error('spawn failed') }), false);
  assert.equal(commandCompletedSuccessfully(null), false);
});

test('Windows owner SID parsing reads only the structured user-SID CSV field', () => {
  const localUser = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const entraUser = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}"\r\n`), localUser);
  assert.equal(parseWindowsUserSid(`"AzureAD\\alice","${entraUser}"`), entraUser);
  assert.equal(
    parseWindowsUserSid(`"${localUser}","S-1-5-32-545"`),
    null,
    'an SID-looking account name must never be mistaken for the token SID',
  );
  assert.equal(parseWindowsUserSid('"WORKSTATION\\alice","S-1-5-32-545"'), null, 'broad group SID refused');
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}"\n"extra","${localUser}"`), null);
  assert.equal(parseWindowsUserSid(`"WORKSTATION\\alice","${localUser}`), null, 'unterminated CSV refused');
});

test('validation accepts every registry env var and only those', () => {
  const known = knownKeySetupEnvVars();
  for (const name of known) {
    const verdict = validateKeySetupUpdates({ [name]: 'valid-value-123' });
    assert.equal(verdict.ok, true, `${name} should validate`);
    assert.equal(verdict.updates[name], 'valid-value-123');
  }
  assert.equal(validateKeySetupUpdates({ PATH: '/usr/bin' }).ok, false, 'PATH must be refused');
  assert.equal(validateKeySetupUpdates({ NODE_OPTIONS: '--x' }).ok, false, 'NODE_OPTIONS must be refused');
});

test('validation trims, and refuses empties, newlines, spaces, and oversize values', () => {
  const trimmed = validateKeySetupUpdates({ OPENAI_API_KEY: '  sk-abc123  ' });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.updates.OPENAI_API_KEY, 'sk-abc123');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '' }).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '   ' }).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'a\nb' }).ok, false, 'newline injection');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'a b' }).ok, false, 'inner space');
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 'kéy' }).ok, false, 'non-ASCII');
  assert.equal(
    validateKeySetupUpdates({ OPENAI_API_KEY: 'x'.repeat(KEY_SETUP_VALUE_LIMIT + 1) }).ok,
    false,
  );
  assert.equal(validateKeySetupUpdates(null).ok, false);
  assert.equal(validateKeySetupUpdates([]).ok, false);
  assert.equal(validateKeySetupUpdates({}).ok, false);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: 42 }).ok, false);
});

test('upsert replaces the last active assignment in place', () => {
  const text = [
    '# comment stays',
    'OPENAI_API_KEY=old-one',
    'PORT=4173',
    'OPENAI_API_KEY=old-two',
    '',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: 'new-key' });
  assert.equal(next, [
    '# comment stays',
    'OPENAI_API_KEY=old-one',
    'PORT=4173',
    'OPENAI_API_KEY=new-key',
    '',
  ].join('\n'));
});

test('upsert uncomments a commented assignment in place, keeping file shape', () => {
  const text = [
    '# Optional: NASA FIRMS live active fires.',
    '# FIRMS_MAP_KEY=',
    '',
    'PORT=4173',
  ].join('\n');
  const next = upsertDotenvValues(text, { FIRMS_MAP_KEY: 'firms-123' });
  assert.equal(next, [
    '# Optional: NASA FIRMS live active fires.',
    'FIRMS_MAP_KEY=firms-123',
    '',
    'PORT=4173',
  ].join('\n') + '\n');
});

test('upsert appends unknown keys under one shared header, once', () => {
  const first = upsertDotenvValues('PORT=4173\n', { OPENAI_API_KEY: 'sk-1' });
  assert.equal(first, [
    'PORT=4173',
    '',
    KEY_SETUP_APPEND_HEADER,
    'OPENAI_API_KEY=sk-1',
  ].join('\n') + '\n');
  const second = upsertDotenvValues(first, { FIRMS_MAP_KEY: 'f-2' });
  assert.equal(second, [
    'PORT=4173',
    '',
    KEY_SETUP_APPEND_HEADER,
    'OPENAI_API_KEY=sk-1',
    'FIRMS_MAP_KEY=f-2',
  ].join('\n') + '\n');
  assert.equal(second.split(KEY_SETUP_APPEND_HEADER).length, 2, 'header written once');
});

test('upsert births a well-formed file from nothing', () => {
  const next = upsertDotenvValues('', { GOOGLE_MAPS_API_KEY: 'AIza-x' });
  assert.equal(next, `${KEY_SETUP_APPEND_HEADER}\nGOOGLE_MAPS_API_KEY=AIza-x\n`);
});

test('upsert handles export-prefixed lines and never touches lookalike keys', () => {
  const text = [
    'export OPENAI_API_KEY=old',
    'NOT_OPENAI_API_KEY=keep-me',
    'OPENAI_API_KEY_MINI=keep-me-too',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: 'new' });
  const lines = next.split('\n');
  assert.equal(lines[0], 'OPENAI_API_KEY=new');
  assert.equal(lines[1], 'NOT_OPENAI_API_KEY=keep-me');
  assert.equal(lines[2], 'OPENAI_API_KEY_MINI=keep-me-too');
});

test('upsert is idempotent for a repeated save', () => {
  const once = upsertDotenvValues('', { OPENAI_API_KEY: 'sk-1', FIRMS_MAP_KEY: 'f-1' });
  const twice = upsertDotenvValues(once, { OPENAI_API_KEY: 'sk-1', FIRMS_MAP_KEY: 'f-1' });
  assert.equal(once, twice);
});

test('a real .env.example round-trip: the curated file keeps its shape', () => {
  // A representative slice of the shipped .env.example.
  const example = [
    '# God\'s Eye View — environment variables',
    'GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here',
    '',
    '# Optional: OpenAI Realtime voice control. Do not prefix with VITE_.',
    'OPENAI_API_KEY=',
    'OPENAI_REALTIME_MODEL=gpt-realtime-2',
    '',
    '# TOMTOM_API_KEY=',
  ].join('\n');
  const next = upsertDotenvValues(example, {
    GOOGLE_MAPS_API_KEY: 'AIza-real',
    OPENAI_API_KEY: 'sk-real',
    TOMTOM_API_KEY: 'tt-real',
  });
  const lines = next.split('\n');
  assert.equal(lines[1], 'GOOGLE_MAPS_API_KEY=AIza-real');
  assert.equal(lines[4], 'OPENAI_API_KEY=sk-real');
  assert.equal(lines[5], 'OPENAI_REALTIME_MODEL=gpt-realtime-2', 'sibling key untouched');
  assert.equal(lines[7], 'TOMTOM_API_KEY=tt-real', 'commented key uncommented in place');
});

test('the admission gate refuses every non-local shape, one assertion per refusal', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const local = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
    env: {},
  };
  assert.equal(admitKeySetupRequest(local).ok, true, 'the honest local request is admitted');
  assert.equal(admitKeySetupRequest({ ...local, method: 'GET', contentType: undefined }).ok, true, 'local GET needs no content type');
  assert.equal(admitKeySetupRequest({ ...local, origin: undefined }).ok, false, 'POST without Origin is refused');
  assert.equal(admitKeySetupRequest({ ...local, method: 'GET', origin: undefined, contentType: undefined }).ok, true, 'local GET may omit Origin');
  assert.equal(admitKeySetupRequest({ ...local, remoteAddress: '::ffff:127.0.0.1', hostHeader: '[::1]:4173', origin: 'http://[::1]:4173' }).ok, true, 'IPv6 loopback forms are local');

  // Tunnel/LAN sharing of any kind removes the surface outright — tunnel
  // traffic arrives FROM loopback, so no socket check can carry this boundary.
  assert.equal(admitKeySetupRequest({ ...local, env: { PINOKIO_SHARE_CLOUDFLARE: 'true' } }).ok, false, 'sharing disables the surface');
  assert.equal(admitKeySetupRequest({ ...local, env: { PINOKIO_SHARE_LOCAL: '1' } }).ok, false, 'LAN sharing disables the surface');
  // A LAN peer reaching a wide-bound server.
  assert.equal(admitKeySetupRequest({ ...local, remoteAddress: '192.168.1.20' }).ok, false, 'non-loopback socket refused');
  // Tunnel and DNS-rebinding traffic carries a foreign Host over a loopback socket.
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: 'abc.trycloudflare.com' }).ok, false, 'foreign Host refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: 'workstation.local:4173' }).ok, false, 'non-localhost hostnames refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: '' }).ok, false, 'missing Host refused');
  assert.equal(admitKeySetupRequest({ ...local, hostHeader: '[::1].evil:4173' }).ok, false, 'malformed bracketed Host refused');
  // A hostile web page POSTing at localhost carries its own Origin.
  assert.equal(admitKeySetupRequest({ ...local, origin: 'https://evil.example' }).ok, false, 'cross-origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'not a url' }).ok, false, 'unparseable Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'http://localhost:4174' }).ok, false, 'cross-port Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'https://localhost:4173' }).ok, false, 'cross-scheme Origin refused');
  assert.equal(admitKeySetupRequest({ ...local, origin: 'http://127.0.0.1:4173' }).ok, false, 'different loopback host Origin refused');
  // A simple-request POST (no JSON content type) is the CSRF write shape.
  const noJson = admitKeySetupRequest({ ...local, contentType: 'text/plain' });
  assert.equal(noJson.ok, false, 'non-JSON POST refused');
  assert.equal(noJson.status, 415);
});

test('a null value validates as a removal; an empty string still does not', () => {
  const removal = validateKeySetupUpdates({ OPENAI_API_KEY: null });
  assert.equal(removal.ok, true);
  assert.equal(removal.updates.OPENAI_API_KEY, null);
  assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: '' }).ok, false, 'empty is a mistake, not a removal');
  assert.equal(validateKeySetupUpdates({ PATH: null }).ok, false, 'removal is registry-bound too');
});

test('removal comments the assignment back out, returning the file to template shape', () => {
  const text = [
    '# Optional: OpenAI Realtime voice control.',
    'OPENAI_API_KEY=sk-live',
    'PORT=4173',
  ].join('\n');
  const next = upsertDotenvValues(text, { OPENAI_API_KEY: null });
  const lines = next.split('\n');
  assert.equal(lines[1], '# OPENAI_API_KEY=', 'active line commented out, not deleted');
  assert.equal(lines[2], 'PORT=4173', 'neighbors untouched');
  // Removing a key with no active assignment changes nothing.
  assert.equal(upsertDotenvValues(next, { FIRMS_MAP_KEY: null }), next);
  // The commented-out line is reusable: a later save uncomments it in place.
  const again = upsertDotenvValues(next, { OPENAI_API_KEY: 'sk-new' });
  assert.equal(again.split('\n')[1], 'OPENAI_API_KEY=sk-new');
});

test('the sharing gate treats a real PINOKIO_SHARE_VAR as sharing, but not the empty/sentinel normal state', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json',
  };
  // The ordinary launch states: unset, empty, or the explicit disabled sentinel.
  assert.equal(admitKeySetupRequest({ ...base, env: {} }).ok, true, 'unset SHARE_VAR is normal');
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: '' } }).ok, true, 'empty SHARE_VAR is normal');
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: '__gev_sharing_disabled__' } }).ok, true, 'the disabled sentinel is normal');
  // A real tunnel var disables the surface.
  assert.equal(admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: 'MY_TUNNEL_TOKEN' } }).ok, false, 'a real share var is sharing');
});

test('the gate refuses proxied requests even from a loopback socket with local headers', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST', remoteAddress: '127.0.0.1', hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173', contentType: 'application/json', env: {},
  };
  assert.equal(admitKeySetupRequest(base).ok, true, 'no proxy headers → admitted');
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
    assert.equal(
      admitKeySetupRequest({ ...base, proxyHeaders: { [header]: 'anything' } }).ok,
      false,
      `${header} present → refused`,
    );
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(admitKeySetupRequest({ ...base, proxyHeaders: { 'x-forwarded-for': '' } }).ok, true);
});

test('validation rejects dotenv metacharacters that would round-trip wrong', () => {
  for (const bad of ['abc#def', 'ab"cd', "ab'cd", 'ab$cd', 'ab\\cd', 'ab`cd']) {
    assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: bad }).ok, false, `${JSON.stringify(bad)} refused`);
  }
  // Real key alphabets still pass: base64url, JWT dots, hex, plus/slash.
  for (const good of ['sk-AbC0-9_x', 'eyJhbGc.eyJzdWI.QWxpY2U', 'a1b2c3d4e5f6', 'AB+cd/ef=']) {
    assert.equal(validateKeySetupUpdates({ OPENAI_API_KEY: good }).ok, true, `${good} accepted`);
  }
});
