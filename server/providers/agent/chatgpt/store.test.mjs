import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { createChatGptStore } from './store.js';
import { verifyWindowsCredentialAcl } from '../../common/credential-file.mjs';

const identity = (file) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};

function fixture(t, { windows = false, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-chatgpt-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'chatgpt');
  const filename = path.join(directory, 'accounts.json');
  const lockfile = path.join(directory, 'accounts.lock');
  const privateEntries = new Set();
  const checked = [];
  const hardened = [];
  let reads = 0;
  const dependencies = {
    directory,
    ...(windows
      ? {
          platform: 'win32',
          harden(file) {
            hardened.push(file);
            privateEntries.add(identity(file));
            return true;
          },
          verifyAcl(file) {
            checked.push(file);
            return privateEntries.has(identity(file));
          },
        }
      : {}),
    fileSystem: {
      ...fs,
      readFileSync(...args) {
        reads += 1;
        return fs.readFileSync(...args);
      },
    },
    ...options,
  };
  return {
    root,
    directory,
    filename,
    lockfile,
    dependencies,
    privateEntries,
    checked,
    hardened,
    get reads() {
      return reads;
    },
    store: createChatGptStore(dependencies),
  };
}

const seed = (store) =>
  store.transaction((data) => {
    data.accounts = [
      { id: 'fixture-account', tokens: { refresh_token: 'synthetic-secret' } },
    ];
    data.counter = 0;
  });

test('an absent GEV store never imports or modifies neighboring Codex/API credentials', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.codex'));
  const codex = path.join(f.root, '.codex', 'auth.json');
  const api = path.join(f.root, '.env');
  fs.writeFileSync(codex, 'codex-only-fixture');
  fs.writeFileSync(api, 'OPENAI_API_KEY=api-only-fixture');
  assert.equal(f.store.read(), null);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(f.reads, 0);
  await seed(f.store);
  assert.equal(
    f.store.read().accounts[0].tokens.refresh_token,
    'synthetic-secret',
  );
  assert.equal(fs.readFileSync(codex, 'utf8'), 'codex-only-fixture');
  assert.equal(fs.readFileSync(api, 'utf8'), 'OPENAI_API_KEY=api-only-fixture');
  assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
});

test('simulated Windows re-verifies existing directory and file ACLs on every read without repairing them', async (t) => {
  const f = fixture(t, { windows: true });
  await seed(f.store);
  const hardened = [...f.hardened];
  f.checked.length = 0;
  f.store.read();
  f.store.read();
  assert.deepEqual(f.checked, [
    f.directory,
    f.filename,
    f.directory,
    f.filename,
  ]);
  assert.deepEqual(f.hardened, hardened);
  const previous = fs.readFileSync(f.filename, 'utf8');
  f.privateEntries.delete(identity(f.filename));
  const reads = f.reads;
  assert.throws(() => f.store.read(), /permissions/);
  let updated = false;
  await assert.rejects(
    f.store.transaction(() => {
      updated = true;
    }),
    /permissions/,
  );
  assert.equal(updated, false);
  assert.equal(
    f.reads,
    reads,
    'no credential bytes may be read after failed verification',
  );
  assert.equal(f.privateEntries.has(identity(f.filename)), false);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), previous);
  assert.equal(f.hardened.includes(f.filename), false);
  assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
});

test('simulated Windows rejects an unsafe existing directory even when the account file is absent', async (t) => {
  const f = fixture(t, { windows: true });
  fs.mkdirSync(f.directory);
  assert.throws(() => f.store.read(), /permissions/);
  await assert.rejects(seed(f.store), /permissions/);
  assert.equal(
    f.hardened.length,
    0,
    'existing directories are not silently repaired',
  );
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a verifier exception, including ENOENT, is not mistaken for an absent store', async (t) => {
  const f = fixture(t, { windows: true });
  await seed(f.store);
  const store = createChatGptStore({
    ...f.dependencies,
    verifyAcl() {
      throw Object.assign(new Error('verifier unavailable'), {
        code: 'ENOENT',
      });
    },
  });
  assert.throws(() => store.read(), /verifier unavailable/);
  await assert.rejects(seed(store), /verifier unavailable/);
});

for (const target of ['file', 'directory']) {
  test(
    `POSIX rejects broadened ${target} permissions without normalizing them`,
    {
      skip: process.platform === 'win32',
    },
    async (t) => {
      const f = fixture(t);
      await seed(f.store);
      const file = target === 'file' ? f.filename : f.directory;
      const mode = target === 'file' ? 0o644 : 0o755;
      fs.chmodSync(file, mode);
      const reads = f.reads;
      assert.throws(() => f.store.read(), /owner-only/);
      await assert.rejects(seed(f.store), /owner-only/);
      assert.equal(f.reads, reads);
      assert.equal(fs.statSync(file).mode & 0o777, mode);
      assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
    },
  );
}

