#!/usr/bin/env node
/**
 * Pinokio "Update": disclose what is about to land, then fast-forward and reinstall.
 *
 * Update is a fixed menu item aimed at people who only want to run the app, and
 * it executes install scripts from whatever the configured remote serves. It
 * cannot ask for confirmation — Pinokio drives it non-interactively — so the
 * safety it can offer is disclosure: fetch once, print the remote it fetched
 * from plus the incoming commits and their diffstat, and then apply that exact
 * revision. Someone who sees an unfamiliar remote or an unexpected set of
 * commits can close the window before any install script runs.
 *
 * @module scripts/pinokio-update
 */
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installPinokioDependencies,
  isDirectInvocation,
  runChecked,
} from './pinokio-install.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));

/**
 * Read a git value.
 *
 * @param {string[]} args - git arguments.
 * @param {object} [options]
 * @param {string} [options.cwd] - Repository to read.
 * @returns {string|null} Trimmed stdout, `''` when git succeeded with no
 *   output, or null when git failed (no upstream, detached HEAD, not a
 *   checkout). Callers must keep those two apart: an empty range and an
 *   unreadable one mean very different things to someone about to install.
 */
export function readGit(args, { cwd = ROOT } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Remove credentials from a remote URL before it is printed.
 *
 * A remote can carry a password or an access token in its userinfo
 * (`https://token@host/org/repo.git`) or in a query parameter
 * (`?access_token=…`). The point of printing the remote is to show WHERE the
 * update comes from, which the host and path already say — so the userinfo is
 * replaced and the query string and fragment are dropped whole, rather than
 * matched against a list of parameter names that would miss the next one.
 *
 * A secret spelled as an ordinary path segment is not detected; nothing here
 * can tell one of those from a repository name.
 *
 * @param {string|null|undefined} url - Remote URL as git reports it.
 * @returns {string|null} Printable URL, or null when there is nothing to print.
 */
export function redactRemoteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: scp-style `git@host:org/repo.git`, or a local path. Neither
    // has a userinfo field to hide.
    return url;
  }
  const hadUserinfo = Boolean(parsed.username || parsed.password);
  const hadQuery = Boolean(parsed.search || parsed.hash);
  if (!hadUserinfo && !hadQuery) return url;
  parsed.password = '';
  if (hadUserinfo) parsed.username = '***';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Print the remote, the commits about to be applied, and their diffstat.
 *
 * @param {object} [io] - Injection seam for tests.
 * @param {string} [io.cwd] - Repository to inspect.
 * @param {(line: string) => void} [io.log] - Normal output.
 * @param {(line: string) => void} [io.warn] - Degraded-path output.
 * @param {(remote: string) => void} [io.fetchRemote] - Fetch step; throws or
 *   exits on failure, because a report built on a stale remote ref describes
 *   the wrong changes.
 * @param {(args: string[]) => (string|null)} [io.read] - git reader.
 * @returns {{apply: string|null, fallback: boolean, stopped?: boolean}}
 *   `apply` is the exact revision that was disclosed and must now be applied.
 *   `fallback` asks the caller to run the plain pull so git itself reports
 *   whatever went wrong, and is only ever set before anything has been fetched.
 *   `stopped` means the update gave up: nothing can be shown, so nothing is
 *   applied.
 */
