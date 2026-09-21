/**
 * JARVIS Tool Execution Engine — Server-side capabilities for God's Eye View.
 *
 * Provides sandboxed code execution, file operations, web scraping,
 * calculation, persistent memory, and reminder scheduling.
 */

import { readRequestBody } from './common/request.js';
import { promises as fs } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { generateImage } from './nvidia-genai.js';
import { analyzeImage } from './nvidia-vision.js';

// ── Workspace root: safe sandbox for file operations ──
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, '../../.jarvis-workspace');
const MEMORY_FILE = resolve(__dirname, '../../.jarvis-workspace/.memory.json');
const SESSIONS_DIR = resolve(__dirname, '../../.jarvis-workspace/.sessions');
const CODE_SANDBOX = resolve(__dirname, '../../.jarvis-workspace/.sandbox');
const SCREENSHOTS_DIR = resolve(__dirname, '../../public/screenshots');
const SCHEDULES_FILE = resolve(
  __dirname,
  '../../.jarvis-workspace/.schedules.json',
);
const MAX_EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Format seconds into human readable duration */
export function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

/** Ensure workspace directories exist */
async function ensureWorkspace() {
  for (const dir of [
    WORKSPACE_ROOT,
    SESSIONS_DIR,
    CODE_SANDBOX,
    SCREENSHOTS_DIR,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }
  try {
    await fs.access(MEMORY_FILE);
  } catch {
    await fs.writeFile(MEMORY_FILE, '{}', 'utf-8');
  }
  try {
    await fs.access(SCHEDULES_FILE);
  } catch {
    await fs.writeFile(SCHEDULES_FILE, '[]', 'utf-8');
  }
}

// ── 1. Code Execution (Sandboxed) & Autonomous Debugging ──

/**
 * Execute code in a sandboxed child process.
 * Supports: javascript, typescript, python, bash, shell, powershell.
 * Returns { stdout, stderr, exitCode, duration, errorAnalysis }.
 */
export async function executeCode(
  language,
  code,
  { timeout = MAX_EXEC_TIMEOUT_MS } = {},
) {
  await ensureWorkspace();

  const isWin = process.platform === 'win32';
  const extMap = {
    javascript: '.mjs',
    python: '.py',
    typescript: '.ts',
    bash: isWin ? '.ps1' : '.sh',
    shell: isWin ? '.ps1' : '.sh',
    powershell: '.ps1',
    ps1: '.ps1',
  };
  const ext = extMap[language] || '.txt';
  const hash = createHash('md5').update(code).digest('hex').slice(0, 8);
  const filename = `run_${hash}${ext}`;
  const filepath = join(CODE_SANDBOX, filename);

  await fs.writeFile(filepath, code, 'utf-8');

  let cmd, args;
  switch (language) {
    case 'javascript':
      cmd = 'node';
      args = [filepath];
      break;
    case 'typescript':
      cmd = 'npx';
      args = ['-y', 'tsx', filepath];
      break;
    case 'python':
      cmd = isWin ? 'python' : 'python3';
      args = [filepath];
      break;
    case 'bash':
    case 'shell':
    case 'powershell':
    case 'ps1':
      if (isWin) {
        cmd = 'powershell';
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filepath];
      } else {
        cmd = 'bash';
        args = [filepath];
      }
      break;
    default:
      return {
        stdout: '',
        stderr: `Unsupported language: ${language}`,
        exitCode: 1,
        duration: 0,
      };
  }

  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(cmd, args, {
      cwd: CODE_SANDBOX,
      timeout,
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      const codeExit = killed ? 124 : (exitCode ?? 1);
      const trimmedStderr = stderr.trim();
      let errorAnalysis = null;
      if (codeExit !== 0 || trimmedStderr.length > 0) {
        const lines = trimmedStderr
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const errorLine =
          lines.find(
            (l) =>
              l.includes('Error:') ||
              l.includes('Exception:') ||
              l.includes('SyntaxError'),
          ) ||
          lines[lines.length - 1] ||
          'Unknown error';
        errorAnalysis = {
          hasError: true,
          exitCode: codeExit,
          primaryError: errorLine,
          stderrLines: lines.slice(-8),
        };
      }
      resolve({
        stdout: stdout.trim(),
        stderr: trimmedStderr,
        exitCode: codeExit,
        duration: Date.now() - start,
        killed,
        errorAnalysis,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 127,
        duration: Date.now() - start,
        errorAnalysis: {
          hasError: true,
          exitCode: 127,
          primaryError: err.message,
        },
      });
    });
  });
}

/**
 * Diagnostic helper for autonomous code execution and debug loops.
 */
export async function debugCode(
  language,
  code,
  { expectedBehavior = '' } = {},
) {
  const result = await executeCode(language, code);
  if (result.exitCode === 0 && !result.errorAnalysis?.hasError) {
    return {
      status: 'success',
      passed: true,
      exitCode: 0,
      stdout: result.stdout,
      message: 'Code executed cleanly with exit code 0.',
    };
  }

  return {
    status: 'failed',
    passed: false,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errorAnalysis: result.errorAnalysis,
    expectedBehavior,
    suggestion:
      'Analyze the error above, fix the bug in the code, and re-call execute_code or debug_code.',
  };
}

// ── 2. File Operations ──

/** List files in a directory within the workspace. */
export async function listFiles(relativePath = '.') {
  await ensureWorkspace();
  const target = resolve(WORKSPACE_ROOT, relativePath);
  if (!target.startsWith(WORKSPACE_ROOT))
    throw new Error('Access denied: outside workspace');

  const entries = await fs.readdir(target, { withFileTypes: true });
  const files = entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file',
    path: join(relativePath, e.name).replace(/\\/g, '/'),
  }));
  return { files, count: files.length };
}

/** Read a file from the workspace. */
export async function readFile(relativePath) {
  await ensureWorkspace();
  const target = resolve(WORKSPACE_ROOT, relativePath);
  if (!target.startsWith(WORKSPACE_ROOT))
    throw new Error('Access denied: outside workspace');

  const stat = await fs.stat(target);
  if (stat.size > 1024 * 1024) throw new Error('File too large (>1MB)');

  const content = await fs.readFile(target, 'utf-8');
  return { path: relativePath, content, size: stat.size };
}

