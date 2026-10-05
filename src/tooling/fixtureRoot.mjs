import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Create a temporary directory for a test fixture, resolved to its physical
 * path.
 *
 * The system temp directory is reached through a symlink on macOS
 * (`/var` -> `/private/var`, `/tmp` -> `/private/tmp`). A test that gives the
 * logical path to something that reports paths back — a launched process's
 * working directory, a bundler's project root — then compares two spellings of
 * the same directory and fails. Resolving the root once, here, keeps both sides
 * on the physical path.
 *
 * @param {string} prefix - Directory name prefix, e.g. `gev-preview-`.
 * @returns {Promise<string>} The fixture root, with no symlinked component.
 */
export async function makeFixtureRoot(prefix) {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}
