import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  hardenCredentialFile,
  verifyWindowsCredentialAcl,
} from './credential-file.mjs';

const root = 'C:\\Windows';
const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const filepath = 'C:\\GEV fixture\\accounts.json';
const success = { status: 0, signal: null };
const whoami = { ...success, stdout: `"WORKSTATION\\fixture","${sid}"` };

function fixture({
  architecture = 'x64',
  environment = {},
  spawn,
  ...options
} = {}) {
  const calls = [];
  const systemDirectory = architecture === 'ia32' ? 'Sysnative' : 'System32';
  const native = (file) => file.replace('\\Sysnative\\', '\\System32\\');
  const tools = [
    `${root}\\${systemDirectory}\\whoami.exe`,
    `${root}\\${systemDirectory}\\icacls.exe`,
    `${root}\\${systemDirectory}\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ];
  return {
    calls,
    options: {
      architecture,
      environment: { SystemRoot: root, ...environment },
      fileSystem: {
        realpathSync: Object.assign(native, { native }),
        lstatSync(file) {
          return {
            isDirectory: () => file === root,
            isFile: () => tools.includes(file),
            isSymbolicLink: () => false,
          };
        },
      },
      spawn(command, args, settings) {
        calls.push({ command, args, settings });
        return spawn
          ? spawn(command, args, settings)
          : command.endsWith('whoami.exe')
            ? whoami
            : success;
      },
      ...options,
    },
  };
}

test('Windows verification queries the current SID and DACL without applying permissions', () => {
  const f = fixture();
  assert.equal(verifyWindowsCredentialAcl(filepath, f.options), true);
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls.some(({ command }) => command.endsWith('icacls.exe')),
    false,
  );
  assert.match(f.calls[0].command, /^C:\\Windows\\System32\\whoami.exe$/);
  const verify = f.calls[1];
  assert.equal(verify.settings.env.GEV_ACL_FILE, filepath);
  assert.equal(verify.settings.env.GEV_ACL_USER_SID, sid);
  assert.match(verify.args.at(-1), /GetOwner/);
  assert.match(verify.args.at(-1), /allowed -notcontains \$owner/);
  assert.match(verify.args.at(-1), /PropagationFlags/);
  assert.ok(f.calls.every(({ settings }) => settings.timeout === 10_000));
});

test('verify-only cannot be switched into an ACL repair by an option', () => {
  const f = fixture({ apply: true });
  assert.equal(verifyWindowsCredentialAcl(filepath, f.options), true);
  assert.equal(f.calls.length, 2);
});

for (const architecture of ['x64', 'ia32']) {
  test(`Windows ${architecture} verification discards aliases for all security parameters`, () => {
    const f = fixture({
      architecture,
      environment: {
        gev_acl_file: 'C:\\wrong.json',
        GeV_AcL_UsEr_SiD: 'S-1-1-0',
        PSMODULEPATH: 'C:\\untrusted-modules',
        psmodulepath: 'C:\\other-modules',
      },
    });
    assert.equal(verifyWindowsCredentialAcl(filepath, f.options), true);
    const env = f.calls.at(-1).settings.env;
    for (const name of ['GEV_ACL_FILE', 'GEV_ACL_USER_SID', 'PSModulePath']) {
      assert.deepEqual(
        Object.keys(env).filter(
          (key) => key.toLowerCase() === name.toLowerCase(),
        ),
        [name],
      );
    }
    assert.equal(
      env.PSModulePath,
      `${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    );
  });
}

for (const result of [
  null,
  { status: null, signal: null },
  { status: 0, signal: 'SIGTERM' },
  {
    status: 0,
    error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  },
  ...Array.from({ length: 11 }, (_, index) => ({
    status: index + 1,
    signal: null,
  })),
]) {
  test(`Windows verification fails closed for subprocess result ${JSON.stringify(result)}`, () => {
    for (const failingCommand of ['whoami.exe', 'powershell.exe']) {
      const f = fixture({
        spawn(command) {
          if (command.endsWith(failingCommand)) return result;
          return command.endsWith('whoami.exe') ? whoami : success;
        },
      });
      assert.equal(verifyWindowsCredentialAcl(filepath, f.options), false);
      assert.ok(f.calls.at(-1).command.endsWith(failingCommand));
      assert.equal(
        f.calls.some(({ command }) => command.endsWith('icacls.exe')),
        false,
      );
    }
  });
}

test('Windows verification rejects untrusted tool paths, malformed identity and thrown subprocess errors', () => {
  const invalidRoot = fixture({
    environment: { SystemRoot: 'C:\\attacker\\Windows' },
  });
  assert.equal(
    verifyWindowsCredentialAcl(filepath, invalidRoot.options),
    false,
  );
  assert.equal(invalidRoot.calls.length, 0);
  const malformed = fixture({
    spawn: () => ({ ...success, stdout: '"fixture","S-1-1-0"' }),
  });
  assert.equal(verifyWindowsCredentialAcl(filepath, malformed.options), false);
  assert.equal(malformed.calls.length, 1);
  const thrown = fixture({
    spawn() {
      throw new Error('unavailable');
    },
  });
  assert.equal(verifyWindowsCredentialAcl(filepath, thrown.options), false);
});

for (const mutation of ['inheritance', 'extra allow', 'deny']) {
  test(
    `native Windows verification rejects ${mutation} without changing the DACL`,
    {
      skip: process.platform !== 'win32',
      timeout: 30_000,
    },
    (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gev-verify-acl-'),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const file = path.join(directory, 'synthetic.json');
      fs.writeFileSync(file, 'synthetic-secret');
      assert.equal(hardenCredentialFile(file), true);
      assert.equal(verifyWindowsCredentialAcl(file), true);
      const executable = path.win32.join(
        process.env.SystemRoot,
        'System32',
        'icacls.exe',
      );
      const args =
        mutation === 'inheritance'
          ? ['/inheritance:e']
          : mutation === 'extra allow'
            ? ['/grant', '*S-1-1-0:R']
            : ['/deny', '*S-1-5-21-1111111111-2222222222-3333333333-9999:R'];
      assert.equal(
        spawnSync(executable, [file, ...args], { timeout: 10_000 }).status,
        0,
      );
      const before = spawnSync(executable, [file], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(before.status, 0);
      assert.equal(verifyWindowsCredentialAcl(file), false);
      const after = spawnSync(executable, [file], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(after.status, 0);
      assert.equal(after.stdout, before.stdout);
      assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-secret');
    },
  );
}
