// The zh-Hant branches of `npm run i18n` (main in scripts/i18n.mjs), run in a
// throwaway repository like stale-index.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const json = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;

function sandbox(zhCN, { modules = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'zh-hant-cli-'));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(
    path.join(REPO, 'scripts/i18n.mjs'),
    path.join(root, 'scripts/i18n.mjs'),
  );
  if (modules) {
    // The package wherever node finds it, from its dist/umd entry; a junction
    // needs no symlink privilege on Windows.
    const entry = createRequire(import.meta.url).resolve('opencc-js/cn2t');
    mkdirSync(path.join(root, 'node_modules'));
    symlinkSync(
      path.resolve(path.dirname(entry), '../..'),
      path.join(root, 'node_modules/opencc-js'),
      'junction',
    );
  }
  write('.gitignore', 'node_modules\n');
  write('src/a.js', "export const a = [t('Video'), t('Server')];\n");
  write('src/i18n/same-as-english.json', '{}\n');
  write('src/i18n/locales/zh-CN.json', json(zhCN));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  return {
    git,
    write,
    read: (file) => readFileSync(path.join(root, file), 'utf8'),
    run: (...args) =>
      spawnSync(process.execPath, ['scripts/i18n.mjs', ...args], {
        cwd: root,
        encoding: 'utf8',
      }),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ZH_CN = { Video: '视频', Server: '服务器' };
const ZH_HANT = { Video: '視頻', Server: '服務器' };

test('--missing zh-Hant points to --zh-hant instead of printing a template', () => {
  const box = sandbox(ZH_CN);
  try {
    for (const locale of ['zh-Hant', 'zh-hant']) {
      const result = box.run('--missing', locale);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /then run npm run i18n -- --zh-hant/);
    }
  } finally {
    box.done();
  }
});

test('--zh-hant writes zh-CN converted, in its key order, indent 2 and a final newline', () => {
  const box = sandbox(ZH_CN);
  try {
    const result = box.run('--zh-hant');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(box.read('src/i18n/locales/zh-Hant.json'), json(ZH_HANT));
    assert.match(result.stdout, /zh-Hant: 2 messages, complete/);
  } finally {
    box.done();
  }
});

test('--prune drops a stale entry from both catalogs, whichever git lists first', () => {
  const box = sandbox({ ...ZH_CN, Old: '旧' });
  try {
    // zh-CN tracked and zh-Hant not: git ls-files lists zh-Hant first.
    box.git('add', '-A');
    box.run('--zh-hant');
    const result = box.run('--prune');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /zh-CN: pruned 1 unused entries/);
    assert.match(result.stdout, /zh-Hant: pruned 1 unused entries/);
    assert.equal(box.read('src/i18n/locales/zh-Hant.json'), json(ZH_HANT));
  } finally {
    box.done();
  }
});

test('a missing zh-Hant entry says to add it to zh-CN only when zh-CN lacks it too', () => {
  for (const [zhCN, fill] of [
    [ZH_CN, 'run npm run i18n -- --zh-hant'],
    [{ Video: '视频' }, 'add them to zh-CN, then npm run i18n -- --zh-hant'],
  ]) {
    const box = sandbox(zhCN);
    try {
      box.write('src/i18n/locales/zh-Hant.json', json({ Video: '視頻' }));
      const result = box.run();
      assert.equal(result.status, 1);
      assert.ok(
        result.stdout.includes(`zh-Hant: 1 missing (${fill}):`),
        result.stdout,
      );
    } finally {
      box.done();
    }
  }
});

test('without node_modules the zh-Hant check says to install and the other checks still run', () => {
  const box = sandbox(ZH_CN, { modules: false });
  try {
    box.write('src/i18n/locales/zh-Hant.json', json(ZH_HANT));
    box.write('index.html', '<p>Unmarked words</p>\n');
    const result = box.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /zh-Hant: .*run npm ci/);
    assert.match(result.stdout, /1 UI strings not marked for translation/);
  } finally {
    box.done();
  }
});
