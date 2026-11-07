import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Release-time assembly of changelog fragments.
 *
 * A pull request adds `changelog.d/<pull request>-<slug>.md` instead of editing
 * `CHANGELOG.md`. Distinct filenames never conflict, so two pull requests in
 * flight no longer write into the same few lines at the top of one file. A
 * release splices the fragments in and empties the directory.
 *
 * Fragment text is copied through unchanged apart from trailing whitespace:
 * `src/annotations/drawTool.test.mjs` reads `CHANGELOG.md` as prose and slices a
 * fixed window after a heading, so reflowing an entry here could move text
 * across that window.
 *
 * A write is staged so that a failure at any point leaves a rerun unable to
 * duplicate or lose an entry. The assembled file is written into
 * `changelog.d/.assembling/` first, the fragments are renamed in beside it, and
 * renaming the assembled file over `CHANGELOG.md` is the single commit point.
 * While the assembled file is still staged the batch has not landed, so
 * recovery moves the fragments back; once it is gone the batch has landed, and
 * the staged fragments are leftovers to delete. Either way they are out of the
 * input directory, so they are never assembled twice.
 */
export const FRAGMENT_DIR = 'changelog.d';
export const STAGING_DIR = '.assembling';
const STAGED_CHANGELOG = 'CHANGELOG.md';
const FRAGMENT_NAME = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADING = '# Changelog\n';

/** Fragment file names a release may consume, highest pull request first. */
export function orderFragmentNames(names) {
  const claimed = new Map();
  for (const name of names) {
    if (name === 'README.md') continue;
    const match = FRAGMENT_NAME.exec(name);
    if (!match) {
      throw new Error(
        `Unexpected file in ${FRAGMENT_DIR}/: ${name}` +
          ' — expected <pull request>-<slug>.md with a lowercase slug',
      );
    }
    const number = Number(match[1]);
    const prior = claimed.get(number);
    if (prior) {
      throw new Error(
        `Two fragments claim pull request ${number}: ${prior} and ${name}`,
      );
    }
    claimed.set(number, name);
  }
  return [...claimed.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, name]) => name);
}

/** Splice fragment bodies above the existing entries, newest batch on top. */
export function assembleChangelog(changelog, fragments) {
  if (!fragments.length) return changelog;
  if (!changelog.startsWith(HEADING)) {
    throw new Error('CHANGELOG.md must start with "# Changelog"');
  }
  const entries = changelog.slice(HEADING.length).replace(/^\n+/, '');
  const batch = fragments.map((text) => text.replace(/\s+$/, '')).join('\n\n');
  return `${HEADING}\n${batch}\n\n${entries}`;
}

/**
 * Finish or roll back a batch an earlier `--write` left in the staging
 * directory. A no-op when there is none.
 *
 * @returns {Promise<'none'|'rolled-back'|'cleaned-up'>}
 */
export async function recoverInterruptedBatch(root, io = fs) {
  const directory = path.join(root, FRAGMENT_DIR);
  const staging = path.join(directory, STAGING_DIR);
  let staged;
  try {
    staged = await io.readdir(staging);
  } catch (error) {
    if (error.code === 'ENOENT') return 'none';
    throw error;
  }
  if (!staged.includes(STAGED_CHANGELOG)) {
    // The assembled file was renamed over CHANGELOG.md: the batch landed.
    await io.rm(staging, { recursive: true, force: true });
    return 'cleaned-up';
  }
  // The batch never reached CHANGELOG.md, so every fragment goes back.
  const pending = new Set(await io.readdir(directory));
  const fragments = staged.filter((name) => name !== STAGED_CHANGELOG);
  const clash = fragments.filter((name) => pending.has(name));
  if (clash.length) {
    throw new Error(
      `Cannot roll back ${FRAGMENT_DIR}/${STAGING_DIR}/: ${clash.join(', ')}` +
        ` also exist in ${FRAGMENT_DIR}/ — resolve by hand`,
    );
  }
  for (const name of fragments) {
    await io.rename(path.join(staging, name), path.join(directory, name));
  }
  await io.rm(staging, { recursive: true, force: true });
  return 'rolled-back';
}

/**
 * Report or apply the pending fragments in `<root>/changelog.d`.
 *
 * The batch is validated in full before anything is written, so a malformed
 * filename or a duplicate pull request number leaves the directory untouched.
 * `--write` first recovers any batch an interrupted run left staged.
 *
 * @param {string} root repository root
 * @param {'--check'|'--write'} mode `--check` reports and changes nothing
 * @param {typeof fs} [io] filesystem calls, replaceable for failure injection
 * @returns {Promise<{ consumed: string[], changelog: string }>}
 */
export async function assembleFragments(root, mode, io = fs) {
  if (!['--check', '--write'].includes(mode)) {
    throw new Error(
      'Usage: node scripts/assemble-changelog.mjs --check|--write',
    );
  }
  const directory = path.join(root, FRAGMENT_DIR);
  const staging = path.join(directory, STAGING_DIR);
  const changelogFile = path.join(root, 'CHANGELOG.md');
  if (mode === '--write') {
    await recoverInterruptedBatch(root, io);
  }
  const names = await io.readdir(directory);
  if (names.includes(STAGING_DIR)) {
    throw new Error(
      `${FRAGMENT_DIR}/${STAGING_DIR}/ holds a batch an interrupted release` +
        ' left behind — `npm run changelog` finishes or rolls it back',
    );
  }
  const consumed = orderFragmentNames(names);
  const bodies = [];
  for (const name of consumed) {
    bodies.push(await io.readFile(path.join(directory, name), 'utf8'));
  }
  const changelog = assembleChangelog(
    await io.readFile(changelogFile, 'utf8'),
    bodies,
  );
  if (mode === '--write' && consumed.length) {
    try {
      await io.mkdir(staging);
      await io.writeFile(
        path.join(staging, STAGED_CHANGELOG),
        changelog,
        'utf8',
      );
      for (const name of consumed) {
        await io.rename(path.join(directory, name), path.join(staging, name));
      }
      await io.rename(path.join(staging, STAGED_CHANGELOG), changelogFile);
      await io.rm(staging, { recursive: true, force: true });
    } catch (error) {
      try {
        await recoverInterruptedBatch(root, io);
      } catch {
        throw new Error(
          `${error.message} — the batch is staged in ${FRAGMENT_DIR}/${STAGING_DIR}/,` +
            ' and the next `npm run changelog` finishes or rolls it back',
          { cause: error },
        );
      }
      throw error;
    }
  }
  return { consumed, changelog };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    if (process.argv.length !== 3) {
      throw new Error(
        'Usage: node scripts/assemble-changelog.mjs --check|--write',
      );
    }
    const mode = process.argv[2];
    const { consumed } = await assembleFragments(
      fileURLToPath(new URL('../', import.meta.url)),
      mode,
    );
    if (!consumed.length) {
      console.log(`No fragments in ${FRAGMENT_DIR}/.`);
    } else {
      console.log(
        `${mode === '--write' ? 'Assembled' : 'Would assemble'} ${consumed.length} fragment(s), in order:` +
          `\n  ${consumed.join('\n  ')}`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
