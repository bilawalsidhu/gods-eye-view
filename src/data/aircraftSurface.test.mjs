import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const action of ['hide', 'removeAll']) {
  test(`shared aircraft surface releases destroyed native objects on ${action}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(
          new URL('../../scripts/qa-aircraft-retention.mjs', import.meta.url),
        ),
        '--count',
        '128',
        '--check',
        ...(action === 'removeAll' ? ['--remove-all'] : []),
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(report.retainedNativeResidents, 0);
    assert.equal(report.logicalContacts, action === 'hide' ? 128 : 0);
  });
}