for (const stage of ['directory', 'lock', 'temporary']) {
  for (const failure of ['false', 'throw']) {
    test(`simulated Windows ${stage} hardening ${failure} leaves no new secrets and releases its lock`, async (t) => {
      const f = fixture(t, { windows: true });
      if (stage !== 'directory') await seed(f.store);
      const before =
        stage !== 'directory' ? fs.readFileSync(f.filename, 'utf8') : null;
      let failing = true;
      const store = createChatGptStore({
        ...f.dependencies,
        harden(file) {
          const selected =
            stage === 'directory'
              ? file === f.directory
              : stage === 'lock'
                ? file === f.lockfile
                : file.endsWith('.tmp');
          if (failing && selected) {
            if (file !== f.directory) assert.equal(fs.statSync(file).size, 0);
            if (failure === 'throw')
              throw new Error('fixture hardening failure');
            return false;
          }
          return f.dependencies.harden(file);
        },
      });
      await assert.rejects(seed(store), /protect|hardening failure/);
      assert.deepEqual(
        fs.readdirSync(f.directory),
        before ? ['accounts.json'] : [],
      );
      if (before) assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
      failing = false;
      if (stage === 'directory') fs.rmdirSync(f.directory);
      await seed(store);
      assert.equal(
        store.read().accounts[0].tokens.refresh_token,
        'synthetic-secret',
      );
    });
  }
}

test('a temporary file is protected while still empty and reverified before rename', async (t) => {
  const f = fixture(t, { windows: true });
  await seed(f.store);
  const before = fs.readFileSync(f.filename, 'utf8');
  let wrote = false;
  const store = createChatGptStore({
    ...f.dependencies,
    fileSystem: {
      ...fs,
      writeFileSync(fd, content) {
        const temporary = path.join(
          f.directory,
          fs.readdirSync(f.directory).find((name) => name.endsWith('.tmp')),
        );
        assert.equal(fs.fstatSync(fd).size, 0);
        assert.equal(f.privateEntries.has(identity(temporary)), true);
        fs.writeFileSync(fd, content);
        wrote = true;
        f.privateEntries.delete(identity(temporary));
      },
    },
  });
  await assert.rejects(seed(store), /permissions/);
  assert.equal(wrote, true);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`${operation} failure preserves the committed store and cleans temporary files`, async (t) => {
    const f = fixture(t);
    await seed(f.store);
    const before = fs.readFileSync(f.filename, 'utf8');
    const store = createChatGptStore({
      ...f.dependencies,
      fileSystem: {
        ...fs,
        [operation]() {
          throw new Error('fixture IO failure');
        },
      },
    });
    await assert.rejects(seed(store), /fixture IO failure/);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
    await seed(f.store);
  });
}

test('a pathname replacement during ACL verification refuses to read a different file', async (t) => {
  const f = fixture(t, { windows: true });
  await seed(f.store);
  const replacement = path.join(f.directory, 'replacement');
  fs.writeFileSync(replacement, fs.readFileSync(f.filename), { mode: 0o600 });
  const store = createChatGptStore({
    ...f.dependencies,
    verifyAcl(file) {
      const ok = f.dependencies.verifyAcl(file);
      if (file === f.filename) fs.renameSync(replacement, f.filename);
      return ok;
    },
  });
  const reads = f.reads;
  assert.throws(() => store.read(), /changed during access/);
  assert.equal(f.reads, reads);
});

test('in-place changes during a descriptor read are not returned as credentials', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  const store = createChatGptStore({
    ...f.dependencies,
    fileSystem: {
      ...fs,
      readFileSync(fd, encoding) {
        const content = fs.readFileSync(fd, encoding);
        fs.appendFileSync(f.filename, ' ');
        return content;
      },
    },
  });
  assert.throws(() => store.read(), /changed during access/);
});

test('file identities above the Number precision limit remain distinct', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  let accountFd;
  const store = createChatGptStore({
    ...f.dependencies,
    fileSystem: {
      ...f.dependencies.fileSystem,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (file === f.filename) accountFd = fd;
        return fd;
      },
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (file === f.filename)
          stat.ino = options?.bigint
            ? 9007199254740993n
            : Number(9007199254740993n);
        return stat;
      },
      fstatSync(fd, options) {
        const stat = fs.fstatSync(fd, options);
        if (fd === accountFd)
          stat.ino = options?.bigint
            ? 9007199254740992n
            : Number(9007199254740992n);
        return stat;
      },
    },
  });
  const reads = f.reads;
  assert.throws(() => store.read(), /changed during access/);
  assert.equal(f.reads, reads);
});

test('independent stores and queued updates serialize without lost updates; readers see committed data', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  const other = createChatGptStore(f.dependencies);
  const jobs = Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? f.store : other).transaction(async (data) => {
      const before = data.counter;
      assert.equal(other.read().counter, before);
      await setImmediate();
      data.counter = before + 1;
    }),
  );
  await Promise.all(jobs);
  assert.equal(f.store.read().counter, 8);
  assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
});

