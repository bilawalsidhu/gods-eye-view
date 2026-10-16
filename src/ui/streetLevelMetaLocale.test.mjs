// The Street Level meta-line test must not depend on the system locale: the
// code formats the count in the app language (formatNumber), so a contributor
// whose terminal sets LANG=de_DE or es_ES must see the same green run as CI's
// C.UTF-8. Runs the presentation test file under three process locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'streetLevelPresentation.test.mjs');

for (const locale of ['de_DE.UTF-8', 'es_ES.UTF-8', 'C.UTF-8']) {
  test(`streetLevelPresentation tests pass under LC_ALL=${locale}`, () => {
    // Drop the node:test child markers so the nested run is a real top-level run.
    const env = { ...process.env, LC_ALL: locale, LANG: locale };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, ['--test', target], {
      encoding: 'utf8',
      env,
    });
    const failed = result.stdout.match(/^ℹ fail (\d+)/m)?.[1] ?? '?';
    assert.equal(
      result.status,
      0,
      `exit status ${result.status}, ${failed} failing test(s) under ${locale}\n${result.stdout.slice(-700)}`,
    );
  });
}
