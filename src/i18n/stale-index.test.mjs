// scripts/i18n.mjs must skip index entries gone from the working tree
// (plain `mv`/`rm` without `git mv`/`git rm`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'k23-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'src/i18n/locales'), { recursive: true });
  copyFileSync(
    path.join(HERE, '../../scripts/i18n.mjs'),
    path.join(root, 'scripts/i18n.mjs'),
  );
  writeFileSync(path.join(root, 'src/a.js'), "export const x = t('Hello');\n");
  writeFileSync(path.join(root, 'index.html'), '<p data-i18n>Hello</p>\n');
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=k@23', '-c', 'user.name=k23', 'commit', '-qm', 'init');
  return root;
}

test('extractMessages survives a module renamed with plain mv', async () => {
  const root = sandbox();
  try {
    renameSync(path.join(root, 'src/a.js'), path.join(root, 'src/b.js'));
    const mod = await import(
      pathToFileURL(path.join(root, 'scripts/i18n.mjs')).href
    );
    const messages = mod.extractMessages();
    assert.ok(messages.has('Hello'));
    assert.doesNotThrow(() => mod.findUnmarked());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