/** Write a file to the workspace. */
export async function writeFile(relativePath, content) {
  await ensureWorkspace();
  const target = resolve(WORKSPACE_ROOT, relativePath);
  if (!target.startsWith(WORKSPACE_ROOT))
    throw new Error('Access denied: outside workspace');

  await fs.mkdir(resolve(target, '..'), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
  const bytes = Buffer.byteLength(content);
  return { written: target.replace(/\\/g, '/'), bytes, bytesWritten: bytes };
}

/** Delete a file from the workspace. */
export async function deleteFile(relativePath) {
  await ensureWorkspace();
  const target = resolve(WORKSPACE_ROOT, relativePath);
  if (!target.startsWith(WORKSPACE_ROOT))
    throw new Error('Access denied: outside workspace');

  await fs.unlink(target);
  return { deleted: true, path: relativePath };
}

// ── 2.5 Full Computer & System-Wide Automation ──

/**
 * Execute an arbitrary shell / terminal / PowerShell command on the host machine.
 * Supports custom cwd, stdout/stderr capture, timeout, and safety checks.
 */
export async function executeSystemCommand(
  command,
  { cwd = null, timeout = MAX_EXEC_TIMEOUT_MS } = {},
) {
  await ensureWorkspace();
  const isWin = process.platform === 'win32';
  const repoRoot = resolve(__dirname, '../../');
  const effectiveCwd = cwd ? resolve(cwd) : repoRoot;

  // Guard against destructive root disk formatting / wiping
  const dangerousPatterns = [
    /format\s+[a-z]:/i,
    /diskpart/i,
    /rmdir\s+\/s\s+\/q\s+[a-z]:\\$/i,
    /Remove-Item\s+.*[a-z]:\\.*-Recurse\s+-Force/i,
  ];
  if (dangerousPatterns.some((rgx) => rgx.test(command))) {
    return {
      stdout: '',
      stderr: 'Security refusal: Destructive root disk command rejected.',
      exitCode: 1,
      duration: 0,
      cwd: effectiveCwd,
      errorAnalysis: {
        hasError: true,
        primaryError: 'Command blocked by security guard.',
      },
    };
  }

  const start = Date.now();
  let cmd, args;
  if (isWin) {
    cmd = 'powershell';
    args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ];
  } else {
    cmd = 'bash';
    args = ['-c', command];
  }

  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(cmd, args, {
      cwd: effectiveCwd,
      timeout,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (c) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += c.toString();
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = killed ? 124 : (code ?? 0);
      const trimmedStderr = stderr.trim();
      let errorAnalysis = null;
      if (exitCode !== 0 || trimmedStderr.length > 0) {
        const lines = trimmedStderr
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const errorLine =
          lines.find((l) => l.includes('Error') || l.includes('Exception')) ||
          lines[lines.length - 1] ||
          'Non-zero exit';
        errorAnalysis = {
          hasError: true,
          exitCode,
          primaryError: errorLine,
          stderrLines: lines.slice(-6),
        };
      }
      resolvePromise({
        stdout: stdout.trim(),
        stderr: trimmedStderr,
        exitCode,
        duration: Date.now() - start,
        cwd: effectiveCwd,
        killed,
        errorAnalysis,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: '',
        stderr: err.message,
        exitCode: 127,
        duration: Date.now() - start,
        cwd: effectiveCwd,
        errorAnalysis: {
          hasError: true,
          exitCode: 127,
          primaryError: err.message,
        },
      });
    });
  });
}

/**
 * Get comprehensive system hardware, OS, memory, CPU, storage, and network information.
 */
export async function getSystemInfo() {
  const isWin = process.platform === 'win32';
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();

  const info = {
    platform: os.platform(),
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptimeSeconds: Math.floor(os.uptime()),
    uptimeFormatted: formatUptime(os.uptime()),
    cpu: {
      model: cpus[0]?.model || 'Generic Processor',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed || 0,
      loadAverage: loadAvg,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: Math.round((usedMem / totalMem) * 100),
      totalFormatted: (totalMem / 1024 ** 3).toFixed(1) + ' GB',
      usedFormatted: (usedMem / 1024 ** 3).toFixed(1) + ' GB',
      freeFormatted: (freeMem / 1024 ** 3).toFixed(1) + ' GB',
    },
    user: {
      username: os.userInfo()?.username || 'user',
      homedir: os.homedir(),
    },
    disks: [],
    battery: null,
  };

  if (isWin) {
    try {
      const diskRes = await executeSystemCommand(
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType, FreeSpace, Size, VolumeName | ConvertTo-Json -Compress',
        { timeout: 5000 },
      );
      if (diskRes.stdout) {
        let rawDisks = JSON.parse(diskRes.stdout);
        if (!Array.isArray(rawDisks)) rawDisks = [rawDisks];
        info.disks = rawDisks
          .filter((d) => d.Size)
          .map((d) => {
            const size = Number(d.Size);
            const free = Number(d.FreeSpace);
            const used = size - free;
            return {
              drive: d.DeviceID,
              volumeName: d.VolumeName || '',
              totalFormatted: (size / 1024 ** 3).toFixed(1) + ' GB',
              freeFormatted: (free / 1024 ** 3).toFixed(1) + ' GB',
              usedFormatted: (used / 1024 ** 3).toFixed(1) + ' GB',
              usedPercent: Math.round((used / size) * 100),
            };
          });
      }
    } catch {}

    try {
      const battRes = await executeSystemCommand(
        'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress',
        { timeout: 3000 },
      );
      if (battRes.stdout) {
        let rawBatt = JSON.parse(battRes.stdout);
        if (Array.isArray(rawBatt)) rawBatt = rawBatt[0];
        if (rawBatt?.EstimatedChargeRemaining !== undefined) {
          info.battery = {
            chargePercent: rawBatt.EstimatedChargeRemaining,
            status:
              rawBatt.BatteryStatus === 2
                ? 'Charging'
                : rawBatt.BatteryStatus === 1
                  ? 'Discharging'
                  : 'AC Connected',
          };
        }
      }
    } catch {}
  }

  return info;
}

/**
 * List running processes sorted by memory or CPU.
 */
export async function listProcesses({ limit = 30, sortBy = 'memory' } = {}) {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const sortField = sortBy === 'cpu' ? 'CPU' : 'WS';
    const psCmd = `Get-Process | Where-Object { $_.ProcessName -ne 'Idle' } | Sort-Object -Descending ${sortField} | Select-Object -First ${limit} -Property Id, ProcessName, @{Name='WorkingSetMB';Expression={[math]::Round($_.WS / 1MB, 1)}}, @{Name='CPU_s';Expression={[math]::Round($_.CPU, 1)}} | ConvertTo-Json -Compress`;
    const res = await executeSystemCommand(psCmd, { timeout: 6000 });
    if (res.stdout) {
      try {
        let parsed = JSON.parse(res.stdout);
        if (!Array.isArray(parsed)) parsed = [parsed];
        return {
          processes: parsed.map((p) => ({
            pid: p.Id,
            name: p.ProcessName,
            memoryMB: p.WorkingSetMB,
            cpuSeconds: p.CPU_s || 0,
          })),
          count: parsed.length,
        };
      } catch (err) {
        return {
          error: `Failed to parse process list: ${err.message}`,
          raw: res.stdout,
        };
      }
    }
    return { processes: [], error: res.stderr || 'No output' };
  } else {
    const res = await executeSystemCommand(
      `ps aux --sort=-%mem | head -n ${limit + 1}`,
      { timeout: 5000 },
    );
    return { output: res.stdout, error: res.stderr };
  }
}

/**
 * Kill/terminate a running process by PID or name.
 */
export async function killProcess(identifier) {
  if (identifier === undefined || identifier === null || identifier === '') {
    throw new Error('Process ID or process name required');
  }
  const isWin = process.platform === 'win32';
  const idStr = String(identifier).trim();
  const isNum = /^\d+$/.test(idStr);

  if (isWin) {
    const cmd = isNum
      ? `Stop-Process -Id ${idStr} -Force`
      : `Stop-Process -Name "${idStr}" -Force`;
    const res = await executeSystemCommand(cmd, { timeout: 5000 });
    return {
      success: res.exitCode === 0,
      target: identifier,
      output:
        res.stdout ||
        (res.exitCode === 0 ? `Terminated process ${identifier}` : res.stderr),
      exitCode: res.exitCode,
    };
  } else {
    const cmd = isNum ? `kill -9 ${idStr}` : `pkill -9 "${idStr}"`;
    const res = await executeSystemCommand(cmd, { timeout: 5000 });
    return {
      success: res.exitCode === 0,
      target: identifier,
      exitCode: res.exitCode,
    };
  }
}

