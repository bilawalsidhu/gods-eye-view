import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenCredentialFile } from './keySetupHardening.mjs';

const FILE = path.join(os.tmpdir(), 'provider-settings-test');
const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const WINDOWS_ROOT = 'C:\\Windows';

function windowsFileSystem({
  root = WINDOWS_ROOT,
  systemDirectory = 'System32',
  realpaths = {},
  missing = [],
  symlinks = [],
} = {}) {
  const tools = [
    `${root}\\${systemDirectory}\\whoami.exe`,
    `${root}\\${systemDirectory}\\icacls.exe`,
    `${root}\\${systemDirectory}\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ];
  const realpathSync = (filepath) => realpaths[filepath] || filepath;
  realpathSync.native = realpathSync;
  return {
    realpathSync,
    lstatSync(filepath) {
      return {
        isDirectory: () => filepath === root,
        isFile: () => tools.includes(filepath) && !missing.includes(filepath),
        isSymbolicLink: () => symlinks.includes(filepath),
      };
    },
  };
}

function fileSystemWithMode(mode = 0o600) {
  const calls = [];
  return {
    calls,
    chmodSync(filepath, nextMode) { calls.push(['chmod', filepath, nextMode]); },
    statSync(filepath) { calls.push(['stat', filepath]); return { mode }; },
  };
}

test('macOS ACL removal failure stops before chmod and fails closed', () => {
  const fileSystem = fileSystemWithMode();
  const result = hardenCredentialFile(FILE, {
    platform: 'darwin',
    fileSystem,
    spawn: () => ({ status: 1, signal: null }),
  });
  assert.equal(result, false);
  assert.deepEqual(fileSystem.calls, [], 'mode bits must not disguise an ACL-removal failure');
});

test('POSIX hardening verifies the resulting 0600 mode', () => {
  const goodFs = fileSystemWithMode(0o100600);
  assert.equal(hardenCredentialFile(FILE, {
    platform: 'darwin',
    fileSystem: goodFs,
    spawn: () => ({ status: 0, signal: null }),
  }), true);
  assert.deepEqual(goodFs.calls, [['chmod', FILE, 0o600], ['stat', FILE]]);

  const broadFs = fileSystemWithMode(0o100640);
  assert.equal(hardenCredentialFile(FILE, {
    platform: 'linux',
    fileSystem: broadFs,
    spawn: () => { throw new Error('Linux must not spawn chmod'); },
  }), false);
});

test('Windows hardening refuses an unstructured or broad owner SID before icacls', () => {
  const commands = [];
  const result = hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
    platform: 'win32',
    environment: { SYSTEMROOT: WINDOWS_ROOT },
    fileSystem: windowsFileSystem(),
    spawn(command) {
      commands.push(command);
      return { status: 0, signal: null, stdout: '"S-1-5-21-1-2-3-1001","S-1-5-32-545"' };
    },
  });
  assert.equal(result, false);
  assert.deepEqual(commands, [`${WINDOWS_ROOT}\\System32\\whoami.exe`]);
});

test('Windows hardening applies and then verifies the exact restricted DACL', () => {
  const calls = [];
  const filepath = 'C:\\GEV App\\pinokio\\ENVIRONMENT.tmp';
  const result = hardenCredentialFile(filepath, {
    platform: 'win32',
    environment: { SYSTEMROOT: WINDOWS_ROOT },
    fileSystem: windowsFileSystem(),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      if (command.endsWith('\\whoami.exe')) {
        return { status: 0, signal: null, stdout: `"WORKSTATION\\alice","${USER_SID}"\r\n` };
      }
      return { status: 0, signal: null };
    },
  });
  assert.equal(result, true);
  assert.deepEqual(calls.map(({ command }) => command), [
    `${WINDOWS_ROOT}\\System32\\whoami.exe`,
    `${WINDOWS_ROOT}\\System32\\icacls.exe`,
    `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  ]);
  assert.deepEqual(calls[1].args, [
    filepath,
    '/inheritance:r',
    '/grant:r',
    `*${USER_SID}:F`,
    '*S-1-5-18:F',
    '*S-1-5-32-544:F',
  ]);
  assert.equal(calls[1].args.filter((arg) => arg === '/grant:r').length, 1);
  assert.equal(calls[2].options.env.GEV_ACL_FILE, filepath);
  assert.equal(calls[2].options.env.GEV_ACL_USER_SID, USER_SID);
  assert.match(calls[2].args.at(-1), /AreAccessRulesProtected/);
  assert.match(calls[2].args.at(-1), /rules\.Count -ne 3/);
  assert.match(calls[2].args.at(-1), /seen\.ContainsKey/);
  assert.match(calls[2].args.at(-1), /FileSystemRights -ne \$full/);
  assert.match(calls[2].args.at(-1), /seen\.Count -ne 3/);
});

test('Windows hardening bypasses PATH-shadowed native ACL tools', () => {
  const commands = [];
  const result = hardenCredentialFile('D:\\GEV\\ENVIRONMENT.tmp', {
    platform: 'win32',
    environment: {
      PATH: 'D:\\pinokio\\bin;C:\\Windows\\System32',
      SystemRoot: WINDOWS_ROOT,
      WINDIR: 'c:\\windows\\',
    },
    fileSystem: windowsFileSystem(),
    spawn(command) {
      commands.push(command);
      if (command.endsWith('\\whoami.exe')) {
        return { status: 0, signal: null, stdout: `"WORKSTATION\\alice","${USER_SID}"` };
      }
      return { status: 0, signal: null };
    },
  });
  assert.equal(result, true);
  assert.equal(commands.some((command) => !command.startsWith(`${WINDOWS_ROOT}\\System32\\`)), false);
});

