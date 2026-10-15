import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, here), 'utf8');

test('Navara internals are pinned: package.json and internals.js name the same exact version', () => {
  const pkg = JSON.parse(read('../../../package.json'));
  const declared = read('internals.js').match(
    /NAVARA_INTERNALS_VERSION = '([^']+)'/,
  )?.[1];
  assert.equal(declared, '0.2.1');
  for (const name of ['@navaramap/three', '@navaramap/three-default-plugin'])
    assert.equal(pkg.dependencies[name], declared, name);
});

test('only internals.js reaches private Navara members', () => {
  const offenders = readdirSync(here).filter(
    (name) =>
      name.endsWith('.js') &&
      name !== 'internals.js' &&
      /\.\s*_[A-Za-z]/.test(read(name).replace(/\/\/.*$/gm, '')),
  );
  assert.deepEqual(offenders, []);
});