/**
 * Launch an application, open a file or folder, or open a URL with default system handler.
 */
export async function openAppOrFile(target) {
  if (!target || typeof target !== 'string')
    throw new Error('Target app name, file path, or URL required');
  const isWin = process.platform === 'win32';
  const trimmed = target.trim();

  // Handle URL
  if (/^https?:\/\//i.test(trimmed)) {
    if (isWin) {
      await executeSystemCommand(`Start-Process "${trimmed}"`, {
        timeout: 5000,
      });
    } else {
      await executeSystemCommand(`xdg-open "${trimmed}" || open "${trimmed}"`, {
        timeout: 5000,
      });
    }
    return { success: true, opened: trimmed, type: 'url' };
  }

  // Common application aliases on Windows
  const appAliases = {
    notepad: 'notepad.exe',
    calc: 'calc.exe',
    calculator: 'calc.exe',
    code: 'code',
    vscode: 'code',
    explorer: 'explorer.exe',
    chrome: 'chrome.exe',
    browser: 'start msedge',
    spotify: 'spotify.exe',
    terminal: 'wt.exe',
    powershell: 'powershell.exe',
    cmd: 'cmd.exe',
    taskmgr: 'taskmgr.exe',
    settings: 'start ms-settings:',
  };

  const appToRun = appAliases[trimmed.toLowerCase()] || trimmed;

  if (isWin) {
    let cmdToExec;
    if (appToRun.startsWith('start ')) {
      cmdToExec = `cmd /c ${appToRun}`;
    } else {
      cmdToExec = `Start-Process -FilePath "${appToRun}" -ErrorAction SilentlyContinue`;
    }
    const res = await executeSystemCommand(cmdToExec, { timeout: 5000 });
    return {
      success: res.exitCode === 0,
      opened: trimmed,
      command: cmdToExec,
      message:
        res.exitCode === 0 ? `Successfully launched ${trimmed}` : res.stderr,
    };
  } else {
    const res = await executeSystemCommand(
      `xdg-open "${appToRun}" || open "${appToRun}"`,
      { timeout: 5000 },
    );
    return { success: res.exitCode === 0, opened: trimmed };
  }
}

/**
 * Capture full desktop screenshot and save to public/screenshots/ for immediate preview and vision analysis.
 */
export async function takeScreenshot({ filename = null } = {}) {
  await ensureWorkspace();
  const isWin = process.platform === 'win32';
  const name = filename || `screenshot_${Date.now()}.png`;
  const sanitizedName = name.endsWith('.png') ? name : `${name}.png`;
  const fullPath = join(SCREENSHOTS_DIR, sanitizedName);
  const webUrl = `/screenshots/${sanitizedName}`;

  if (isWin) {
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bitmap.Save('${fullPath.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose();`;
    const res = await executeSystemCommand(psScript, { timeout: 8000 });
    if (res.exitCode !== 0) {
      return {
        success: false,
        error: res.stderr || 'Screenshot capture failed',
      };
    }
  } else {
    // Linux/macOS fallback
    await executeSystemCommand(
      `import -window root "${fullPath}" || screencapture "${fullPath}"`,
      { timeout: 8000 },
    );
  }

  let size = 0;
  try {
    const st = await fs.stat(fullPath);
    size = st.size;
  } catch {}

  return {
    success: true,
    filename: sanitizedName,
    url: webUrl,
    fullPath: fullPath.replace(/\\/g, '/'),
    sizeBytes: size,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Read the current clipboard text.
 */
export async function getClipboard() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const res = await executeSystemCommand('Get-Clipboard | Out-String', {
      timeout: 8000,
    });
    return { text: (res.stdout || '').trim() };
  } else {
    const res = await executeSystemCommand('xclip -o || pbpaste', {
      timeout: 8000,
    });
    return { text: (res.stdout || '').trim() };
  }
}

/**
 * Set text onto the system clipboard.
 */
export async function setClipboard(text) {
  if (typeof text !== 'string') text = String(text || '');
  const isWin = process.platform === 'win32';
  if (isWin) {
    const encoded = Buffer.from(text, 'utf-8').toString('base64');
    const cmd = `$bytes = [System.Convert]::FromBase64String("${encoded}"); $str = [System.Text.Encoding]::UTF8.GetString($bytes); Set-Clipboard -Value $str;`;
    const res = await executeSystemCommand(cmd, { timeout: 8000 });
    return { success: res.exitCode === 0, bytes: Buffer.byteLength(text) };
  } else {
    const res = await executeSystemCommand(
      `printf "%s" "${text.replace(/"/g, '\\"')}" | (xclip -selection clipboard || pbcopy)`,
      { timeout: 8000 },
    );
    return { success: res.exitCode === 0 };
  }
}

/**
 * Read any text file on the entire computer.
 */
export async function readSystemFile(
  filePath,
  { maxBytes = 1024 * 1024 } = {},
) {
  if (!filePath) throw new Error('File path is required');
  const target = resolve(filePath);
  const stat = await fs.stat(target);
  if (stat.size > maxBytes) {
    throw new Error(
      `File size ${(stat.size / 1024).toFixed(0)} KB exceeds max limit ${(maxBytes / 1024).toFixed(0)} KB`,
    );
  }
  const content = await fs.readFile(target, 'utf-8');
  return { path: target.replace(/\\/g, '/'), content, size: stat.size };
}

/**
 * Write/create a file anywhere on the computer. Automatically creates directories.
 */
export async function writeSystemFile(filePath, content) {
  if (!filePath) throw new Error('File path is required');
  const target = resolve(filePath);
  await fs.mkdir(resolve(target, '..'), { recursive: true });
  await fs.writeFile(target, content ?? '', 'utf-8');
  const bytes = Buffer.byteLength(content ?? '');
  return {
    path: target.replace(/\\/g, '/'),
    bytesWritten: bytes,
    success: true,
  };
}

/**
 * List files and directories anywhere on the computer (drives, Desktop, Documents, etc.).
 */
export async function listSystemDirectory(dirPath = '.') {
  const target = resolve(dirPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file',
    path: join(target, e.name).replace(/\\/g, '/'),
  }));
  return { path: target.replace(/\\/g, '/'), count: items.length, items };
}

/**
 * Search for files matching a pattern or extension across a folder or drive.
 */
export async function searchSystemFiles(
  searchDir = '.',
  { pattern = '*', maxResults = 50 } = {},
) {
  const target = resolve(searchDir);
  const isWin = process.platform === 'win32';
  if (isWin) {
    const filter = pattern.includes('*') ? pattern : `*${pattern}*`;
    const psCmd = `Get-ChildItem -Path "${target}" -Filter "${filter}" -Recurse -ErrorAction SilentlyContinue | Select-Object -First ${maxResults} -Property FullName, Length, Extension, LastWriteTime | ConvertTo-Json -Compress`;
    const res = await executeSystemCommand(psCmd, { timeout: 12000 });
    if (res.stdout) {
      try {
        let raw = JSON.parse(res.stdout);
        if (!Array.isArray(raw)) raw = [raw];
        return {
          searchDir: target.replace(/\\/g, '/'),
          matches: raw.map((m) => ({
            path: (m.FullName || '').replace(/\\/g, '/'),
            sizeBytes: m.Length || 0,
            modified: m.LastWriteTime,
          })),
        };
      } catch {}
    }
  }
  return { searchDir: target.replace(/\\/g, '/'), matches: [] };
}

/**
 * Control system media keys and volume (mute, unmute, volume up/down, play/pause, next, prev).
 */
