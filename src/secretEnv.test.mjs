import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENV_TEMPLATE_FENCES,
  SECRET_ENV_NAMES,
  envAssignmentNames,
  envFilesFromTemplate,
  isSecretEnvName,
  planSecretMigration,
  removeEnvAssignments,
  splitEnvTemplate,
} from './secretEnv.mjs';
import { knownKeySetupEnvVars } from './keySetupCore.mjs';
import { CREDENTIALS } from '../scripts/setup-doctor.mjs';

const template = readFileSync(
  fileURLToPath(new URL('../.env.example', import.meta.url)),
  'utf8',
);
// Names shaped like a credential. A settings name matching this fails the test:
// either it belongs in SECRET_ENV_NAMES and SECTION 1, or the pattern needs a
// deliberate exception here. TOKEN/SECRET/PASSWORD count anywhere in the name
// (AWS_BEARER_TOKEN_BEDROCK); a path to one (_FILE, _DIR, _PATH, _URL) is a
// setting.
const CREDENTIAL_SHAPED =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CERTIFICATE)$|_CLIENT_ID$|(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD)_(?!(?:.*_)?(?:FILE|DIR|PATH|URL)$)/;
const isCredentialShaped = (name) => CREDENTIAL_SHAPED.test(name);
const ADD_A_KEY =
  'A new API key goes in .env.example SECTION 1 (with a "# Get one: <url>" ' +
  'line), in SECRET_ENV_NAMES in src/secretEnv.mjs, and as a commented ' +
  'placeholder in pinokio/_ENVIRONMENT.';

test('credential-shaped names: keys anywhere in the name, never paths to them', () => {
  for (const name of [
    'OPENAI_API_KEY', 'GITHUB_TOKEN', 'OPENSKY_CLIENT_SECRET',
    'OPENSKY_CLIENT_ID', 'OTTAWA_CAMERA_CERTIFICATE', 'AWS_BEARER_TOKEN_BEDROCK',
    'SMTP_PASSWORD_PRIMARY',
  ]) assert.equal(isCredentialShaped(name), true, name);
  for (const name of [
    'HTTPS_KEY_FILE', 'WORLD_MONITOR_LOCAL_TOKEN_FILE', 'GEV_CHATGPT_AUTH_DIR',
    'GEV_KEY_SETUP_TRUSTED_PEERS', 'TOMTOM_DAILY_TILE_BUDGET', 'PORT',
  ]) assert.equal(isCredentialShaped(name), false, name);
});

test('the secret list is unique, upper-case env names', () => {
  assert.equal(new Set(SECRET_ENV_NAMES).size, SECRET_ENV_NAMES.length);
  for (const name of SECRET_ENV_NAMES) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
  assert.equal(isSecretEnvName('OPENAI_API_KEY'), true);
  assert.equal(isSecretEnvName('PORT'), false);
});

test('.env.example SECTION 1 holds exactly the secret list', () => {
  const { secrets } = splitEnvTemplate(template);
  assert.deepEqual(
    [...envAssignmentNames(secrets.join('\n'))].sort(),
    [...SECRET_ENV_NAMES].sort(),
    ADD_A_KEY,
  );
});

test('no secret, and nothing credential-shaped, outside SECTION 1', () => {
  const { header, settings, trailer } = splitEnvTemplate(template);
  const outside = envAssignmentNames(
    [...header, ...settings, ...trailer].join('\n'),
  );
  assert.deepEqual(outside.filter(isSecretEnvName), [], ADD_A_KEY);
  assert.deepEqual(
    outside.filter(isCredentialShaped),
    [],
    `Key-looking names outside SECTION 1. ${ADD_A_KEY} A setting that only ` +
      'looks like a key needs an exception in CREDENTIAL_SHAPED.',
  );
});

test('every SECTION 1 entry says where to get it', () => {
  const { secrets } = splitEnvTemplate(template);
  const missing = [];
  let block = [];
  for (const line of secrets) {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match) {
      // A sibling assignment (OPENSKY_CLIENT_SECRET) shares the block above it.
      const text = `${block.join(' ')} ${match[2]}`;
      if (!/https:\/\/|\b[a-z0-9-]+\.(?:com|org|io|gov|ca|uk)\b/i.test(text))
        missing.push(match[1]);
      continue;
    }
    if (line.trim() === '') block = [];
    else if (line.startsWith('#')) block.push(line);
  }
  assert.deepEqual(missing, []);
});

test('Provider Settings only writes names on the secret list', () => {
  assert.deepEqual(
    [...knownKeySetupEnvVars()].filter((name) => !isSecretEnvName(name)),
    [],
  );
});

test('every setup-doctor credential is on the secret list', () => {
  assert.deepEqual(
    CREDENTIALS.map((c) => c.name).filter((name) => !isSecretEnvName(name)),
    [],
  );
});

