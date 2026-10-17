import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Where the install's panel key lives: beside the other local state, which
 * git ignores, at the checkout root rather than the client's working
 * directory (an MCP client may start the server anywhere). */
export const DEFAULT_PANEL_KEY_FILE = fileURLToPath(
  new URL('../../.gev-cache/mcp-panel-key', import.meta.url),
);

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const newKey = () => randomBytes(32).toString('base64url');
const notShared = (error) =>
  `panel key not shared (${error.code || error.message}); using a key of this process`;

function readKey(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  return KEY_PATTERN.test(text) ? text : null;
}

/** Serialize malformed-file repair; ordinary first creation still uses link(). */
function repairKey(file, tmp, key) {
  const lock = `${file}.repair-lock`;
  const deadline = Date.now() + 2000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another repair may already have published a usable key.
      const winner = readKey(file);
      if (winner) return winner;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('panel key repair is busy'), {
          code: 'ETIMEDOUT',
        });
      }
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try {
    // A repair completed between our earlier read and acquiring the lock.
    const winner = readKey(file);
    if (winner) return winner;
    fs.renameSync(tmp, file);
    return key;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/**
 * The panel key every stdio server of this install shares.
 *
 * A client can start more than one server process for one connection: Claude
 * Desktop was reported to start two processes; serving the panel's page from
 * one and sending its `panel_request` calls to the other reproduces #927.
 * Per-process keys then mismatch, and the panel refuses the request.
 * The first process to run creates the key, without replacing one
 * another process created at the same moment; the rest read it. When the file
 * cannot be read or written, or repair stays busy for two seconds, the process
 * falls back to its own key, as every process did before.
 *
 * As before, the key keeps `panel_request` from clients that only list it; it
 * is not access control.
 *
 * @param {{ file?: string, log?: (line: string) => void }} [options]
 * @returns {string}
 */
export function sharedPanelKey({
  file = DEFAULT_PANEL_KEY_FILE,
  log = () => {},
} = {}) {
  try {
    const existing = readKey(file);
    if (existing) return existing;
    // Present but not a key: replace it below.
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log(notShared(error));
      return newKey();
    }
  }
  const key = newKey();
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    fs.writeFileSync(tmp, `${key}\n`, { flag: 'wx', mode: 0o600 });
    try {
      // link() publishes the whole file at once and fails if another process
      // got there first, so a reader never sees a half-written key and two
      // processes starting together cannot end up with different keys.
      fs.linkSync(tmp, file);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = readKey(file);
      if (winner) return winner;
      return repairKey(file, tmp, key);
    }
  } catch (error) {
    log(notShared(error));
    return key;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