export async function controlMediaVolume({ action = 'mute' } = {}) {
  const isWin = process.platform === 'win32';
  if (!isWin) return { error: 'Platform not supported for media control' };

  const keyMap = {
    mute: 173,
    volume_down: 174,
    volume_up: 175,
    play_pause: 179,
    next: 176,
    prev: 177,
  };

  const code = keyMap[action.toLowerCase()];
  if (code) {
    const psScript = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]${code});`;
    await executeSystemCommand(psScript, { timeout: 3000 });
    return { success: true, action };
  }

  return {
    error: `Unknown media action: ${action}. Available: mute, volume_down, volume_up, play_pause, next, prev`,
  };
}

/**
 * Send a native Windows OS toast notification.
 */
export async function systemNotify(title, message) {
  const isWin = process.platform === 'win32';
  const cleanTitle = (title || 'JARVIS Notification').replace(/"/g, '`"');
  const cleanMsg = (message || 'Task completed.').replace(/"/g, '`"');

  if (isWin) {
    const psScript = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;
$xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${cleanTitle}</text>
      <text>${cleanMsg}</text>
    </binding>
  </visual>
</toast>
"@;
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument;
$doc.LoadXml($xml);
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("JARVIS").Show($toast);`;
    const res = await executeSystemCommand(psScript, { timeout: 4000 });
    return { success: res.exitCode === 0, title, message };
  }
  return { success: true, title, message };
}

// ── 2.6 Desktop Window & Input Management ──

/**
 * List all open application windows currently visible on the desktop with PID and title.
 */
export async function listWindows() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const psCmd = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
    const res = await executeSystemCommand(psCmd, { timeout: 6000 });
    if (res.stdout) {
      try {
        let parsed = JSON.parse(res.stdout);
        if (!Array.isArray(parsed)) parsed = [parsed];
        return {
          windows: parsed.map((w) => ({
            pid: w.Id,
            process: w.ProcessName,
            title: w.MainWindowTitle,
          })),
          count: parsed.length,
        };
      } catch (err) {
        return { windows: [], error: err.message, raw: res.stdout };
      }
    }
    return { windows: [], count: 0 };
  }
  return {
    windows: [],
    count: 0,
    note: 'Window listing not supported on this platform',
  };
}

/**
 * Bring a window to foreground focus by PID or Window Title substring.
 */
export async function focusWindow(identifier) {
  if (identifier === undefined || identifier === null || identifier === '') {
    throw new Error('Process ID or window title required');
  }
  const isWin = process.platform === 'win32';
  if (isWin) {
    const idStr = String(identifier).replace(/"/g, '`"');
    const isNum = /^\d+$/.test(idStr);
    const psScript = `
$wscript = New-Object -ComObject WScript.Shell;
if (${isNum}) {
  $p = Get-Process -Id ${idStr} -ErrorAction SilentlyContinue;
  if ($p) { $res = $wscript.AppActivate($p.Id) } else { $res = $false }
} else {
  $res = $wscript.AppActivate("${idStr}")
}
Write-Output $res;
`;
    const res = await executeSystemCommand(psScript, { timeout: 4000 });
    const success = (res.stdout || '').toLowerCase().includes('true');
    return {
      success,
      target: identifier,
      message: success
        ? `Brought window '${identifier}' to front.`
        : `Could not activate window matching '${identifier}'.`,
    };
  }
  return { success: false, error: 'Platform not supported' };
}

/**
 * Request a window to gracefully close by PID or Window Title.
 */