test('splitEnvTemplate refuses a missing, repeated or misordered fence', () => {
  const { secrets: s, settings: g } = ENV_TEMPLATE_FENCES;
  const good = [
    '# head',
    s.open,
    'A_KEY=',
    s.close,
    '',
    g.open,
    'PORT=1',
    g.close,
  ];
  assert.deepEqual(splitEnvTemplate(good.join('\n')).secrets, [
    s.open,
    'A_KEY=',
    s.close,
  ]);
  assert.deepEqual(splitEnvTemplate(good.join('\r\n')).settings, [
    g.open,
    'PORT=1',
    g.close,
  ]);
  assert.throws(
    () => splitEnvTemplate(good.filter((l) => l !== s.close).join('\n')),
    /exactly one/,
  );
  assert.throws(
    () => splitEnvTemplate([...good, g.open].join('\n')),
    /exactly one/,
  );
  assert.throws(
    () =>
      splitEnvTemplate(
        [g.open, 'PORT=1', g.close, s.open, 'A_KEY=', s.close].join('\n'),
      ),
    /out of order/,
  );
});

test('envAssignmentNames reads active and commented assignments, not prose', () => {
  const text = [
    'A_KEY=1',
    '# B_TOKEN=',
    '  #  C_SECRET = x',
    '# set HOST=0.0.0.0 to share',
    'A_KEY=2',
  ].join('\n');
  assert.deepEqual(envAssignmentNames(text), ['A_KEY', 'B_TOKEN', 'C_SECRET']);
});

test('envFilesFromTemplate puts every secret in the secrets file and none in settings', () => {
  const files = envFilesFromTemplate(template);
  assert.deepEqual(
    [...envAssignmentNames(files.secrets)].sort(),
    [...SECRET_ENV_NAMES].sort(),
  );
  assert.deepEqual(
    envAssignmentNames(files.settings).filter(isSecretEnvName),
    [],
  );
  assert.ok(files.secrets.startsWith(ENV_TEMPLATE_FENCES.secrets.open));
  assert.ok(files.settings.startsWith(ENV_TEMPLATE_FENCES.settings.open));
});