export function reportIncomingChanges(io = {}) {
  const {
    cwd = ROOT,
    log = (line) => console.log(line),
    warn = (line) => console.warn(line),
    fetchRemote = (remote) => runChecked('git', ['fetch', '--quiet', remote]),
    read = (args) => readGit(args, { cwd }),
  } = io;

  const upstream = read([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  // The full ref name is what later reads resolve, so a remote whose own name
  // contains a slash (`team/origin`) cannot be mistaken for a path segment.
  const upstreamRef = read(['rev-parse', '--symbolic-full-name', '@{u}']);
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote =
    branch && branch !== 'HEAD'
      ? read(['config', '--get', `branch.${branch}.remote`])
      : null;
  if (!upstream || !upstreamRef || !remote) {
    warn('[update] No upstream branch is configured — cannot preview changes.');
    warn('[update] Continuing; `git pull --ff-only` will report the problem.');
    return { apply: null, fallback: true };
  }

  log(`[update] Tracking ${upstream}`);
  if (remote === '.') {
    // The upstream is another branch in this same checkout; there is nothing
    // to fetch and no remote URL to disclose.
    log('[update] Upstream is a local branch — nothing to fetch.');
  } else {
    const url = redactRemoteUrl(read(['remote', 'get-url', remote]));
    log(`[update] Fetching from ${url || remote}`);
    // Fetch once, here. Everything below describes and then applies the
    // revision this fetch brought in; a second fetch inside `git pull` could
    // apply something newer than what was printed.
    fetchRemote(remote);
  }

  const target = read(['rev-parse', upstreamRef]);
  const head = read(['rev-parse', 'HEAD']);
  if (!target || !head) {
    // Stop. Falling through to `git pull` here would fetch a second time and
    // could install a revision this run never resolved, let alone disclosed.
    warn(`[update] Could not resolve ${upstream} after fetching.`);
    warn(
      '[update] Stopping: nothing is applied, because nothing can be shown.',
    );
    return { apply: null, fallback: false, stopped: true };
  }
  if (target === head) {
    log('[update] Already up to date — reinstalling dependencies only.');
    return { apply: null, fallback: false };
  }

  const commits = read([
    'log',
    '--oneline',
    '--no-decorate',
    `${head}..${target}`,
  ]);
  if (commits === null) {
    // A read that failed is not an empty range. Saying "up to date" here would
    // tell someone nothing is arriving while a revision is about to be applied.
    warn(`[update] Could not list the commits in ${head}..${target}.`);
    warn(
      `[update] Applying ${target} anyway; it is the revision that was fetched.`,
    );
    return { apply: target, fallback: false };
  }

  const lines = commits.length > 0 ? commits.split('\n') : [];
  if (lines.length > 0) {
    log(`\n[update] ${lines.length} incoming commit(s):`);
    for (const line of lines) log(`  ${line}`);
  } else {
    log(
      `\n[update] ${upstream} is at ${target}, which is not ahead of this checkout.`,
    );
  }

  const stat = read(['diff', '--stat', `${head}..${target}`]);
  if (stat === null) {
    warn(`[update] Could not read the diffstat for ${head}..${target}.`);
  } else if (stat) {
    log('\n[update] Files affected:');
    for (const line of stat.split('\n')) log(`  ${line}`);
  }
  log(`\n[update] Applying ${target}, then reinstalling dependencies.\n`);
  return { apply: target, fallback: false };
}

/**
 * Disclose, then apply exactly what was disclosed.
 *
 * @param {object} [io] - Same seam as {@link reportIncomingChanges}, plus
 *   `apply`, which runs one git command and must fail loudly.
 * @returns {{apply: string|null, fallback: boolean}} What the report decided.
 */
export function updateFromRemote(io = {}) {
  const { apply = (args) => runChecked('git', args) } = io;
  const plan = reportIncomingChanges(io);
  // `merge --ff-only <revision>` applies the object the report named. A second
  // `pull` would fetch again and could land a different one.
  if (plan.apply) apply(['merge', '--ff-only', plan.apply]);
  else if (plan.fallback) apply(['pull', '--ff-only']);
  return plan;
}

/**
 * What running this script does: disclose, apply, install.
 *
 * @param {object} [io] - The seam above, plus `install` and `fail`.
 * @returns {{apply: string|null, fallback: boolean, stopped?: boolean}} The plan.
 */
export function runPinokioUpdate(io = {}) {
  const {
    install = installPinokioDependencies,
    fail = (code) => process.exit(code),
  } = io;
  const plan = updateFromRemote(io);
  if (plan.stopped) {
    // Nothing could be shown, so nothing was applied. Reinstalling now would
    // run install scripts under the banner of an update that did not happen,
    // and report success for it.
    fail(1);
    return plan;
  }
  install();
  return plan;
}

// Guarded like pinokio-start.mjs so the report above can be exercised without
// pulling and reinstalling as an import side effect.
if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  runPinokioUpdate();
}
