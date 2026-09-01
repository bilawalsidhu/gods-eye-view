import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import {
  applyPinokioEnvironment,
  readPinokioEnvironment,
} from '../scripts/pinokio-environment.mjs';

function encodeUtf16be(source) {
  const buffer = Buffer.from(source, 'utf16le');
  for (let index = 0; index < buffer.length; index += 2) {
    [buffer[index], buffer[index + 1]] = [buffer[index + 1], buffer[index]];
  }
  return buffer;
}

const PROVIDER_FIELDS = [
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENAI_API_KEY',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'LL2_API_TOKEN',
];

test('the fresh template keeps provider credentials out of native Configure', () => {
  const source = readFileSync(new URL('../pinokio/_ENVIRONMENT', import.meta.url), 'utf8');
  const configured = parseEnv(source);

  for (const field of PROVIDER_FIELDS) {
    assert.equal(field in configured, false, `${field} must not be an active assignment`);
    assert.match(source, new RegExp(`^# ${field}=$`, 'm'));
  }
  assert.equal(configured.PINOKIO_SHARE_CLOUDFLARE, 'false');
  assert.equal(configured.PINOKIO_SHARE_LOCAL, 'false');
  assert.equal(configured.PINOKIO_SHARE_VAR, '__gev_sharing_disabled__');
  assert.equal(configured.GEV_RATELIMIT_OPENAI_PER_MIN, '30');
  assert.equal(configured.GEV_RATELIMIT_GOOGLE_PER_MIN, '120');
  assert.match(source, /Do not enter credentials in Pinokio 8\.0\.40's native Configure panel/);
  assert.match(source, /trusted local text editor/);
  assert.match(source, /Stop and Start the app/);
});

test('raw app-file values override Pinokio-global values, including blanks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-env-'));
  try {
    const filepath = path.join(root, 'ENVIRONMENT');
    writeFileSync(filepath, [
      'GOOGLE_MAPS_API_KEY=app-configured',
      'OPENAI_API_KEY=',
      'GEV_RATELIMIT_OPENAI_PER_MIN=45',
      'GEV_RATELIMIT_GOOGLE_PER_MIN=',
      'PINOKIO_SHARE_CLOUDFLARE=false',
      'PINOKIO_SHARE_LOCAL=false',
      'PINOKIO_SHARE_VAR=__gev_sharing_disabled__',
      '',
    ].join('\n'));
    const environment = {
      GOOGLE_MAPS_API_KEY: 'global-google',
      CESIUM_ION_TOKEN: 'global-ion',
      OPENAI_API_KEY: 'global-openai',
      GEV_RATELIMIT_OPENAI_PER_MIN: '999',
      GEV_RATELIMIT_GOOGLE_PER_MIN: '999',
      PINOKIO_SHARE_CLOUDFLARE: 'true',
      PINOKIO_SHARE_LOCAL: 'true',
      PINOKIO_SHARE_PASSCODE: 'global-passcode',
    };

    applyPinokioEnvironment({ environment, filepath });

    assert.equal(environment.GOOGLE_MAPS_API_KEY, 'app-configured');
    assert.equal(environment.CESIUM_ION_TOKEN, '');
    assert.equal(environment.OPENAI_API_KEY, '');
    assert.equal(environment.GEV_RATELIMIT_OPENAI_PER_MIN, '45');
    assert.equal(environment.GEV_RATELIMIT_GOOGLE_PER_MIN, '');
    assert.equal(environment.PINOKIO_SHARE_CLOUDFLARE, 'false');
    assert.equal(environment.PINOKIO_SHARE_LOCAL, 'false');
    assert.equal(environment.PINOKIO_SHARE_VAR, '__gev_sharing_disabled__');
    assert.equal(environment.PINOKIO_SHARE_PASSCODE, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing Pinokio file gains the canonical non-secret sharing boundary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-env-legacy-'));
  try {
    const filepath = path.join(root, 'ENVIRONMENT');
    writeFileSync(filepath, 'OPENAI_API_KEY=app-value\nPINOKIO_SHARE_CLOUDFLARE=false\n');
    const environment = {
      GOOGLE_MAPS_API_KEY: 'global-google',
      GEV_RATELIMIT_OPENAI_PER_MIN: '999',
      GEV_RATELIMIT_GOOGLE_PER_MIN: '999',
      PINOKIO_SHARE_LOCAL: 'true',
      PINOKIO_SHARE_VAR: 'url',
      PINOKIO_SHARE_PASSCODE: 'global-passcode',
    };

    applyPinokioEnvironment({ environment, filepath });

    assert.equal(environment.OPENAI_API_KEY, 'app-value');
    assert.equal(environment.GOOGLE_MAPS_API_KEY, '');
    assert.equal(environment.GEV_RATELIMIT_OPENAI_PER_MIN, '30');
    assert.equal(environment.GEV_RATELIMIT_GOOGLE_PER_MIN, '120');
    assert.equal(environment.PINOKIO_SHARE_LOCAL, 'false');
    assert.equal(environment.PINOKIO_SHARE_VAR, '__gev_sharing_disabled__');
    assert.equal(environment.PINOKIO_SHARE_PASSCODE, '');
    const persisted = readFileSync(filepath, 'utf8');
    assert.match(persisted, /^PINOKIO_SHARE_LOCAL=false$/m);
    assert.match(persisted, /^PINOKIO_SHARE_VAR=__gev_sharing_disabled__$/m);
    assert.match(persisted, /^OPENAI_API_KEY=app-value$/m);
    assert.doesNotMatch(persisted, /^GEV_RATELIMIT_OPENAI_PER_MIN=/m);
    assert.doesNotMatch(persisted, /^GEV_RATELIMIT_GOOGLE_PER_MIN=/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blank and duplicate sharing controls are canonicalized before Pinokio re-reads them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-env-duplicates-'));
  try {
    const filepath = path.join(root, 'ENVIRONMENT');
    const providerLines = [
      'GOOGLE_MAPS_API_KEY=app-google',
      'OPENAI_API_KEY=',
    ];
    writeFileSync(filepath, [
      providerLines[0],
      'PINOKIO_SHARE_CLOUDFLARE=',
      'PINOKIO_SHARE_LOCAL=false',
      'PINOKIO_SHARE_VAR=url',
      providerLines[1],
      'PINOKIO_SHARE_CLOUDFLARE=true',
      'PINOKIO_SHARE_VAR=url',
      '',
    ].join('\n'));
    const environment = {
      PINOKIO_SHARE_CLOUDFLARE: 'true',
      PINOKIO_SHARE_LOCAL: 'true',
      PINOKIO_SHARE_VAR: 'url',
      PINOKIO_SHARE_PASSCODE: 'global-passcode',
    };

    applyPinokioEnvironment({ environment, filepath });

    assert.equal(environment.PINOKIO_SHARE_CLOUDFLARE, 'false');
    assert.equal(environment.PINOKIO_SHARE_LOCAL, 'false');
    assert.equal(environment.PINOKIO_SHARE_VAR, '__gev_sharing_disabled__');
    assert.equal(environment.PINOKIO_SHARE_PASSCODE, '');
    const persisted = readFileSync(filepath, 'utf8');
    for (const providerLine of providerLines) {
      assert.match(persisted, new RegExp(`^${providerLine}$`, 'm'));
    }
    assert.equal((persisted.match(/^PINOKIO_SHARE_CLOUDFLARE=/gm) || []).length, 1);
    assert.equal((persisted.match(/^PINOKIO_SHARE_LOCAL=/gm) || []).length, 1);
    assert.equal((persisted.match(/^PINOKIO_SHARE_VAR=/gm) || []).length, 1);
    assert.match(persisted, /^PINOKIO_SHARE_CLOUDFLARE=false$/m);
    assert.match(persisted, /^PINOKIO_SHARE_LOCAL=false$/m);
    assert.match(persisted, /^PINOKIO_SHARE_VAR=__gev_sharing_disabled__$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const fixture of [
  { name: 'UTF-16LE', encode: (source) => Buffer.from(source, 'utf16le') },
  { name: 'UTF-16BE', encode: encodeUtf16be },
]) {
  test(`${fixture.name} Pinokio configuration preserves provider values during migration`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gev-pinokio-env-utf16-'));
    try {
      const filepath = path.join(root, 'ENVIRONMENT');
      writeFileSync(filepath, fixture.encode([
        'OPENAI_API_KEY=provider-value',
        'PINOKIO_SHARE_CLOUDFLARE=',
        'PINOKIO_SHARE_LOCAL=true',
        'PINOKIO_SHARE_VAR=url',
        '',
      ].join('\n')));
      const environment = {
        OPENAI_API_KEY: 'global-value',
        PINOKIO_SHARE_CLOUDFLARE: 'true',
        PINOKIO_SHARE_LOCAL: 'true',
        PINOKIO_SHARE_VAR: 'url',
        PINOKIO_SHARE_PASSCODE: 'global-passcode',
      };

      applyPinokioEnvironment({ environment, filepath });

      assert.equal(environment.OPENAI_API_KEY, 'provider-value');
      assert.equal(environment.PINOKIO_SHARE_CLOUDFLARE, 'false');
      assert.equal(environment.PINOKIO_SHARE_LOCAL, 'false');
      assert.equal(environment.PINOKIO_SHARE_VAR, '__gev_sharing_disabled__');
      assert.equal(environment.PINOKIO_SHARE_PASSCODE, '');
      assert.equal(readPinokioEnvironment(filepath).OPENAI_API_KEY, 'provider-value');
      const persisted = readFileSync(filepath);
      assert.equal(persisted.includes(0), false, 'migration writes one coherent UTF-8 file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