test('Windows hardening rejects redirected or ambiguous system roots before spawning', () => {
  const rejected = [
    {},
    { SYSTEMROOT: 'Windows' },
    { SYSTEMROOT: '\\Windows' },
    { SYSTEMROOT: '\\\\server\\share\\Windows' },
    { SYSTEMROOT: '\\\\?\\C:\\Windows' },
    { SYSTEMROOT: 'C:\\Temp\\..\\Windows' },
    { SYSTEMROOT: 'C:\\attacker\\Windows' },
    { SYSTEMROOT: WINDOWS_ROOT, WINDIR: 'D:\\Windows' },
  ];
  for (const environment of rejected) {
    let spawned = false;
    const result = hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
      platform: 'win32',
      environment,
      fileSystem: windowsFileSystem(),
      spawn() { spawned = true; return { status: 0, signal: null }; },
    });
    assert.equal(result, false, JSON.stringify(environment));
    assert.equal(spawned, false, JSON.stringify(environment));
  }
});

test('Windows hardening accepts a canonical Windows root on a non-default drive', () => {
  const root = 'D:\\Windows';
  const commands = [];
  const result = hardenCredentialFile('D:\\GEV\\ENVIRONMENT.tmp', {
    platform: 'win32',
    environment: { SYSTEMROOT: root },
    fileSystem: windowsFileSystem({ root }),
    spawn(command) {
      commands.push(command);
      if (command.endsWith('\\whoami.exe')) {
        return { status: 0, signal: null, stdout: `"WORKSTATION\\alice","${USER_SID}"` };
      }
      return { status: 0, signal: null };
    },
  });
  assert.equal(result, true);
  assert.equal(commands.every((command) => command.startsWith('D:\\Windows\\System32\\')), true);
});

test('32-bit Windows hardening uses the native Sysnative bridge', () => {
  const commands = [];
  const result = hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
    platform: 'win32',
    architecture: 'ia32',
    environment: { SYSTEMROOT: WINDOWS_ROOT },
    fileSystem: windowsFileSystem({ systemDirectory: 'Sysnative' }),
    spawn(command) {
      commands.push(command);
      if (command.endsWith('\\whoami.exe')) {
        return { status: 0, signal: null, stdout: `"WORKSTATION\\alice","${USER_SID}"` };
      }
      return { status: 0, signal: null };
    },
  });
  assert.equal(result, true);
  assert.equal(commands.every((command) => command.includes('\\Sysnative\\')), true);
});

test('Windows hardening rejects missing, redirected, or non-file native tools', () => {
  const whoami = `${WINDOWS_ROOT}\\System32\\whoami.exe`;
  const cases = [
    windowsFileSystem({ missing: [whoami] }),
    windowsFileSystem({ realpaths: { [WINDOWS_ROOT]: 'C:\\RedirectedWindows' } }),
    windowsFileSystem({ realpaths: { [whoami]: 'C:\\attacker\\whoami.exe' } }),
    windowsFileSystem({ realpaths: { [whoami]: 'C:\\Windows\\Temp\\evil-whoami.exe' } }),
    windowsFileSystem({ symlinks: [whoami] }),
  ];
  for (const fileSystem of cases) {
    let spawned = false;
    assert.equal(hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
      platform: 'win32',
      environment: { SYSTEMROOT: WINDOWS_ROOT },
      fileSystem,
      spawn() { spawned = true; return { status: 0, signal: null }; },
    }), false);
    assert.equal(spawned, false);
  }
});

test('Windows hardening fails closed when ACL application or verification fails', () => {
  for (const failingCommand of ['icacls.exe', 'powershell.exe']) {
    const calls = [];
    const result = hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
      platform: 'win32',
      environment: { SYSTEMROOT: WINDOWS_ROOT },
      fileSystem: windowsFileSystem(),
      spawn(command) {
        calls.push(command);
        if (command.endsWith('\\whoami.exe')) {
          return { status: 0, signal: null, stdout: `"WORKSTATION\\alice","${USER_SID}"` };
        }
        return { status: command.endsWith(`\\${failingCommand}`) ? 1 : 0, signal: null };
      },
    });
    assert.equal(result, false, `${failingCommand} failure must refuse the write`);
    assert.equal(calls.at(-1).endsWith(`\\${failingCommand}`), true);
  }
});

test('Windows hardening converts subprocess exceptions into a fail-closed result', () => {
  assert.equal(hardenCredentialFile('C:\\GEV\\ENVIRONMENT.tmp', {
    platform: 'win32',
    environment: { SYSTEMROOT: WINDOWS_ROOT },
    fileSystem: windowsFileSystem(),
    spawn() { throw new Error('subprocess unavailable'); },
  }), false);
});

test('Windows production hardener applies its exact DACL with native tools', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-provider-acl-'));
  const filepath = path.join(directory, 'ENVIRONMENT.tmp');
  try {
    fs.writeFileSync(filepath, '');
    assert.equal(hardenCredentialFile(filepath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