export async function closeWindow(identifier) {
  if (identifier === undefined || identifier === null || identifier === '') {
    throw new Error('Process ID or window title required');
  }
  const isWin = process.platform === 'win32';
  if (isWin) {
    const idStr = String(identifier).replace(/"/g, '`"');
    const isNum = /^\d+$/.test(idStr);
    const psScript = isNum
      ? `$p = Get-Process -Id ${idStr} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() }`
      : `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${idStr}*" -or $_.ProcessName -like "*${idStr}*" } | Select-Object -First 1; if ($p) { $p.CloseMainWindow() }`;
    const res = await executeSystemCommand(psScript, { timeout: 4000 });
    return {
      success: res.exitCode === 0,
      target: identifier,
      message: `Close signal sent to window '${identifier}'.`,
    };
  }
  return { success: false, error: 'Platform not supported' };
}

/**
 * Send keystrokes or shortcut combinations to the currently active window.
 * Supports keys like {ENTER}, {TAB}, ^c (Ctrl+C), ^v (Ctrl+V), %{TAB} (Alt+Tab), etc.
 */
export async function sendKeys(keys) {
  if (!keys || typeof keys !== 'string') {
    throw new Error(
      'Keys string required (e.g. "{ENTER}", "Hello World", "^c")',
    );
  }
  const isWin = process.platform === 'win32';
  if (isWin) {
    const sanitized = keys.replace(/"/g, '`"');
    const psScript = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys("${sanitized}");`;
    const res = await executeSystemCommand(psScript, { timeout: 3000 });
    return { success: res.exitCode === 0, keysSent: keys };
  }
  return { success: false, error: 'Platform not supported' };
}

// ── 2.7 Autonomous Scheduler & Timer Engine ──

const activeTimers = new Map();

/** Read schedules list from disk */
export async function readSchedules() {
  await ensureWorkspace();
  try {
    const raw = await fs.readFile(SCHEDULES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Write schedules list to disk */
async function writeSchedules(schedules) {
  await ensureWorkspace();
  await fs.writeFile(
    SCHEDULES_FILE,
    JSON.stringify(schedules, null, 2),
    'utf-8',
  );
}

/**
 * Schedule a task to execute after a delay (in seconds) or periodically.
 * Can execute a shell command, a tool, or dispatch a system notification/alarm.
 */
export async function scheduleTask({
  id = null,
  name = 'Automated Task',
  delaySeconds = 0,
  intervalSeconds = 0,
  tool = null,
  command = null,
  args = {},
  message = null,
}) {
  await ensureWorkspace();
  const taskId =
    id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const delayMs = Math.max(1, (Number(delaySeconds) || 0) * 1000);
  const intervalMs = (Number(intervalSeconds) || 0) * 1000;

  const taskDef = {
    id: taskId,
    name,
    tool,
    command,
    args,
    message,
    delaySeconds: Number(delaySeconds) || 0,
    intervalSeconds: Number(intervalSeconds) || 0,
    createdAt: now,
    status: 'scheduled',
    runCount: 0,
    lastRunAt: null,
    lastResult: null,
  };

  const runAction = async () => {
    taskDef.lastRunAt = new Date().toISOString();
    taskDef.runCount += 1;
    let result = null;

    try {
      if (message) {
        result = await systemNotify(name, message);
      } else if (command) {
        result = await executeSystemCommand(command);
      } else if (tool) {
        result = await executeTool(tool, args);
      }
      taskDef.lastResult = result;
      taskDef.status = intervalMs > 0 ? 'active' : 'completed';
    } catch (err) {
      taskDef.lastResult = { error: err.message };
      taskDef.status = 'error';
    }

    const currentSchedules = await readSchedules();
    const idx = currentSchedules.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      currentSchedules[idx] = { ...currentSchedules[idx], ...taskDef };
      await writeSchedules(currentSchedules);
    }
  };

  // Schedule execution in memory
  if (intervalMs > 0) {
    const handle = setInterval(runAction, intervalMs);
    handle?.unref?.();
    activeTimers.set(taskId, { type: 'interval', handle });
    taskDef.status = 'active';
  } else {
    const handle = setTimeout(async () => {
      await runAction();
      activeTimers.delete(taskId);
    }, delayMs);
    handle?.unref?.();
    activeTimers.set(taskId, { type: 'timeout', handle });
  }

  const currentSchedules = await readSchedules();
  currentSchedules.push(taskDef);
  await writeSchedules(currentSchedules);

  return {
    success: true,
    task: taskDef,
    message: `Scheduled task '${name}' (ID: ${taskId}) to run in ${delaySeconds}s${intervalSeconds ? ` every ${intervalSeconds}s` : ''}.`,
  };
}

/** List all scheduled tasks and alarms */
export async function listScheduledTasks() {
  const schedules = await readSchedules();
  return {
    tasks: schedules,
    activeCount: schedules.filter(
      (s) => s.status === 'scheduled' || s.status === 'active',
    ).length,
    totalCount: schedules.length,
  };
}

/** Cancel a scheduled task by ID */
export async function cancelScheduledTask(taskId) {
  if (activeTimers.has(taskId)) {
    const item = activeTimers.get(taskId);
    if (item.type === 'interval') clearInterval(item.handle);
    if (item.type === 'timeout') clearTimeout(item.handle);
    activeTimers.delete(taskId);
  }

  const schedules = await readSchedules();
  const task = schedules.find((t) => t.id === taskId);
  if (task) {
    task.status = 'cancelled';
    await writeSchedules(schedules);
    return { success: true, taskId, message: `Task '${task.name}' cancelled.` };
  }
  return { success: false, taskId, message: `Task '${taskId}' not found.` };
}

// ── 2.8 System Health Diagnostics & Optimizer ──

/**
 * Complete system health diagnostic check: CPU, RAM, Disk, background load, and health rating.
 */
export async function diagnoseSystem() {
  const sys = await getSystemInfo();
  const procRes = await listProcesses({ limit: 10, sortBy: 'memory' });

  let healthScore = 100;
  const issues = [];
  const recommendations = [];

  // 1. Memory check
  if (sys.memory.usedPercent > 90) {
    healthScore -= 30;
    issues.push(
      `RAM usage is critical at ${sys.memory.usedPercent}% (${sys.memory.usedFormatted} used)`,
    );
    recommendations.push('Terminate unused background apps or browser tabs.');
  } else if (sys.memory.usedPercent > 80) {
    healthScore -= 15;
    issues.push(`RAM usage is high at ${sys.memory.usedPercent}%`);
  }

  // 2. Disk storage check
  if (sys.disks && sys.disks.length > 0) {
    for (const disk of sys.disks) {
      if (disk.usedPercent > 90) {
        healthScore -= 20;
        issues.push(
          `Drive ${disk.drive} is nearly full (${disk.usedPercent}% used, only ${disk.freeFormatted} free)`,
        );
        recommendations.push(
          `Run clean_temp_files or free disk space on drive ${disk.drive}.`,
        );
      }
    }
  }

  // 3. Health status category
  healthScore = Math.max(0, healthScore);
  let status = 'OPTIMAL';
  let grade = 'A';
  if (healthScore < 60) {
    status = 'CRITICAL';
    grade = 'D';
  } else if (healthScore < 80) {
    status = 'WARNING';
    grade = 'C';
  } else if (healthScore < 95) {
    status = 'GOOD';
    grade = 'B';
  }

  return {
    healthScore,
    grade,
    status,
    uptime: sys.uptimeFormatted,
    memory: sys.memory,
    cpu: {
      model: sys.cpu.model,
      cores: sys.cpu.cores,
      speedMHz: sys.cpu.speedMHz,
    },
    disks: sys.disks,
    battery: sys.battery,
    issues,
    recommendations: recommendations.length
      ? recommendations
      : ['System running smoothly at peak performance.'],
    topProcesses: procRes.processes ? procRes.processes.slice(0, 5) : [],
  };
}

/**
 * Clean temporary files in .jarvis-workspace/.sandbox to reclaim space.
 */
export async function cleanTempFiles() {
  await ensureWorkspace();
  let freedCount = 0;
  let freedBytes = 0;

  try {
    const entries = await fs.readdir(CODE_SANDBOX, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('run_')) {
        const full = join(CODE_SANDBOX, entry.name);
        try {
          const st = await fs.stat(full);
          await fs.unlink(full);
          freedCount += 1;
          freedBytes += st.size;
        } catch {}
      }
    }
  } catch {}

  return {
    success: true,
    freedFiles: freedCount,
    freedBytes,
    freedFormatted: (freedBytes / 1024).toFixed(1) + ' KB',
    message: `Cleaned ${freedCount} temporary execution files (${(freedBytes / 1024).toFixed(1)} KB freed).`,
  };
}

/**
 * Ping a remote host or website to test network reachability and latency.
 */
export async function pingHost(host = '8.8.8.8') {
  const isWin = process.platform === 'win32';
  const cleanHost = String(host).replace(/[^a-zA-Z0-9.-]/g, '');
  if (isWin) {
    const res = await executeSystemCommand(
      `Test-Connection -ComputerName "${cleanHost}" -Count 2 | Select-Object ResponseTime, StatusCode | ConvertTo-Json -Compress`,
      { timeout: 6000 },
    );
    if (res.stdout) {
      try {
        let parsed = JSON.parse(res.stdout);
        if (!Array.isArray(parsed)) parsed = [parsed];
        const times = parsed
          .map((p) => p.ResponseTime)
          .filter((t) => typeof t === 'number');
        const avg = times.length
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : null;
        return {
          host: cleanHost,
          reachable: true,
          latencyMs: avg,
          samples: parsed,
        };
      } catch {}
    }
    // Fallback standard ping
    const pingRes = await executeSystemCommand(`ping -n 2 "${cleanHost}"`, {
      timeout: 6000,
    });
    const reachable = pingRes.exitCode === 0;
    return {
      host: cleanHost,
      reachable,
      raw: pingRes.stdout.slice(0, 300),
    };
  }
  const pingRes = await executeSystemCommand(`ping -c 2 "${cleanHost}"`, {
    timeout: 6000,
  });
  return {
    host: cleanHost,
    reachable: pingRes.exitCode === 0,
    raw: pingRes.stdout.slice(0, 300),
  };
}

// ── 3. Web Scraper ──

/** Fetch content from a URL and return text/html content. */
export async function scrapeUrl(url, { maxBytes = 100_000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS-GodsEyeView/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, url };

    const contentType = res.headers.get('content-type') || '';
    const buffer = await res.arrayBuffer();
    let text = new TextDecoder().decode(buffer.slice(0, maxBytes));

    // Strip HTML tags for readability
    if (contentType.includes('html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return { url, content: text.slice(0, maxBytes), contentType };
  } catch (err) {
    return { error: err.message, url };
  }
}

// ── 4. Calculator ──

/** Evaluate a math expression safely. */
export function calculate(expression) {
  // Whitelist only safe math characters and functions
  const sanitized = expression.replace(/[^0-9+\-*/().%,\s^eE]/g, '');
  if (
    sanitized !==
    expression
      .replace(/\s/g, '')
      .replace(/Math\.\w+/g, '')
      .replace(/[a-z]+/gi, '')
  ) {
    // Allow Math.* functions
  }
  try {
    // Build a safe evaluator using Function constructor with Math in scope
    const mathFns =
      'const {abs,ceil,floor,round,sqrt,pow,log,log2,log10,sin,cos,tan,PI,E,min,max,random}=Math;';
    const fn = new Function(mathFns + `return (${expression});`);
    const result = fn();
    if (typeof result !== 'number' || !isFinite(result)) {
      return { expression, result: String(result), error: null };
    }
    return { expression, result, error: null };
  } catch (err) {
    return { expression, result: null, error: err.message };
  }
}

// ── 5. Persistent Memory ──

/** Read the full memory store. */
export async function readMemory() {
  await ensureWorkspace();
  try {
    const raw = await fs.readFile(MEMORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Set a key-value pair in memory with optional category and tags. */
export async function setMemory(
  key,
  value,
  { category = 'general', tags = [] } = {},
) {
  if (!key || typeof key !== 'string') {
    throw new Error('Memory key must be a non-empty string');
  }
  const mem = await readMemory();
  const existing = mem[key] || {};
  const normalizedTags = Array.isArray(tags)
    ? tags.map((t) => String(t).trim()).filter(Boolean)
    : typeof tags === 'string'
      ? tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

  mem[key] = {
    value,
    category: String(category || existing.category || 'general').toLowerCase(),
    tags: normalizedTags.length > 0 ? normalizedTags : existing.tags || [],
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessCount: (existing.accessCount || 0) + 1,
  };
  await fs.writeFile(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf-8');
  return { key, stored: true, category: mem[key].category };
}

/** Delete a key from memory. */
export async function deleteMemory(key) {
  if (!key) return { key, deleted: false };
  const mem = await readMemory();
  const existed = Object.prototype.hasOwnProperty.call(mem, key);
  delete mem[key];
  await fs.writeFile(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf-8');
  return { key, deleted: existed };
}

/** Search memory by partial key, tag, or content match with relevance scoring. */
export async function searchMemory(
  query,
  { category = null, limit = 50 } = {},
) {
  const mem = await readMemory();
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const cat =
    typeof category === 'string' ? category.trim().toLowerCase() : null;

  const entries = Object.entries(mem);
  const scored = [];

  for (const [k, v] of entries) {
    const itemCategory = (v.category || 'general').toLowerCase();
    if (cat && itemCategory !== cat) continue;

    const valStr = JSON.stringify(v?.value ?? '').toLowerCase();
    const keyLower = k.toLowerCase();
    const tagsLower = Array.isArray(v?.tags)
      ? v.tags.map((t) => String(t).toLowerCase())
      : [];

    let score = 0;
    if (!q) {
      score = 1;
    } else {
      if (keyLower === q) score += 100;
      else if (keyLower.startsWith(q)) score += 50;
      else if (keyLower.includes(q)) score += 25;

      if (tagsLower.includes(q)) score += 40;
      else if (tagsLower.some((t) => t.includes(q))) score += 20;

      if (valStr.includes(q)) score += 15;
    }

    if (score > 0) {
      scored.push({
        key: k,
        ...v,
        score,
      });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  const matches = scored.slice(0, limit);
  const result = Object.fromEntries(matches.map((m) => [m.key, m]));
  result.matches = matches;
  result.count = matches.length;
  result.totalStored = entries.length;
  return result;
}

/** Get memory system diagnostic statistics */
export async function getMemoryStats() {
  const mem = await readMemory();
  const keys = Object.keys(mem);
  const categories = {};
  for (const k of keys) {
    const c = mem[k]?.category || 'general';
    categories[c] = (categories[c] || 0) + 1;
  }
  return {
    totalKeys: keys.length,
    categories,
    lastUpdated:
      keys.length > 0
        ? keys
            .map((k) => mem[k]?.updatedAt)
            .filter(Boolean)
            .sort()
            .reverse()[0] || null
        : null,
  };
}

// ── 6. Conversation Session Management ──

/** Save a conversation session. */
export async function saveSession(sessionId, data) {
  await ensureWorkspace();
  const filepath = join(SESSIONS_DIR, `${sessionId}.json`);
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
  return { sessionId, saved: true };
}

/** Load a conversation session. */
export async function loadSession(sessionId) {
  await ensureWorkspace();
  const filepath = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** List all saved sessions. */
export async function listSessions() {
  await ensureWorkspace();
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    const sessions = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        const raw = await fs.readFile(join(SESSIONS_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        sessions.push({
          id: file.replace('.json', ''),
          title: data.title || 'Untitled',
          mode: data.mode || 'general',
          messageCount: data.messages?.length || 0,
          updatedAt: data.updatedAt || null,
          createdAt: data.createdAt || null,
        });
      } catch {
        /* skip corrupted sessions */
      }
    }
    return sessions.sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
  } catch {
    return [];
  }
}

/** Delete a session. */
export async function deleteSession(sessionId) {
  await ensureWorkspace();
  const filepath = join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    await fs.unlink(filepath);
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

// ── 7. Tool Router: AI calls tools by name ──

const TOOL_REGISTRY = {
  // Sandboxed Code & Workspace Files
  execute_code: async (args) =>
    executeCode(args.language, args.code, { timeout: args.timeout }),
  debug_code: async (args) =>
    debugCode(args.language, args.code, {
      expectedBehavior: args.expectedBehavior,
    }),
  list_files: async (args) => listFiles(args.path),
  read_file: async (args) => readFile(args.path),
  write_file: async (args) => writeFile(args.path, args.content),
  delete_file: async (args) => deleteFile(args.path),
  scrape_url: async (args) => scrapeUrl(args.url),
  calculate: async (args) => calculate(args.expression),
  remember: async (args) =>
    setMemory(args.key, args.value, {
      category: args.category,
      tags: args.tags,
    }),
  recall: async (args) =>
    searchMemory(args.query, {
      category: args.category,
      limit: args.limit,
    }),
  forget: async (args) => deleteMemory(args.key),
  memory_stats: async () => getMemoryStats(),
  get_memory_stats: async () => getMemoryStats(),

  // Full Computer & Host Automation
  system_command: async (args) =>
    executeSystemCommand(args.command, {
      cwd: args.cwd,
      timeout: args.timeout,
    }),
  execute_system_command: async (args) =>
    executeSystemCommand(args.command, {
      cwd: args.cwd,
      timeout: args.timeout,
    }),
  system_info: async () => getSystemInfo(),
  get_system_info: async () => getSystemInfo(),
  list_processes: async (args) => listProcesses(args),
  kill_process: async (args) =>
    killProcess(args.identifier || args.pid || args.name),
  open_app_or_file: async (args) =>
    openAppOrFile(args.target || args.app || args.path),
  open_app: async (args) => openAppOrFile(args.target || args.app || args.path),
  take_screenshot: async (args) => takeScreenshot(args),
  get_clipboard: async () => getClipboard(),
  set_clipboard: async (args) => setClipboard(args.text),
  read_system_file: async (args) =>
    readSystemFile(args.path || args.filePath, { maxBytes: args.maxBytes }),
  write_system_file: async (args) =>
    writeSystemFile(args.path || args.filePath, args.content),
  list_system_directory: async (args) =>
    listSystemDirectory(args.path || args.dirPath),
  search_system_files: async (args) =>
    searchSystemFiles(args.searchDir || args.path, {
      pattern: args.pattern,
      maxResults: args.maxResults,
    }),
  control_media_volume: async (args) => controlMediaVolume(args),
  system_notify: async (args) => systemNotify(args.title, args.message),

  // Desktop Windows & Input
  list_windows: async () => listWindows(),
  focus_window: async (args) =>
    focusWindow(args.identifier || args.title || args.pid),
  close_window: async (args) =>
    closeWindow(args.identifier || args.title || args.pid),
  send_keys: async (args) => sendKeys(args.keys),

  // Autonomous Task Scheduler
  schedule_task: async (args) => scheduleTask(args),
  list_scheduled_tasks: async () => listScheduledTasks(),
  cancel_scheduled_task: async (args) =>
    cancelScheduledTask(args.taskId || args.id),

  // System Health & Diagnostics
  diagnose_system: async () => diagnoseSystem(),
  clean_temp_files: async () => cleanTempFiles(),
  ping_host: async (args) => pingHost(args.host),

  // Generative AI & Vision
  generate_image: async (args) => generateImage(args),
  analyze_image: async (args) => analyzeImage(args),
};

/** Tool schemas for AI function calling */
export const JARVIS_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an AI image or artwork using NVIDIA GenAI models (Stable Diffusion 3 / Flux). Saves image to public assets and returns the web URL.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed visual prompt describing the image to generate',
          },
          aspect_ratio: {
            type: 'string',
            enum: ['1:1', '16:9', '9:16', '4:3', '3:2'],
            description: 'Aspect ratio (default 1:1)',
          },
          negative_prompt: {
            type: 'string',
            description: 'What to exclude from the image',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description:
        'Analyze an image or screenshot using multimodal vision models. Identifies objects, spatial coordinates, labels, and text.',
      parameters: {
        type: 'object',
        properties: {
          image: {
            type: 'string',
            description: 'Base64 image data or URL to inspect',
          },
          prompt: {
            type: 'string',
            description: 'Analysis question or prompt regarding the image',
          },
        },
        required: ['image'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description:
        'Execute code in a sandboxed environment. Supports javascript, typescript, python, bash, shell, powershell. Returns stdout, stderr, exit code, and errorAnalysis. Use for running code, tests, and data processing.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: [
              'javascript',
              'python',
              'bash',
              'shell',
              'powershell',
              'typescript',
            ],
          },
          code: { type: 'string', description: 'The source code to execute' },
          timeout: {
            type: 'number',
            description: 'Max execution time in ms (default 30000)',
          },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_code',
      description:
        'Execute code and receive structured diagnostic feedback (traceback, failing line, error analysis, suggestions). Use during iterative debugging loops to find and fix bugs.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: [
              'javascript',
              'python',
              'bash',
              'shell',
              'powershell',
              'typescript',
            ],
          },
          code: {
            type: 'string',
            description: 'The source code to execute and debug',
          },
          expectedBehavior: {
            type: 'string',
            description: 'Expected output or requirement',
          },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in the JARVIS workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path within workspace (default ".")',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the JARVIS workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write/create a file in the JARVIS workspace. Creates directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path for new file' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scrape_url',
      description:
        'Fetch and extract text content from a URL. HTML is cleaned to plain text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description:
        'Evaluate a mathematical expression. Supports basic arithmetic, Math functions (sqrt, pow, sin, cos, log, PI, E, etc).',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Math expression to evaluate',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Store a key-value pair in persistent memory. Use to remember facts, user preferences, mission context across conversations.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Memory key (e.g. "user_name", "project_stack")',
          },
          value: { type: 'string', description: 'Value to remember' },
          category: {
            type: 'string',
            enum: ['general', 'tactical', 'preferences', 'mission', 'system'],
            description:
              'Optional category classification for structured memory',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional semantic tags for associative retrieval',
          },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description:
        'Search persistent memory by keyword. Returns matching stored key-value pairs.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query to match against memory keys, tags, and values',
          },
          category: {
            type: 'string',
            description: 'Optional category filter',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_stats',
      description:
        'Get diagnostic statistics on stored persistent memory, categories breakdown, and recency.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // ── Host Computer Automation Tool Schemas ──
  {
    type: 'function',
    function: {
      name: 'system_command',
      description:
        'Execute any terminal, shell, or PowerShell command directly on this computer. Returns stdout, stderr, exitCode, and execution duration. Use for running scripts, git commands, system utilities, testing, and automation.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell / PowerShell command to execute',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory path (optional, defaults to project root)',
          },
          timeout: {
            type: 'number',
            description: 'Maximum execution time in ms (default 30000)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description:
        'Inspect full computer hardware and OS telemetry: CPU model/cores/load, RAM total/used/free %, platform, OS version, disk drives with free/used storage, uptime, battery status.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_processes',
      description:
        'List running computer processes with PID, ProcessName, memory (WorkingSet MB), and CPU time. Use to monitor system activity or identify heavy processes.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of processes to return (default 30)',
          },
          sortBy: {
            type: 'string',
            enum: ['memory', 'cpu'],
            description: 'Sort by memory or cpu',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description:
        'Terminate/kill a process on this computer by process ID (PID) or process name (e.g. "notepad", "chrome").',
      parameters: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description:
              'Process PID (e.g. "1234") or ProcessName (e.g. "notepad")',
          },
        },
        required: ['identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app_or_file',
      description:
        'Launch an application (e.g. notepad, calc, chrome, code, spotify, explorer), open a URL in the browser, or open any file/folder on the computer.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Application name, URL, or file/folder path to open',
          },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        'Capture a full desktop screenshot of this computer. Saves to public/screenshots/ and returns the image URL and file path.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Optional custom filename (defaults to screenshot_<timestamp>.png)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_clipboard',
      description:
        'Read the current text contents from the computer clipboard.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_clipboard',
      description: 'Copy text to the computer clipboard.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy into clipboard' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_system_file',
      description:
        'Read the contents of any file on the computer by absolute or relative path (e.g. C:/Users/...).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file' },
          maxBytes: {
            type: 'number',
            description: 'Maximum bytes to read (default 1MB)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_system_file',
      description:
        'Create or update any file on the computer. Automatically creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path where file should be created/written',
          },
          content: {
            type: 'string',
            description: 'Content to write into the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_system_directory',
      description:
        'List contents of any folder or drive on the computer (e.g. C:/, Desktop, Documents).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to list (default ".")',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_system_files',
      description:
        'Recursively search for files matching a wildcard or pattern across a folder or drive.',
      parameters: {
        type: 'object',
        properties: {
          searchDir: {
            type: 'string',
            description: 'Root directory to start searching from',
          },
          pattern: {
            type: 'string',
            description:
              'Search pattern or extension (e.g. "*.pdf", "report*", "*.js")',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum matching files to return (default 50)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_media_volume',
      description:
        'Control system audio volume and media keys: mute, volume_down, volume_up, play_pause, next, prev.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'mute',
              'volume_down',
              'volume_up',
              'play_pause',
              'next',
              'prev',
            ],
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_notify',
      description: 'Send a native OS toast notification banner to the user.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          message: { type: 'string', description: 'Notification message body' },
        },
        required: ['title', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_windows',
      description:
        'List all currently open application windows visible on the desktop with their PID and window title. Use before focusing or closing windows.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'focus_window',
      description:
        'Bring an application window to the foreground and focus it by PID or Window Title substring.',
      parameters: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description:
              'Window title substring or process PID to bring to front',
          },
        },
        required: ['identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_window',
      description:
        'Gracefully request an open application window to close by PID or Window Title.',
      parameters: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description: 'Window title substring or process PID to close',
          },
        },
        required: ['identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_keys',
      description:
        'Send keystrokes or hotkey combinations to the currently focused window (e.g. "{ENTER}", "^c", "^v", "%{TAB}", "Hello World").',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description:
              'Keys or keystroke sequence to send (WScript.Shell SendKeys format)',
          },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a task or timer to run after a delay (in seconds) or recurring interval. Can trigger a command, tool call, or alarm notification.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Descriptive name of the task' },
          delaySeconds: {
            type: 'number',
            description: 'Seconds from now before executing (e.g. 60, 300)',
          },
          intervalSeconds: {
            type: 'number',
            description:
              'Interval in seconds for recurring execution (0 for one-shot)',
          },
          command: {
            type: 'string',
            description: 'Shell command to execute when triggered',
          },
          message: {
            type: 'string',
            description:
              'Reminder or alarm notification message body to display',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description:
        'List all active, pending, and completed scheduled tasks and reminders.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_scheduled_task',
      description: 'Cancel a pending scheduled task or alarm by task ID.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID of the scheduled job to cancel',
          },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diagnose_system',
      description:
        'Run comprehensive health diagnostic on this computer: evaluates CPU, RAM usage, storage space, identifies top memory-hungry processes, and provides a health score (0-100) with recommendations.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clean_temp_files',
      description:
        'Clean temporary code sandbox artifacts and execution cache files to reclaim disk space.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ping_host',
      description:
        'Ping a remote network host or domain (e.g. "8.8.8.8", "google.com") to test connectivity and measure latency.',
      parameters: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
            description: 'Host IP or domain name to ping (default "8.8.8.8")',
          },
        },
      },
    },
  },
];

/** Execute a tool by name with arguments. */
export async function executeTool(toolName, args = {}) {
  const handler = TOOL_REGISTRY[toolName];
  if (!handler) return { error: `Unknown tool: ${toolName}` };
  try {
    return await handler(args);
  } catch (err) {
    return { error: err.message };
  }
}

// ── HTTP Handlers ──

/** POST /api/jarvis/execute — Execute a named tool. */
export async function handleJarvisExecute(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const rawBody = await readRequestBody(req, 512 * 1024);
    const body = JSON.parse(rawBody || '{}');
    let tool = body.tool;
    let args = body.args;

    if (!tool) {
      if (body.command) {
        tool = 'system_command';
        args = { command: body.command, cwd: body.cwd, timeout: body.timeout };
      } else if (body.target && (body.action === 'open' || body.open)) {
        tool = 'open_app_or_file';
        args = { target: body.target };
      } else if (body.code) {
        tool = 'execute_code';
        args = {
          language: body.language || 'javascript',
          code: body.code,
          timeout: body.timeout,
        };
      } else if (body.expression) {
        tool = 'calculate';
        args = { expression: body.expression };
      } else if (body.url) {
        tool = 'scrape_url';
        args = { url: body.url };
      } else if (body.path && body.content !== undefined) {
        tool = 'write_system_file';
        args = { path: body.path, content: body.content };
      } else if (body.path) {
        tool = 'read_system_file';
        args = { path: body.path };
      }
    }

    if (!tool) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing tool name' }));
      return;
    }

    const result = await executeTool(tool, args || {});
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, tool, result }));
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({ error: error.message || 'Tool execution failed' }),
    );
  }
}

/** GET/POST /api/jarvis/memory — Read/write persistent memory. */
export async function handleJarvisMemory(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (req.method === 'GET') {
      const mem = await readMemory();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, memory: mem }));
      return;
    }

    if (req.method === 'POST') {
      const rawBody = await readRequestBody(req, 64 * 1024);
      const { action = 'set', key, value, query } = JSON.parse(rawBody || '{}');

      let result;
      switch (action) {
        case 'set':
          result = await setMemory(key, value);
          break;
        case 'delete':
          result = await deleteMemory(key);
          break;
        case 'search':
          result = await searchMemory(query || '');
          break;
        default:
          result = await readMemory();
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
}

/** GET/POST /api/jarvis/sessions — Manage conversation sessions. */
export async function handleJarvisSessions(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (req.method === 'GET') {
      const sessions = await listSessions();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }

    if (req.method === 'POST') {
      const rawBody = await readRequestBody(req, 1024 * 1024);
      const { action = 'save', sessionId, data } = JSON.parse(rawBody || '{}');

      let result;
      switch (action) {
        case 'save':
          result = await saveSession(sessionId, data);
          break;
        case 'load':
          result = await loadSession(sessionId);
          break;
        case 'delete':
          result = await deleteSession(sessionId);
          break;
        case 'list':
          result = await listSessions();
          break;
        default:
          result = { error: 'Unknown action' };
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * GET /api/jarvis/device-info — Return local network IP and SVG QR code for Android phone connection.
 */
export async function handleJarvisDeviceInfo(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const [name, netList] of Object.entries(interfaces)) {
      for (const net of netList || []) {
        if (!net.internal && net.family === 'IPv4') {
          addresses.push({ interface: name, address: net.address });
        }
      }
    }

    const primary = addresses.find(
      (a) => a.address.startsWith('192.168.') || a.address.startsWith('10.'),
    ) ||
      addresses[0] || { address: 'localhost' };
    const hostHeader = req.headers.host || '';
    const port = hostHeader.includes(':') ? hostHeader.split(':')[1] : '4173';
    const lanUrl = `http://${primary.address}:${port}`;

    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(lanUrl, {
        type: 'svg',
        margin: 1,
        color: {
          dark: '#00d4ff',
          light: '#040e16',
        },
      });
    } catch {
      qrSvg = '';
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        primaryIp: primary.address,
        port,
        lanUrl,
        allAddresses: addresses,
        qrSvg,
        pwa: {
          name: "JARVIS - God's Eye View",
          manifest: '/manifest.json',
          installable: true,
        },
      }),
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/**
 * GET /api/jarvis/system-info — Return real-time CPU, RAM, OS, disks, battery, and host telemetry.
 */
export async function handleJarvisSystemInfo(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const info = await getSystemInfo();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, info }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/**
 * GET /api/jarvis/windows — List visible desktop application windows.
 */
export async function handleJarvisWindows(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const list = await listWindows();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ...list }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/**
 * GET/POST /api/jarvis/schedules — View, create, and cancel scheduled tasks and alarms.
 */
export async function handleJarvisSchedules(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (req.method === 'GET') {
      const data = await listScheduledTasks();
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, ...data }));
      return;
    }

    if (req.method === 'POST') {
      const rawBody = await readRequestBody(req, 64 * 1024);
      const body = JSON.parse(rawBody || '{}');

      if (body.action === 'cancel') {
        const result = await cancelScheduledTask(body.taskId || body.id);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      const result = await scheduleTask(body);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/**
 * GET /api/jarvis/diagnostics — Run system health diagnosis.
 */
export async function handleJarvisDiagnostics(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const diagnostics = await diagnoseSystem();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, diagnostics }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

/** Vite plugin registering JARVIS tool endpoints. */
export function jarvisToolsProxy() {
  function install(middlewares) {
    middlewares.use('/api/jarvis/execute', handleJarvisExecute);
    middlewares.use('/api/jarvis/memory', handleJarvisMemory);
    middlewares.use('/api/jarvis/sessions', handleJarvisSessions);
    middlewares.use('/api/jarvis/device-info', handleJarvisDeviceInfo);
    middlewares.use('/api/jarvis/system-info', handleJarvisSystemInfo);
    middlewares.use('/api/jarvis/windows', handleJarvisWindows);
    middlewares.use('/api/jarvis/schedules', handleJarvisSchedules);
    middlewares.use('/api/jarvis/diagnostics', handleJarvisDiagnostics);
  }

  return {
    name: 'jarvis-tools-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
