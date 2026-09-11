import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('dev-cctv defaults to loopback and warns for explicit network exposure', async () => {
  const source = await fs.readFile(new URL('../scripts/dev-cctv.sh', import.meta.url), 'utf8');

  assert.match(source, /HOST="\$\{HOST:-localhost\}"/);
  assert.match(source, /set HOST=0\.0\.0\.0 for LAN/);
  assert.match(source, /WARNING: HOST=\$\{HOST\} - network-exposed mode/);
  assert.match(source, /npm run dev -- --host "\$\{HOST\}"/);
  assert.doesNotMatch(source, /HOST="\$\{HOST:-0\.0\.0\.0\}"/);
});
