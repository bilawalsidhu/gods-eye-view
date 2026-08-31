import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  commandCompletedSuccessfully,
  parseWindowsUserSid,
} from './keySetupCore.mjs';

/** PowerShell verification for the exact owner-only Windows credential DACL. */
const WINDOWS_ACL_VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = Get-Acl -LiteralPath $env:GEV_ACL_FILE',
  'if (-not $acl.AreAccessRulesProtected) { exit 2 }',
  "$allowed = @($env:GEV_ACL_USER_SID, 'S-1-5-18', 'S-1-5-32-544')",
  '$seen = @{}',
  '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  'if ($rules.Count -ne 3) { exit 7 }',
  'foreach ($rule in $rules) {',
  '  $ruleSid = $rule.IdentityReference.Value',
  '  if ($rule.IsInherited) { exit 3 }',
  '  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 4 }',
  '  if ($allowed -notcontains $ruleSid) { exit 5 }',
  '  if ($seen.ContainsKey($ruleSid)) { exit 8 }',
  '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '  if ($rule.FileSystemRights -ne $full) { exit 6 }',
  '  $seen[$ruleSid] = $true',
  '}',
  'if ($seen.Count -ne 3) { exit 9 }',
].join('; ');

/**
 * Resolve the native Windows ACL tools without consulting PATH.
 *
 * Provider Settings supports the standard Windows installation layout only:
 * a local drive root named `Windows` (for example C:\\Windows or D:\\Windows).
 * Requiring consistent aliases, canonical paths, and regular files prevents an
 * inherited environment override, UNC share, device path, junction, or PATH
 * shim from being treated as an operating-system security tool.
 */
function resolveWindowsNativeTools(environment, fileSystem, architecture) {
  const aliases = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir'];
  const configured = aliases
    .map((name) => environment[name])
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (configured.length === 0) return null;

  const roots = configured.map((value) => {
    if (value !== value.trim() || !/^[A-Za-z]:\\Windows\\?$/i.test(value)) return null;
    return value.endsWith('\\') ? value.slice(0, -1) : value;
  });
  if (roots.some((root) => !root)) return null;
  if (roots.some((root) => root.toLowerCase() !== roots[0].toLowerCase())) return null;

  const systemRoot = roots[0];
  const systemDirectory = architecture === 'ia32' ? 'Sysnative' : 'System32';
  const expected = {
    whoami: path.win32.join(systemRoot, systemDirectory, 'whoami.exe'),
    icacls: path.win32.join(systemRoot, systemDirectory, 'icacls.exe'),
    powershell: path.win32.join(
      systemRoot,
      systemDirectory,
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  };

  try {
    const realpath = fileSystem.realpathSync.native || fileSystem.realpathSync;
    const rootEntry = fileSystem.lstatSync(systemRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return null;
    const canonicalRoot = realpath.call(fileSystem.realpathSync, systemRoot);
    if (canonicalRoot.toLowerCase() !== systemRoot.toLowerCase()) return null;
    for (const executable of Object.values(expected)) {
      const entry = fileSystem.lstatSync(executable);
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      const canonicalExecutable = realpath.call(fileSystem.realpathSync, executable);
      const canonicalCandidates = [executable];
      if (architecture === 'ia32') {
        canonicalCandidates.push(executable.replace('\\Sysnative\\', '\\System32\\'));
      }
      if (!canonicalCandidates.some(
        (candidate) => candidate.toLowerCase() === canonicalExecutable.toLowerCase(),
      )) return null;
    }
  } catch {
    return null;
  }
  return expected;
}

/**
 * Restrict a credential file before any secret is written to it.
 * Dependencies are injectable so every fail-closed branch is unit-testable.
 */
export function hardenCredentialFile(filepath, {
  platform = process.platform,
  architecture = process.arch,
  spawn = spawnSync,
  fileSystem = fs,
  environment = process.env,
} = {}) {
  if (platform !== 'win32') {
    try {
      if (platform === 'darwin') {
        const aclRemoval = spawn('chmod', ['-N', filepath], { stdio: 'ignore' });
        if (!commandCompletedSuccessfully(aclRemoval)) return false;
      }
      fileSystem.chmodSync(filepath, 0o600);
      return (fileSystem.statSync(filepath).mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }

  const tools = resolveWindowsNativeTools(environment, fileSystem, architecture);
  if (!tools) return false;

  try {
    // Grant by the CURRENT PROCESS TOKEN'S SID, never a bare username. Parsing
    // the second CSV field structurally prevents an SID-looking account name or
    // a broad group SID from becoming the credential owner.
    const whoami = spawn(tools.whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sid = commandCompletedSuccessfully(whoami)
      ? parseWindowsUserSid(whoami.stdout)
      : null;
    if (!sid) return false;

    const applied = spawn(tools.icacls, [
      filepath,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:F`,
      '*S-1-5-18:F',
      '*S-1-5-32-544:F',
    ], { stdio: 'ignore', windowsHide: true });
    if (!commandCompletedSuccessfully(applied)) return false;

    // Command success is not proof of the resulting DACL. Query it back and
    // accept only three explicit FullControl allow principals, with inheritance
    // disabled. Any unexpected rule, right, command error, or missing principal
    // fails closed before the secret reaches disk.
    const verified = spawn(tools.powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command', WINDOWS_ACL_VERIFY_SCRIPT,
    ], {
      env: {
        ...environment,
        GEV_ACL_FILE: filepath,
        GEV_ACL_USER_SID: sid,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    return commandCompletedSuccessfully(verified);
  } catch {
    return false;
  }
}