test('planSecretMigration moves secrets, keeps settings, never leaves a value behind', () => {
  const env = [
    '# settings',
    'PORT=4173',
    'OPENAI_API_KEY=sk-live',
    '# TOMTOM_API_KEY=tt-old',
    '# FIRMS_MAP_KEY=',
    '# ONTARIO_511_API_KEY=                     # free developer key: 511on.ca',
    'GEV_RATELIMIT_GOOGLE_PER_MIN=60',
    '',
  ].join('\n');
  const plan = planSecretMigration(env, '');
  assert.equal(
    plan.env,
    ['# settings', 'PORT=4173', 'GEV_RATELIMIT_GOOGLE_PER_MIN=60', ''].join(
      '\n',
    ),
  );
  assert.deepEqual(plan.moved, ['OPENAI_API_KEY', 'TOMTOM_API_KEY']);
  assert.deepEqual(plan.dropped, ['FIRMS_MAP_KEY', 'ONTARIO_511_API_KEY']);
  assert.match(plan.local, /^OPENAI_API_KEY=sk-live$/m);
  assert.match(plan.local, /^# TOMTOM_API_KEY=tt-old$/m);
  assert.match(
    plan.local,
    /^# FIRMS_MAP_KEY=$/m,
    'a name the secrets file lacks keeps its placeholder',
  );
  assert.doesNotMatch(plan.env, /sk-live|tt-old/);
  assert.equal(plan.changed, true);
  assert.equal(plan.localChanged, true);
});

test('planSecretMigration puts a value in its placeholder line, in place', () => {
  const local = [
    '# keys',
    'GOOGLE_MAPS_API_KEY=',
    '# Get one: https://example.test',
    '# CESIUM_ION_TOKEN=',
    'AISSTREAM_API_KEY=',
    '',
  ].join('\n');
  const env = [
    'GOOGLE_MAPS_API_KEY=g-1',
    '# CESIUM_ION_TOKEN=c-old',
    'PORT=1',
    '',
  ].join('\n');
  const plan = planSecretMigration(env, local);
  assert.equal(
    plan.local,
    [
      '# keys',
      'GOOGLE_MAPS_API_KEY=g-1',
      '# Get one: https://example.test',
      '# CESIUM_ION_TOKEN=c-old',
      'AISSTREAM_API_KEY=',
      '',
    ].join('\n'),
  );
  assert.equal(plan.env, 'PORT=1\n');
  assert.deepEqual(plan.moved, ['GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN']);
});

test('planSecretMigration: a blank never replaces a value; blank placeholders just leave .env', () => {
  const env = [
    'GOOGLE_MAPS_API_KEY=',
    'CESIUM_ION_TOKEN=   # from the old template',
    'AISSTREAM_API_KEY=""',
    'PORT=1',
    '',
  ].join('\n');
  const local =
    'GOOGLE_MAPS_API_KEY=\n# CESIUM_ION_TOKEN=\nAISSTREAM_API_KEY=a-live\n';
  const plan = planSecretMigration(env, local);
  assert.deepEqual(plan.dropped, [
    'GOOGLE_MAPS_API_KEY',
    'CESIUM_ION_TOKEN',
    'AISSTREAM_API_KEY',
  ]);
  assert.deepEqual(plan.moved, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.local, local);
  assert.equal(plan.localChanged, false);
  assert.equal(plan.env, 'PORT=1\n');
});

test('planSecretMigration: the same value just leaves .env; a different one stays live in .env.local and the .env one is kept beneath it as a comment', () => {
  const env = 'GEMINI_API_KEY="g-1"\nAISSTREAM_API_KEY=a-old\nPORT=1\n';
  const local =
    'GEMINI_API_KEY=g-1 # set by hand\nAISSTREAM_API_KEY=a-new\nLL2_API_TOKEN=\n';
  const plan = planSecretMigration(env, local);
  assert.deepEqual(plan.alreadyThere, ['GEMINI_API_KEY']);
  assert.deepEqual(plan.conflicts, ['AISSTREAM_API_KEY']);
  assert.deepEqual(plan.moved, []);
  assert.equal(plan.env, 'PORT=1\n');
  const lines = plan.local.split('\n');
  const liveAt = lines.indexOf('AISSTREAM_API_KEY=a-new');
  assert.ok(liveAt >= 0);
  assert.match(lines[liveAt + 1], /^# env:init: /);
  assert.equal(lines[liveAt + 2], '# AISSTREAM_API_KEY=a-old');
  assert.equal(lines.at(-2), 'LL2_API_TOKEN=');
});

test('planSecretMigration moves a multi-line quoted value whole and keeps CRLF', () => {
  const env = [
    'PORT=1',
    'OTTAWA_CAMERA_CERTIFICATE="line one',
    'line two"',
    'HOST=x',
    '',
  ].join('\r\n');
  const plan = planSecretMigration(env, '');
  assert.equal(plan.env, ['PORT=1', 'HOST=x', ''].join('\r\n'));
  assert.ok(
    plan.local.includes('OTTAWA_CAMERA_CERTIFICATE="line one\r\nline two"'),
  );
  assert.deepEqual(plan.moved, ['OTTAWA_CAMERA_CERTIFICATE']);
});


test('planSecretMigration preserves the last credential assignment from .env', () => {
  const env = [
    'OPENAI_API_KEY=sk-obsolete',
    'AISSTREAM_API_KEY=ais-kept',
    'OPENAI_API_KEY=sk-current',
    'PORT=1',
    '',
  ].join('\n');
  const plan = planSecretMigration(
    env,
    'OPENAI_API_KEY=\nAISSTREAM_API_KEY=\n',
  );
  assert.equal(plan.env, 'PORT=1\n');
  assert.deepEqual(plan.moved, ['OPENAI_API_KEY', 'AISSTREAM_API_KEY']);
  assert.deepEqual(plan.conflicts, ['OPENAI_API_KEY']);
  assert.match(plan.local, /^OPENAI_API_KEY=sk-current$/m);
  assert.match(plan.local, /^AISSTREAM_API_KEY=ais-kept$/m);
  assert.match(plan.local, /^# OPENAI_API_KEY=sk-obsolete$/m);
  assert.doesNotMatch(plan.local, /^OPENAI_API_KEY=sk-obsolete$/m);

  const rerun = planSecretMigration(plan.env, plan.local);
  assert.equal(rerun.local, plan.local);
  assert.equal(rerun.localChanged, false);
});

test('planSecretMigration leaves a file with no secrets byte-identical', () => {
  const env = '# only settings\nPORT=4173\nHOST=localhost\n';
  const plan = planSecretMigration(env, '');
  assert.equal(plan.env, env);
  assert.equal(plan.changed, false);
  assert.equal(plan.local, '');
  assert.equal(plan.localChanged, false);
});

test('removeEnvAssignments deletes active, commented, exported and multi-line entries of the names only', () => {
  const text = [
    'PORT=1',
    'OPENAI_API_KEY=sk-a',
    '# OPENAI_API_KEY=sk-b',
    'export GEMINI_API_KEY=g',
    'OTTAWA_CAMERA_CERTIFICATE="one',
    'two"',
    'TOMTOM_API_KEY=keep',
    '',
  ].join('\n');
  const out = removeEnvAssignments(text, [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OTTAWA_CAMERA_CERTIFICATE',
  ]);
  assert.equal(out.text, 'PORT=1\nTOMTOM_API_KEY=keep\n');
  assert.deepEqual(out.removed, [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OTTAWA_CAMERA_CERTIFICATE',
  ]);
  assert.equal(out.changed, true);
  const none = removeEnvAssignments('PORT=1\r\n', ['OPENAI_API_KEY']);
  assert.deepEqual(none, { text: 'PORT=1\r\n', removed: [], changed: false });
});

test('an exported secret in .env is migrated too', () => {
  const plan = planSecretMigration('export OPENAI_API_KEY=sk-x\nPORT=1\n', '');
  assert.deepEqual(plan.moved, ['OPENAI_API_KEY']);
  assert.equal(plan.env, 'PORT=1\n');
});
