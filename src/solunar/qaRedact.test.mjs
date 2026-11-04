import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeRedactor,
  urlSecrets,
} from '../../scripts/qa-solunar-redact.mjs';

test('a failed navigation echoing the QA url prints no userinfo or query value', () => {
  const url = 'https://qauser:Zx9PassWordQ7@host.example:4393/?token=AbC123SecretTokenXyZ&k=Qq77LongApiKey99';
  const redact = makeRedactor(urlSecrets(url));
  const out = redact(
    `Error: net::ERR_CONNECTION_REFUSED at ${url}\n  qauser / Zx9PassWordQ7 / AbC123SecretTokenXyZ / Qq77LongApiKey99`,
  );
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
