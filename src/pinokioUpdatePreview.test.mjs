import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../scripts/pinokio-update.mjs', import.meta.url),
  'utf8',
);

/**
 * Lift the reporter out of the launcher script.
 *
 * Same approach as src/proxyErrorResponses.test.mjs: the module pulls and
 * reinstalls when run directly, so the reporter is extracted and driven over
 * injected git output rather than imported and pointed at a real remote.
 *
 * @param {object} deps - Injected `readGit`, `runChecked`, and `console`.
 * @returns {() => boolean} The reporter under test.
 */
function reporter(deps) {
  const start = source.search(/export function reportIncomingChanges\(/);
  assert.ok(start >= 0, 'reportIncomingChanges must exist');
  const body = source.slice(start, source.indexOf('\n}', start) + 2).replace(/^export /, '');
  return new Function(
    'readGit',
    'runChecked',
    'console',
    `${body}\nreturn reportIncomingChanges;`,
  )(deps.readGit, deps.runChecked, deps.console);
}

/** Collects printed lines and git invocations in call order. */
function harness(gitResponses) {
  const out = [];
  const calls = [];
  const readGit = (args) => {
    calls.push(`read:${args.join(' ')}`);
    for (const [match, value] of gitResponses) {
      if (args.join(' ').includes(match)) return value;
    }
    return null;
  };
  return {
    out,
    calls,
    run: reporter({
      readGit,
      runChecked: (command, args) => calls.push(`run:${command} ${args.join(' ')}`),
      console: { log: (line) => out.push(String(line)), warn: (line) => out.push(String(line)) },
    }),
    text: () => out.join('\n'),
  };
}

const TRACKING = ['rev-parse --abbrev-ref --symbolic-full-name @{u}', 'origin/main'];
const REMOTE = ['remote get-url', 'https://github.com/bilawalsidhu/gods-eye-view.git'];

test('a missing upstream degrades the preview instead of blocking the update', () => {
  const app = harness([]);
  assert.equal(app.run(), true, 'the update must still proceed');
  assert.match(app.text(), /No upstream branch is configured/);
  assert.ok(!app.calls.some((c) => c.startsWith('run:')), 'nothing is fetched without an upstream');
});

test('the incoming commits, their diffstat, and the remote are printed before anything runs', () => {
  const app = harness([
    TRACKING,
    REMOTE,
    ['log --oneline', 'abc1234 feat: something new\ndef5678 fix: something else'],
    ['diff --stat', ' README.md | 2 +-\n 1 file changed'],
  ]);

  assert.equal(app.run(), true);
  const text = app.text();
  // The remote is the disclosure that matters: the threat in #266 is a
  // repointed origin, which is invisible unless the URL is shown.
  assert.match(text, /Fetching from https:\/\/github\.com\/bilawalsidhu\/gods-eye-view\.git/);
  assert.match(text, /2 incoming commit\(s\)/);
  assert.match(text, /abc1234 feat: something new/);
  assert.match(text, /def5678 fix: something else/);
  assert.match(text, /README\.md \| 2 \+-/);

  // Fetch must precede the diff, or the report describes a stale remote ref.
  const fetchAt = app.calls.findIndex((c) => c === 'run:git fetch --quiet origin');
  const logAt = app.calls.findIndex((c) => c.startsWith('read:log --oneline'));
  assert.ok(fetchAt >= 0, 'the remote is fetched');
  assert.ok(fetchAt < logAt, 'fetch happens before the commit range is read');
});

test('an up-to-date checkout says so and reports nothing to apply', () => {
  const app = harness([TRACKING, REMOTE]);
  assert.equal(app.run(), false);
  assert.match(app.text(), /Already up to date/);
});

test('the pull and reinstall stay behind the direct-invocation guard', () => {
  // Without the guard, importing this module to test it would pull and run
  // npm ci as an import side effect.
  assert.match(source, /if \(isDirectInvocation\(process\.argv\[1\], MODULE_PATH\)\) \{/);
  const guarded = source.slice(source.indexOf('if (isDirectInvocation('));
  assert.match(guarded, /reportIncomingChanges\(\);/);
  assert.match(guarded, /runChecked\('git', \['pull', '--ff-only'\]\)/);
  assert.match(guarded, /installPinokioDependencies\(\)/);
  // Order is the whole point of the fix: disclose, then pull, then install.
  assert.ok(
    guarded.indexOf('reportIncomingChanges()') < guarded.indexOf("'pull', '--ff-only'"),
    'the report precedes the pull',
  );
  assert.ok(
    guarded.indexOf("'pull', '--ff-only'") < guarded.indexOf('installPinokioDependencies()'),
    'the pull precedes the reinstall',
  );
});
