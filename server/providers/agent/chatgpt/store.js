import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hardenCredentialFile,
  verifyWindowsCredentialAcl,
} from '../../common/credential-file.mjs';

/** GEV owns these records; never read or overwrite another app's OAuth store. */
export function createChatGptStore({
  directory = path.join(os.homedir(), '.config', 'gods-eye-view', 'chatgpt'),
  platform = process.platform,
  fileSystem = fs,
  harden = (file) => hardenCredentialFile(file, { platform }),
  verifyAcl = verifyWindowsCredentialAcl,
  lockTimeoutMs = 30_000,
} = {}) {
  const filename = path.join(directory, 'accounts.json');
  const lockfile = path.join(directory, 'accounts.lock');
  let queue = Promise.resolve();

  // Windows file IDs can exceed Number's exact integer range.
  const statOptions = { bigint: true };
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

  function checkOwner(stat) {
    if (
      platform !== 'win32' &&
      (stat.mode & 0o077n || stat.uid !== BigInt(process.getuid()))
    )
      throw new Error('ChatGPT credentials require owner-only permissions.');
  }

  function checkAcl(file) {
    // Never repair an existing ACL here: a permissive file may already have
    // exposed tokens. Missing tools and unverifiable permissions also refuse use.
    if (platform === 'win32' && !verifyAcl(file))
      throw new Error('Cannot verify private ChatGPT credential permissions.');
  }

  function checkFile(file, fd) {
    const stat = fileSystem.lstatSync(file, statOptions);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size > 1024n * 1024n
    )
      throw new Error('Unsafe ChatGPT credential file.');
    checkOwner(stat);
    if (
      fd !== undefined &&
      !sameFile(stat, fileSystem.fstatSync(fd, statOptions))
    )
      throw new Error('ChatGPT credential file changed during access.');
    return stat;
  }

  function checkDirectory() {
    const stat = fileSystem.lstatSync(directory, statOptions);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe ChatGPT credential directory.');
    checkOwner(stat);
    checkAcl(directory);
    if (!sameFile(stat, fileSystem.lstatSync(directory, statOptions)))
      throw new Error('ChatGPT credential directory changed during access.');
  }

  function exists(file) {
    try {
      fileSystem.lstatSync(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function read() {
    if (!exists(directory)) return null;
    checkDirectory();
    if (!exists(filename)) return null;
    checkFile(filename);
    const fd = fileSystem.openSync(
      filename,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const before = checkFile(filename, fd);
      checkAcl(filename);
      checkFile(filename, fd);
      const content = fileSystem.readFileSync(fd, 'utf8');
      const after = checkFile(filename, fd);
      if (
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error('ChatGPT credential file changed during access.');
      const data = JSON.parse(content);
      if (data.version !== 1 || !Array.isArray(data.accounts) || !data.hostId)
        throw new Error('Invalid ChatGPT credential store.');
      return data;
    } finally {
      fileSystem.closeSync(fd);
    }
  }

  function prepareDirectory() {
    const created = fileSystem.mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    });
    // Only a newly created, empty directory may be hardened automatically.
    // Existing installations must not silently normalize evidence of exposure.
    if (created !== undefined && platform === 'win32' && !harden(directory))
      throw new Error('Cannot protect ChatGPT credential directory.');
    checkDirectory();
  }

  function write(data) {
    // Validate the destination before replacing it. A fresh, hardened empty
    // file prevents Windows inherited ACLs exposing even the first write.
    checkDirectory();
    if (exists(filename)) {
      checkFile(filename);
      checkAcl(filename);
    }
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const fd = fileSystem.openSync(temporary, 'wx', 0o600);
    const identity = fileSystem.fstatSync(fd, statOptions);
    try {
      try {
        if (!harden(temporary))
          throw new Error('Cannot protect ChatGPT credentials.');
        checkFile(temporary, fd);
        fileSystem.writeFileSync(fd, JSON.stringify(data));
        fileSystem.fsyncSync(fd);
        checkAcl(temporary);
        checkFile(temporary, fd);
      } finally {
        fileSystem.closeSync(fd);
      }
      fileSystem.renameSync(temporary, filename);
    } finally {
      removeOwnedFile(temporary, identity);
    }
  }

  function removeOwnedFile(file, identity) {
    if (
      exists(file) &&
      sameFile(identity, fileSystem.lstatSync(file, statOptions))
    )
      fileSystem.rmSync(file);
  }

  async function locked(update) {
    prepareDirectory();
    const deadline = Date.now() + lockTimeoutMs;
    let fd;
    while (fd === undefined) {
      checkDirectory();
      try {
        fd = fileSystem.openSync(lockfile, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Never steal a lock while another process may be rotating a token.
        if (Date.now() >= deadline)
          throw new Error('ChatGPT credentials are busy.');
        await delay(25);
      }
    }
    const identity = fileSystem.fstatSync(fd, statOptions);
    try {
      if (!harden(lockfile))
        throw new Error('Cannot protect ChatGPT credential lock.');
      checkFile(lockfile, fd);
      const data = read() || {
        version: 1,
        hostId: `urn:uuid:${randomUUID()}`,
        binding: randomUUID(),
        active: null,
        accounts: [],
      };
      const result = await update(data);
      // The callback may await a remote refresh. Recheck after that gap, and
      // never publish or remove a lock that has been replaced by another actor.
      checkFile(lockfile, fd);
      checkAcl(lockfile);
      write(data);
      return result;
    } finally {
      fileSystem.closeSync(fd);
      removeOwnedFile(lockfile, identity);
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