test('a callback rejection releases the lock and does not poison the transaction queue', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  const failed = f.store.transaction((data) => {
    data.counter = 99;
    throw new Error('fixture callback failure');
  });
  const next = f.store.transaction((data) => {
    data.counter += 1;
  });
  await assert.rejects(failed, /callback failure/);
  await next;
  assert.equal(f.store.read().counter, 1);
});

test('a competing transaction times out without stealing a live lock', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  const other = createChatGptStore({ ...f.dependencies, lockTimeoutMs: 0 });
  await f.store.transaction(async (data) => {
    const lockIdentity = identity(f.lockfile);
    await assert.rejects(seed(other), /busy/);
    assert.equal(identity(f.lockfile), lockIdentity);
    data.counter += 1;
  });
  assert.equal(f.store.read().counter, 1);
});

test('replacing a held lock refuses the write and preserves the replacement lock', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  const before = fs.readFileSync(f.filename, 'utf8');
  await assert.rejects(
    f.store.transaction(async (data) => {
      await setImmediate();
      fs.unlinkSync(f.lockfile);
      fs.writeFileSync(f.lockfile, 'replacement lock', { mode: 0o600 });
      data.counter = 99;
    }),
    /changed during access/,
  );
  assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
  assert.equal(fs.readFileSync(f.lockfile, 'utf8'), 'replacement lock');
});

for (const target of ['filename', 'directory', 'lockfile']) {
  test(`simulated Windows rechecks ${target} permissions after an awaited update`, async (t) => {
    const f = fixture(t, { windows: true });
    await seed(f.store);
    const before = fs.readFileSync(f.filename, 'utf8');
    await assert.rejects(
      f.store.transaction(async (data) => {
        await setImmediate();
        f.privateEntries.delete(identity(f[target]));
        data.counter = 99;
      }),
      /permissions/,
    );
    assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
  });
}

test('hard-linked credentials are refused', async (t) => {
  const f = fixture(t);
  await seed(f.store);
  fs.linkSync(f.filename, path.join(f.root, 'alias'));
  assert.throws(() => f.store.read(), /Unsafe/);
  await assert.rejects(seed(f.store), /Unsafe/);
});

test(
  'dangling credential links and linked directories are refused',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.directory, { mode: 0o700 });
    fs.symlinkSync(path.join(f.root, 'missing'), f.filename);
    assert.throws(() => f.store.read(), /Unsafe/);
    await assert.rejects(seed(f.store), /Unsafe/);
    fs.rmSync(f.filename);
    fs.rmdirSync(f.directory);
    fs.symlinkSync(f.root, f.directory);
    assert.throws(() => f.store.read(), /Unsafe/);
    await assert.rejects(seed(f.store), /Unsafe/);
  },
);

test(
  'separate Node processes serialize rotating updates on the same store',
  { timeout: 120_000 },
  async (t) => {
    const f = fixture(t);
    await seed(f.store);
    const source = `
    import { createChatGptStore } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
    import { setTimeout } from 'node:timers/promises';
    const store = createChatGptStore({ directory: process.argv[1], lockTimeoutMs: 90_000 });
    for (let i = 0; i < 3; i++) await store.transaction(async (data) => {
      const previous = data.counter;
      await setTimeout(5);
      data.counter = previous + 1;
    });
  `;
    await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', source, f.directory],
              {
                stdio: ['ignore', 'ignore', 'pipe'],
              },
            );
            t.after(() => {
              if (child.exitCode === null) child.kill();
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += chunk;
            });
            child.once('error', reject);
            child.once('exit', (code, signal) => {
              if (code === 0) resolve();
              else
                reject(
                  new Error(
                    `Store child failed (${code ?? signal}): ${stderr}`,
                  ),
                );
            });
          }),
      ),
    );
    assert.equal(f.store.read().counter, 9);
    assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
  },
);

for (const target of ['filename', 'directory']) {
  test(
    `native Windows refuses a broadened ${target} DACL without repairing it`,
    {
      skip: process.platform !== 'win32',
      timeout: 60_000,
    },
    async (t) => {
      const f = fixture(t);
      await seed(f.store);
      assert.equal(verifyWindowsCredentialAcl(f.filename), true);
      assert.equal(verifyWindowsCredentialAcl(f.directory), true);
      const before = fs.readFileSync(f.filename, 'utf8');
      const executable = path.win32.join(
        process.env.SystemRoot,
        'System32',
        'icacls.exe',
      );
      const result = spawnSync(
        executable,
        [f[target], '/grant', '*S-1-1-0:R'],
        { timeout: 10_000 },
      );
      assert.equal(result.status, 0);
      const reads = f.reads;
      assert.throws(() => f.store.read(), /permissions/);
      await assert.rejects(seed(f.store), /permissions/);
      assert.equal(f.reads, reads);
      assert.equal(verifyWindowsCredentialAcl(f[target]), false);
      assert.equal(fs.readFileSync(f.filename, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(f.directory), ['accounts.json']);
    },
  );
}
