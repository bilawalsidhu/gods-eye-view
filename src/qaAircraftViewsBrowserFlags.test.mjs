// Reproduction: scripts/qa-aircraft-views.mjs launches Chromium with the
// sandbox and same-origin checks off for whatever --url it is given
// (docs/PR_REVIEW_SANDBOX.md: avoid --no-sandbox and --disable-web-security).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Chromium launch protections: the view QA keeps sandbox and origin checks', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts/qa-aircraft-views.mjs'), 'utf8');
  const launch = /puppeteer\.launch\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? '';
  assert.ok(launch, 'found the launch call');
  for (const flag of ['--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox'])
    assert.ok(!launch.includes(`'${flag}'`), `launch passes ${flag}`);
});
