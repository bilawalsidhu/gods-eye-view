import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatAdoptedFiles } from '../../scripts/format.mjs';

async function fixture(t, scope = ['adopted.js']) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(
    path.join(root, 'scripts/format-scope.json'),
    JSON.stringify(scope),
  );
  await writeFile(
    path.join(root, '.prettierrc.json'),
    JSON.stringify({
      singleQuote: true,
      semi: true,
      tabWidth: 2,
      endOfLine: 'lf',
    }),
  );
  await writeFile(path.join(root, '.prettierignore'), 'ignored.js\n');
  await writeFile(path.join(root, 'adopted.js'), 'const value="yes"\r\n');
  return root;
}

test('format check is read-only; write only changes adopted files and is repeatable', async (t) => {
  const root = await fixture(t);
  const outside = 'const untouched="yes"';
  await writeFile(path.join(root, 'legacy.js'), outside);
  assert.deepEqual((await formatAdoptedFiles(root, '--check')).changed, [
    'adopted.js',
  ]);
  assert.equal(
    await readFile(path.join(root, 'adopted.js'), 'utf8'),
    'const value="yes"\r\n',
  );
  await formatAdoptedFiles(root, '--write');
  assert.equal(
    await readFile(path.join(root, 'adopted.js'), 'utf8'),
    "const value = 'yes';\n",
  );
  assert.equal(await readFile(path.join(root, 'legacy.js'), 'utf8'), outside);
  assert.deepEqual((await formatAdoptedFiles(root, '--check')).changed, []);
  assert.deepEqual((await formatAdoptedFiles(root, '--write')).changed, []);
});

test('invalid, ignored and missing scope entries fail before any file is written', async (t) => {
  for (const scope of [
    [],
    ['adopted.js', 'adopted.js'],
    ['adopted.js', '../escape.js'],
    ['adopted.js', 'ignored.js'],
    ['adopted.js', 'missing.js'],
  ]) {
    const root = await fixture(t, scope);
    await writeFile(path.join(root, 'ignored.js'), 'const ignored=1');
    await assert.rejects(formatAdoptedFiles(root, '--write'));
    assert.equal(
      await readFile(path.join(root, 'adopted.js'), 'utf8'),
      'const value="yes"\r\n',
    );
  }
});

test(
  'formatting rejects a symlink outside the repository',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fixture(t, ['adopted.js', 'outside.js']);
    const other = await fixture(t);
    await symlink(
      path.join(other, 'adopted.js'),
      path.join(root, 'outside.js'),
    );
    await assert.rejects(
      formatAdoptedFiles(root, '--write'),
      /repository files/,
    );
    assert.equal(
      await readFile(path.join(root, 'adopted.js'), 'utf8'),
      'const value="yes"\r\n',
    );
  },
);

test('runtime discovery includes new nested modules and respects Git and formatter exclusions', async (t) => {
  const root = await fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'src/nested'), { recursive: true });
  await mkdir(path.join(root, 'vendor'), { recursive: true });
  await writeFile(
    path.join(root, 'scripts/format-runtime.json'),
    JSON.stringify({ roots: ['src'] }),
  );
  await writeFile(path.join(root, '.gitignore'), 'src/ignored.js\n');
  await writeFile(path.join(root, '.prettierignore'), 'src/generated.js\n');
  const source = 'export const value="yes"';
  for (const name of [
    'src/nested/new.js',
    'src/module.mjs',
    'src/check.test.mjs',
    'src/ignored.js',
    'src/generated.js',
    'vendor/other.js',
  ])
    await writeFile(path.join(root, name), source);
  const expected = ['adopted.js', 'src/module.mjs', 'src/nested/new.js'];
  assert.deepEqual(
    (await formatAdoptedFiles(root, '--check')).changed,
    expected,
  );
  await formatAdoptedFiles(root, '--write');
  assert.deepEqual((await formatAdoptedFiles(root, '--check')).changed, []);
  for (const name of [
    'src/check.test.mjs',
    'src/ignored.js',
    'src/generated.js',
    'vendor/other.js',
  ])
    assert.equal(await readFile(path.join(root, name), 'utf8'), source);
});

test('runtime scope rejects unsafe roots before formatting existing entries', async (t) => {
  for (const roots of [
    [],
    ['src', 'src'],
    ['../outside'],
    ['/absolute'],
    ['.'],
    ['src/*'],
  ]) {
    const root = await fixture(t);
    await writeFile(
      path.join(root, 'scripts/format-runtime.json'),
      JSON.stringify({ roots }),
    );
    await assert.rejects(
      formatAdoptedFiles(root, '--write'),
      /Runtime formatting roots/,
    );
    assert.equal(
      await readFile(path.join(root, 'adopted.js'), 'utf8'),
      'const value="yes"\r\n',
    );
  }
});

test(
  'discovered runtime symlinks cannot escape the repository',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fixture(t);
    const other = await fixture(t);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'scripts/format-runtime.json'),
      JSON.stringify({ roots: ['src'] }),
    );
    await symlink(
      path.join(other, 'adopted.js'),
      path.join(root, 'src/outside.js'),
    );
    await assert.rejects(
      formatAdoptedFiles(root, '--write'),
      /repository files/,
    );
    assert.equal(
      await readFile(path.join(root, 'adopted.js'), 'utf8'),
      'const value="yes"\r\n',
    );
  },
);
