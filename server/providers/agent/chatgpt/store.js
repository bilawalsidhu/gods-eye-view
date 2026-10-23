import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hardenCredentialFile } from '../../common/credential-file.mjs';

/** GEV owns these records; never read or overwrite another app's OAuth store. */
export function createChatGptStore({
  directory = path.join(os.homedir(), '.config', 'gods-eye-view', 'chatgpt'),
  harden = hardenCredentialFile,
  lockTimeoutMs = 30_000,
} = {}) {
  const filename = path.join(directory, 'accounts.json');
  const lockfile = path.join(directory, 'accounts.lock');
  let queue = Promise.resolve();

  function checkFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Unsafe ChatGPT credential file.');
    if (
      process.platform !== 'win32' &&
      (stat.mode & 0o077 || stat.uid !== process.getuid())
    )
      throw new Error('ChatGPT credentials require owner-only permissions.');
  }

  function read() {
    try {
      const entry = fs.lstatSync(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Unsafe ChatGPT credential directory.');
      checkFile(filename);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.accounts) || !data.hostId)
      throw new Error('Invalid ChatGPT credential store.');
    return data;
  }

  function prepareDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe ChatGPT credential directory.');
    if (process.platform !== 'win32') {
      if (stat.uid !== process.getuid())
        throw new Error('Wrong credential owner.');
      fs.chmodSync(directory, 0o700);
    }
  }

  function write(data) {
    // Validate the destination before replacing it. A fresh, hardened empty
    // file prevents Windows inherited ACLs exposing even the first write.
    if (fs.existsSync(filename)) checkFile(filename);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        if (!harden(temporary))
          throw new Error('Cannot protect ChatGPT credentials.');
        fs.writeFileSync(fd, JSON.stringify(data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function locked(update) {
    prepareDirectory();
    const deadline = Date.now() + lockTimeoutMs;
    let fd;
    while (fd === undefined) {
      try {
        fd = fs.openSync(lockfile, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Never steal a lock while another process may be rotating a token.
        if (Date.now() >= deadline)
          throw new Error('ChatGPT credentials are busy.');
        await delay(25);
      }
    }
    try {
      const data = read() || {
        version: 1,
        hostId: `urn:uuid:${randomUUID()}`,
        binding: randomUUID(),
        active: null,
        accounts: [],
      };
      const result = await update(data);
      write(data);
      return result;
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lockfile, { force: true });
    }
  }

  return {
    read,
    /** Serialize both in-process and cross-process rotating-token updates. */
    transaction(update) {
      const result = queue.then(() => locked(update));
      queue = result.catch(() => {});
      return result;
    },
  };
}
