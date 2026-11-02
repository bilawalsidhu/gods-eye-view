import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FRAGMENT_DIR,
  STAGING_DIR,
  assembleChangelog,
  assembleFragments,
  orderFragmentNames,
  recoverInterruptedBatch,
} from '../../scripts/assemble-changelog.mjs';

const EXISTING =
  '# Changelog\n\n- An entry that was already released (someone, #1).\n';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

async function fixture(t, fragments = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-changelog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, FRAGMENT_DIR));
  await writeFile(
    path.join(root, FRAGMENT_DIR, 'README.md'),
    '# How to add one\n',
  );
  await writeFile(path.join(root, 'CHANGELOG.md'), EXISTING);
  for (const [name, body] of Object.entries(fragments)) {
    await writeFile(path.join(root, FRAGMENT_DIR, name), body);
  }
  return root;
}

test('the batch reads newest pull request first', () => {
  assert.deepEqual(orderFragmentNames(['7-b.md', '112-c.md', '19-a.md']), [
    '112-c.md',
    '19-a.md',
    '7-b.md',
  ]);
});

test('the directory README is documentation, never an entry', () => {
  assert.deepEqual(orderFragmentNames(['README.md', '5-a.md']), ['5-a.md']);
});

test('two fragments claiming one pull request fail loudly, not silently', () => {
  assert.throws(
    () => orderFragmentNames(['5-first.md', '5-second.md']),
    /Two fragments claim pull request 5/,
  );
});

test('a name that is not <pull request>-<slug>.md is refused', () => {
  for (const name of ['notes.md', '5_underscore.md', '5-Caps.md', '5-a.txt']) {
    assert.throws(() => orderFragmentNames([name]), /Unexpected file/, name);
  }
});

test('fragment text is spliced in unchanged, above the existing entries', () => {
  // Wrapped, indented and punctuated the way a real entry is: the continuation
  // indent and the blank line inside the entry are the parts a reflow would eat.
  const entry = [
    '- A new thing, with `code` and a — dash. The second line is indented the',
    '  way the surrounding entries wrap, and it keeps its two spaces.',
    '',
    '  A second paragraph, because some entries have one (someone, #9).',
  ].join('\n');
  const result = assembleChangelog(EXISTING, [`${entry}\n\n\n`]);
  assert.equal(
    result,
    `# Changelog\n\n${entry}\n\n- An entry that was already released (someone, #1).\n`,
  );
  // The entry survives byte for byte: drawTool.test.mjs reads this file as
  // prose and slices a fixed window, so reflowing would move text across it.
  assert.ok(result.includes(entry));
});

test('a CHANGELOG without the heading is refused rather than prepended to', () => {
  assert.throws(
    () => assembleChangelog('- orphan entry\n', ['- new\n']),
    /must start with "# Changelog"/,
  );
});

test('assembling consumes the fragments and leaves the README', async (t) => {
  const root = await fixture(t, {
    '20-second.md': '- Second (someone, #20).',
    '100-first.md': '- First (someone, #100).',
  });
  const { consumed } = await assembleFragments(root, '--write');
  assert.deepEqual(consumed, ['100-first.md', '20-second.md']);
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(
    changelog,
    /# Changelog\n\n- First \(someone, #100\)\.\n\n- Second \(someone, #20\)\.\n\n- An entry that was already released/,
  );
  assert.deepEqual(await readdir(path.join(root, FRAGMENT_DIR)), ['README.md']);
});

test('a rejected batch leaves the directory and the file untouched', async (t) => {
  const root = await fixture(t, {
    '8-first.md': '- First (someone, #8).',
    '8-again.md': '- Again (someone, #8).',
  });
  await assert.rejects(
    assembleFragments(root, '--write'),
    /Two fragments claim pull request 8/,
  );
  assert.equal(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    EXISTING,
  );
  assert.deepEqual((await readdir(path.join(root, FRAGMENT_DIR))).sort(), [
    '8-again.md',
    '8-first.md',
    'README.md',
  ]);
});

test('check mode changes nothing on disk', async (t) => {
  const root = await fixture(t, { '3-a.md': '- Something (someone, #3).' });
  const { consumed } = await assembleFragments(root, '--check');
  assert.deepEqual(consumed, ['3-a.md']);
  assert.equal(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    EXISTING,
  );
  assert.deepEqual((await readdir(path.join(root, FRAGMENT_DIR))).sort(), [
    '3-a.md',
    'README.md',
  ]);
});

test('an empty directory is a no-op, so a release can always run it', async (t) => {
  const root = await fixture(t);
  const { consumed } = await assembleFragments(root, '--write');
  assert.deepEqual(consumed, []);
  assert.equal(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    EXISTING,
  );
});

test('a mode that is neither check nor write is refused', async (t) => {
  const root = await fixture(t);
  await assert.rejects(assembleFragments(root, '--force'), /--check\|--write/);
});

// Failure injection. Every filesystem call the write path makes is a point
// where a release can die: a full disk, a permissions error, a killed process.

const IO_CALLS = ['readdir', 'readFile', 'mkdir', 'writeFile', 'rename', 'rm'];
const BATCH = {
  '20-second.md': '- Second (someone, #20).',
  '100-first.md': '- First (someone, #100).',
  '7-third.md': '- Third (someone, #7).',
};

