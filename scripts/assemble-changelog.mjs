import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
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
 */
export const FRAGMENT_DIR = 'changelog.d';
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
 * Report or apply the pending fragments in `<root>/changelog.d`.
 *
 * The batch is validated in full before anything is written, so a malformed
 * filename or a duplicate pull request number leaves the directory untouched.
 *
 * @param {string} root repository root
 * @param {'--check'|'--write'} mode `--check` reports and changes nothing
 * @returns {Promise<{ consumed: string[], changelog: string }>}
 */
export async function assembleFragments(root, mode) {
  if (!['--check', '--write'].includes(mode)) {
    throw new Error(
      'Usage: node scripts/assemble-changelog.mjs --check|--write',
    );
  }
  const directory = path.join(root, FRAGMENT_DIR);
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const consumed = orderFragmentNames(await readdir(directory));
  const bodies = [];
  for (const name of consumed) {
    bodies.push(await readFile(path.join(directory, name), 'utf8'));
  }
  const changelog = assembleChangelog(
    await readFile(changelogFile, 'utf8'),
    bodies,
  );
  if (mode === '--write' && consumed.length) {
    await writeFile(changelogFile, changelog, 'utf8');
    for (const name of consumed) await rm(path.join(directory, name));
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
