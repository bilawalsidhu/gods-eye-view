import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readGit,
  redactRemoteUrl,
  reportIncomingChanges,
  updateFromRemote,
} from '../scripts/pinokio-update.mjs';

const source = readFileSync(
  new URL('../scripts/pinokio-update.mjs', import.meta.url),
  'utf8',
);

/** Run git in a fixture repository, failing the test on a git error. */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.error}`,
  );
  return result.stdout.trim();
}

/** Escape a path so it can be matched literally inside a RegExp. */
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a disposable origin repository and a clone that tracks it.
 *
 * Everything is on disk and driven through real git, so the assertions are
 * about what the update path does to a checkout rather than about a transcript
 * of injected strings.
 *
 * @param {import('node:test').TestContext} t - Owns the fixture's cleanup.
 */
async function fixture(t) {
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), 'gev-update-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const origin = path.join(scratch, 'origin');
  const clone = path.join(scratch, 'clone');

  git(scratch, ['init', '--quiet', '--initial-branch=main', origin]);
  git(origin, ['config', 'user.email', 'fixture@example.invalid']);
  git(origin, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(origin, 'README.md'), 'first\n');
  git(origin, ['add', 'README.md']);
  git(origin, ['commit', '--quiet', '-m', 'first commit']);

  git(scratch, ['clone', '--quiet', origin, clone]);
  git(clone, ['config', 'user.email', 'fixture@example.invalid']);
  git(clone, ['config', 'user.name', 'Fixture']);

  /** Add one commit to the origin repository. */
  const push = async (message, contents) => {
    await writeFile(path.join(origin, 'README.md'), contents);
    git(origin, ['add', 'README.md']);
    git(origin, ['commit', '--quiet', '-m', message]);
    return git(origin, ['rev-parse', 'HEAD']);
  };

  /** Same, from a synchronous callback (used to move the remote mid-update). */
  const pushSync = (message, contents) => {
    writeFileSync(path.join(origin, 'README.md'), contents);
    git(origin, ['add', 'README.md']);
    git(origin, ['commit', '--quiet', '-m', message]);
    return git(origin, ['rev-parse', 'HEAD']);
  };

  const out = [];
  const io = {
    cwd: clone,
    log: (line) => out.push(String(line)),
    warn: (line) => out.push(String(line)),
    fetchRemote: (remote) => git(clone, ['fetch', '--quiet', remote]),
    apply: (args) => git(clone, args),
  };

  return {
    scratch,
    origin,
    clone,
    push,
    pushSync,
    io,
    out,
    text: () => out.join('\n'),
  };
}

test('a checkout with no upstream is reported and left to the plain pull', async (t) => {
  const app = await fixture(t);
  git(app.clone, ['checkout', '--quiet', '-b', 'local-only']);
  let fetched = null;
  const plan = reportIncomingChanges({
    ...app.io,
    fetchRemote: (remote) => {
      fetched = remote;
    },
  });
  assert.deepEqual(plan, { apply: null, fallback: true });
  assert.match(app.text(), /No upstream branch is configured/);
  assert.equal(fetched, null, 'nothing is fetched without an upstream');
});

test('the tracking branch and the remote it fetches from are printed', async (t) => {
  const app = await fixture(t);
  await app.push('second commit', 'second\n');
  reportIncomingChanges(app.io);
  assert.match(app.text(), /Tracking origin\/main/);
  assert.match(app.text(), new RegExp(`Fetching from ${literal(app.origin)}`));
});

test('the incoming commits and their diffstat are printed, and the report alone applies nothing', async (t) => {
  const app = await fixture(t);
  const before = git(app.clone, ['rev-parse', 'HEAD']);
  await app.push('second commit', 'second\n');
  await app.push('third commit', 'third\n');
  const plan = reportIncomingChanges(app.io);
  const text = app.text();
  assert.match(text, /2 incoming commit\(s\)/);
  assert.match(text, /second commit/);
  assert.match(text, /third commit/);
  assert.match(text, /README\.md \| 2 \+-/);
  assert.equal(plan.fallback, false);
  assert.equal(
    git(app.clone, ['rev-parse', 'HEAD']),
    before,
    'the report must not move the checkout',
  );
});

test('the revision that is applied is the revision that was disclosed', async (t) => {
  const app = await fixture(t);
  const disclosed = await app.push('second commit', 'second\n');
  const plan = reportIncomingChanges(app.io);
  // Something lands on the remote between the disclosure and the apply. A
  // second fetch would install it without ever naming it.
  await app.push('a commit nobody was shown', 'fourth\n');
  assert.equal(plan.apply, disclosed);
  app.io.apply(['merge', '--ff-only', plan.apply]);
  assert.equal(git(app.clone, ['rev-parse', 'HEAD']), disclosed);
  assert.match(app.text(), new RegExp(`Applying ${disclosed}`));
});

test('the whole update applies exactly one disclosed revision', async (t) => {
  const app = await fixture(t);
  const disclosed = await app.push('second commit', 'second\n');
  const plan = updateFromRemote(app.io);
  assert.equal(plan.apply, disclosed);
  assert.equal(git(app.clone, ['rev-parse', 'HEAD']), disclosed);
});

test('a remote that moves during the update does not change what is applied', async (t) => {
  const app = await fixture(t);
  const disclosed = await app.push('second commit', 'second\n');
  let later = null;
  const plan = updateFromRemote({
    ...app.io,
    fetchRemote: (remote) => {
      git(app.clone, ['fetch', '--quiet', remote]);
      // The remote gains a commit after the one fetch this update makes. Only
      // a second fetch — which there must not be — could reach it.
      later = app.pushSync('a commit nobody was shown', 'fourth\n');
    },
  });
  assert.equal(plan.apply, disclosed);
  assert.equal(git(app.clone, ['rev-parse', 'HEAD']), disclosed);
  assert.notEqual(git(app.clone, ['rev-parse', 'HEAD']), later);
});

test('an up-to-date checkout says so and applies nothing', async (t) => {
  const app = await fixture(t);
  const before = git(app.clone, ['rev-parse', 'HEAD']);
  const plan = updateFromRemote(app.io);
  assert.deepEqual(plan, { apply: null, fallback: false });
  assert.match(app.text(), /Already up to date/);
  assert.equal(git(app.clone, ['rev-parse', 'HEAD']), before);
});

test('an unreadable commit range is reported as unreadable, not as up to date', async (t) => {
  const app = await fixture(t);
  const disclosed = await app.push('second commit', 'second\n');
  const plan = reportIncomingChanges({
    ...app.io,
    read: (args) =>
      args[0] === 'log' ? null : readGit(args, { cwd: app.clone }),
  });
  const text = app.text();
  assert.doesNotMatch(text, /Already up to date/);
  assert.match(text, /Could not list the commits/);
  assert.equal(plan.apply, disclosed, 'the fetched revision is still applied');
});

test('an unresolvable upstream falls back to the plain pull without claiming to be current', async (t) => {
  const app = await fixture(t);
  await app.push('second commit', 'second\n');
  const plan = reportIncomingChanges({
    ...app.io,
    read: (args) =>
      args[0] === 'rev-parse' && args.length === 2
        ? null
        : readGit(args, { cwd: app.clone }),
  });
  assert.deepEqual(plan, { apply: null, fallback: true });
  assert.doesNotMatch(app.text(), /Already up to date/);
  assert.match(app.text(), /Could not resolve origin\/main/);
});

test('diverged history is refused rather than applied', async (t) => {
  const app = await fixture(t);
  await app.push('second commit', 'second\n');
  await writeFile(path.join(app.clone, 'README.md'), 'local work\n');
  git(app.clone, ['add', 'README.md']);
  git(app.clone, ['commit', '--quiet', '-m', 'local commit']);
  const before = git(app.clone, ['rev-parse', 'HEAD']);
  const plan = reportIncomingChanges(app.io);
  const refused = spawnSync('git', ['merge', '--ff-only', plan.apply], {
    cwd: app.clone,
    encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0, 'a fast-forward-only merge must refuse');
  assert.equal(git(app.clone, ['rev-parse', 'HEAD']), before);
});

test('a remote that is behind this checkout is named, not announced as incoming', async (t) => {
  const app = await fixture(t);
  await writeFile(path.join(app.clone, 'README.md'), 'ahead\n');
  git(app.clone, ['add', 'README.md']);
  git(app.clone, ['commit', '--quiet', '-m', 'local commit']);
  const plan = reportIncomingChanges(app.io);
  assert.match(app.text(), /is not ahead of this checkout/);
  assert.doesNotMatch(app.text(), /incoming commit/);
  assert.ok(plan.apply, 'the fetched revision is still named');
});

test('a password in the remote URL is not printed', () => {
  assert.equal(
    redactRemoteUrl('https://someone:ghp_secret@github.com/org/repo.git'),
    'https://***@github.com/org/repo.git',
  );
});

test('a bare token in the remote URL is not printed', () => {
  const redacted = redactRemoteUrl(
    'https://ghp_secret@github.com/org/repo.git',
  );
  assert.doesNotMatch(redacted, /ghp_secret/);
  assert.match(redacted, /github\.com\/org\/repo\.git/);
});

test('an ordinary remote URL is printed unchanged', () => {
  const url = 'https://github.com/bilawalsidhu/gods-eye-view.git';
  assert.equal(redactRemoteUrl(url), url);
  assert.equal(
    redactRemoteUrl('git@github.com:bilawalsidhu/gods-eye-view.git'),
    'git@github.com:bilawalsidhu/gods-eye-view.git',
  );
  assert.equal(redactRemoteUrl(null), null);
  assert.equal(redactRemoteUrl(''), null);
});

test('a credential-bearing remote is redacted in the printed report', async (t) => {
  const app = await fixture(t);
  await app.push('second commit', 'second\n');
  reportIncomingChanges({
    ...app.io,
    read: (args) =>
      args[0] === 'remote'
        ? 'https://someone:ghp_secret@github.com/org/repo.git'
        : readGit(args, { cwd: app.clone }),
  });
  assert.doesNotMatch(app.text(), /ghp_secret/);
  assert.match(
    app.text(),
    /Fetching from https:\/\/\*\*\*@github\.com\/org\/repo\.git/,
  );
});

test('a failed git read is null, and an empty successful read is an empty string', async (t) => {
  const app = await fixture(t);
  assert.equal(
    readGit(['rev-parse', '--verify', 'refs/heads/absent'], { cwd: app.clone }),
    null,
  );
  assert.equal(
    readGit(['log', '--oneline', 'HEAD..HEAD'], { cwd: app.clone }),
    '',
  );
});

test('the update and reinstall stay behind the direct-invocation guard', () => {
  // Without the guard, importing this module to test it would update the
  // checkout and run npm ci as an import side effect.
  assert.match(
    source,
    /if \(isDirectInvocation\(process\.argv\[1\], MODULE_PATH\)\) \{/,
  );
  const guarded = source.slice(source.indexOf('if (isDirectInvocation('));
  assert.match(guarded, /updateFromRemote\(\);/);
  assert.match(guarded, /installPinokioDependencies\(\)/);
  // Order is the whole point of the fix: disclose and apply, then install.
  assert.ok(
    guarded.indexOf('updateFromRemote()') <
      guarded.indexOf('installPinokioDependencies()'),
    'the update must be disclosed and applied before dependencies are installed',
  );
});

test('the disclosed revision is applied by merge, not by a second pull', () => {
  const applier = source.slice(
    source.indexOf('export function updateFromRemote'),
  );
  assert.match(applier, /apply\(\['merge', '--ff-only', plan\.apply\]\)/);
  // The plain pull remains, but only on the path where nothing was disclosed.
  assert.match(
    applier,
    /else if \(plan\.fallback\) apply\(\['pull', '--ff-only'\]\)/,
  );
});
