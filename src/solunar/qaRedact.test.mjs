import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('browser event and navigation errors do not print untrusted secrets', () => {
  const secrets = [
    'Bearer FakeBearerSecretABC123',
    'https://fakeuser:fakepass@host.invalid',
    'FakeTokenSuffixABC123',
    'X-Api-Key: FakeApiKeyABC123',
    'https://host.invalid/?api_key=FakeQueryKeyABC123',
  ];
  const run = spawnSync(
    process.execPath,
    [
      '--import=./scripts/fixtures/solunar/qaProbeHook.mjs',
      'scripts/qa-solunar.mjs',
    ],
    {
      cwd: new URL('../../', import.meta.url),
      env: {
        ...process.env,
        QA_OUT_DIR: '.',
        SOLUNAR_TEST_SECRET: secrets.join(' '),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /PROBE_EVENTS_DELIVERED/);
  assert.match(run.stderr, /unable to complete browser checks/);
  for (const secret of secrets) {
    assert.ok(
      !(run.stdout + run.stderr).includes(secret),
      'untrusted value leaked',
    );
  }
});

test('filesystem startup failure does not print a secret-bearing path', () => {
  const token = 'SyntheticPrivatePathABC123';
  const run = spawnSync(process.execPath, ['scripts/qa-solunar.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, QA_OUT_DIR: `/dev/null/${token}` },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unable to complete browser checks/);
  assert.ok(!(run.stdout + run.stderr).includes(token));
});

test('QA does not print arbitrary browser or exception diagnostics', () => {
  const source = readFileSync(
    new URL('../../scripts/qa-solunar.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /console\.error\('\[qa-solunar\] unable to complete browser checks'\)/,
  );
  assert.doesNotMatch(
    source,
    /e\?\.stack|e\?\.message|String\(e\)|JSON\.stringify\(opened\.days\[0\]\)/,
  );
  assert.doesNotMatch(source, /detail \? ' - ' \+ detail/);
});
import { makeRedactor, urlSecrets } from '../../scripts/qa-solunar-redact.mjs';

test('a failed navigation echoing the QA url prints no userinfo or query value', () => {
  const url =
    'https://qauser:Zx9PassWordQ7@host.example:4393/?token=AbC123SecretTokenXyZ&k=Qq77LongApiKey99';
  const redact = makeRedactor(urlSecrets(url));
  const out = redact(
    `Error: net::ERR_CONNECTION_REFUSED at ${url}\n  qauser / Zx9PassWordQ7 / AbC123SecretTokenXyZ / Qq77LongApiKey99`,
  );
  const token = 'AbC123SecretTokenXyZ';
  for (const representation of [
    token.slice(0, 8),
    token.slice(-6),
    Buffer.from(token).toString('base64'),
  ]) {
    assert.ok(
      !redact(representation).includes(representation),
      'partial or encoded secret leaked',
    );
  }
  for (const secret of [
    'qauser',
    'Zx9PassWordQ7',
    'AbC123SecretTokenXyZ',
    'Qq77LongApiKey99',
    'tokenXyZ',
  ]) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  }
});
