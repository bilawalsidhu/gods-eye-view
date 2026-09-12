#!/usr/bin/env node
/**
 * Pinokio "Update": disclose what is about to land, then fast-forward and reinstall.
 *
 * Update is a fixed menu item aimed at people who only want to run the app, and
 * it executes install scripts from whatever the configured remote serves. It
 * cannot ask for confirmation — Pinokio drives it non-interactively — so the
 * safety it can offer is disclosure: fetch first, print the remote it fetched
 * from plus the incoming commits and their diffstat, and only then pull and
 * reinstall. Someone who sees an unfamiliar remote or an unexpected set of
 * commits can close the window before any install script runs.
 *
 * @module scripts/pinokio-update
 */
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPinokioDependencies, isDirectInvocation, runChecked } from './pinokio-install.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));

/**
 * Read a git value from the repository root.
 *
 * @param {string[]} args - git arguments.
 * @returns {string|null} Trimmed stdout, or null when git failed (no upstream,
 *   detached HEAD, not a checkout) — every caller treats null as "unknown"
 *   rather than fatal, so a missing upstream degrades the report instead of
 *   blocking the update.
 */
export function readGit(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Print the remote, the commits about to be applied, and their diffstat.
 *
 * @returns {boolean} True when there is something to pull.
 */
export function reportIncomingChanges() {
  const upstream = readGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) {
    console.warn('[update] No upstream branch is configured — cannot preview changes.');
    console.warn('[update] Continuing; `git pull --ff-only` will report the problem.');
    return true;
  }

  const remote = upstream.split('/')[0];
  const url = readGit(['remote', 'get-url', remote]);
  console.log(`[update] Tracking ${upstream}`);
  console.log(`[update] Fetching from ${url || remote}`);
  // Fetch before diffing, and fail loudly: a report built on a stale remote ref
  // would describe the wrong changes.
  runChecked('git', ['fetch', '--quiet', remote]);

  const commits = readGit(['log', '--oneline', '--no-decorate', `HEAD..${upstream}`]);
  if (!commits) {
    console.log('[update] Already up to date — reinstalling dependencies only.');
    return false;
  }

  const lines = commits.split('\n');
  console.log(`\n[update] ${lines.length} incoming commit(s):`);
  for (const line of lines) console.log(`  ${line}`);

  const stat = readGit(['diff', '--stat', `HEAD..${upstream}`]);
  if (stat) {
    console.log('\n[update] Files affected:');
    for (const line of stat.split('\n')) console.log(`  ${line}`);
  }
  console.log('\n[update] Applying the changes above, then reinstalling dependencies.\n');
  return true;
}

// Guarded like pinokio-start.mjs so the report above can be exercised without
// pulling and reinstalling as an import side effect.
if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  reportIncomingChanges();
  runChecked('git', ['pull', '--ff-only']);
  installPinokioDependencies();
}