/**
 * The real filesystem, except that `call` throws the `nth` time it runs. With
 * `crash`, every later call throws as well, the way a killed process makes no
 * further calls: the in-process rollback cannot run either, so the next
 * invocation is the only thing that can recover.
 */
function failing(call, nth, { crash = false } = {}) {
  let seen = 0;
  let dead = false;
  const io = { ...fs };
  for (const name of IO_CALLS) {
    io[name] = async (...args) => {
      if (dead) throw new Error('process already gone');
      if (name === call && ++seen === nth) {
        dead = crash;
        throw new Error(`injected ${call} failure #${nth}`);
      }
      return fs[name](...args);
    };
  }
  return io;
}

/** How many times one uninterrupted `--write` makes each filesystem call. */
async function countCalls(t) {
  const root = await fixture(t, BATCH);
  const counts = Object.fromEntries(IO_CALLS.map((name) => [name, 0]));
  const io = { ...fs };
  for (const name of IO_CALLS) {
    io[name] = (...args) => {
      counts[name] += 1;
      return fs[name](...args);
    };
  }
  await assembleFragments(root, '--write', io);
  return {
    counts,
    expected: await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
  };
}

test('a write that fails at any call never lets a retry duplicate or lose an entry', async (t) => {
  const { counts, expected } = await countCalls(t);
  // The write path itself: one mkdir, one writeFile, a rename per fragment plus
  // the commit rename, and the cleanup rm. Fewer would mean a step went missing.
  assert.ok(counts.rename >= Object.keys(BATCH).length + 1);
  for (const crash of [false, true]) {
    for (const call of IO_CALLS) {
      for (let nth = 1; nth <= counts[call]; nth += 1) {
        const label = `${crash ? 'crash' : 'error'} at ${call} #${nth}`;
        const root = await fixture(t, BATCH);
        await assert.rejects(
          assembleFragments(root, '--write', failing(call, nth, { crash })),
          /injected|already gone/,
          label,
        );
        await assembleFragments(root, '--write');
        const changelog = await readFile(
          path.join(root, 'CHANGELOG.md'),
          'utf8',
        );
        assert.equal(changelog, expected, label);
        for (const pr of [100, 20, 7, 1]) {
          assert.equal(
            changelog.split(`(someone, #${pr}).`).length - 1,
            1,
            `${label}: #${pr} appears exactly once`,
          );
        }
        assert.deepEqual(
          await readdir(path.join(root, FRAGMENT_DIR)),
          ['README.md'],
          label,
        );
      }
    }
  }
});

test('an error before the commit rolls the batch back in the same run', async (t) => {
  const root = await fixture(t, BATCH);
  // The second rename has already moved one fragment into the staging directory.
  await assert.rejects(
    assembleFragments(root, '--write', failing('rename', 2)),
    /injected rename failure #2/,
  );
  assert.equal(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    EXISTING,
  );
  assert.deepEqual(
    (await readdir(path.join(root, FRAGMENT_DIR))).sort(),
    [...Object.keys(BATCH), 'README.md'].sort(),
  );
});

test('check mode reports a batch an interrupted release left staged', async (t) => {
  const root = await fixture(t, BATCH);
  await assert.rejects(
    assembleFragments(root, '--write', failing('rename', 2, { crash: true })),
  );
  await assert.rejects(
    assembleFragments(root, '--check'),
    new RegExp(`${STAGING_DIR}/ holds a batch an interrupted release`),
  );
  assert.equal(await recoverInterruptedBatch(root), 'rolled-back');
  assert.equal(await recoverInterruptedBatch(root), 'none');
});

test('recovery refuses to roll a fragment back over a file of the same name', async (t) => {
  const root = await fixture(t, BATCH);
  await assert.rejects(
    assembleFragments(root, '--write', failing('rename', 2, { crash: true })),
  );
  await writeFile(
    path.join(root, FRAGMENT_DIR, '100-first.md'),
    '- Rewritten.',
  );
  await assert.rejects(
    assembleFragments(root, '--write'),
    /Cannot roll back .*100-first\.md/,
  );
  assert.equal(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    EXISTING,
  );
});

// The two below run against the repository itself, so a fragment that the
// release could not assemble fails `npm test` in the pull request that adds it
// rather than at release time, when its author has moved on.

test('every pending fragment in the repository can be assembled', async () => {
  const names = await readdir(path.join(repositoryRoot, FRAGMENT_DIR));
  assert.ok(
    names.includes('README.md'),
    `${FRAGMENT_DIR}/README.md documents the convention and keeps the directory tracked`,
  );
  // Throws on a name that is not <pull request>-<slug>.md, and on two fragments
  // claiming one pull request number. Every other file is an entry.
  assert.equal(orderFragmentNames(names).length, names.length - 1);
});

test('CHANGELOG.md still carries the heading a release splices under', async () => {
  const changelog = await readFile(
    path.join(repositoryRoot, 'CHANGELOG.md'),
    'utf8',
  );
  assert.ok(changelog.startsWith('# Changelog\n'));
});
