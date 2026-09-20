import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUptime,
  getSystemInfo,
  executeSystemCommand,
  executeTool,
  readSystemFile,
  writeSystemFile,
  listSystemDirectory,
  getClipboard,
  setClipboard,
  handleJarvisSystemInfo,
  handleJarvisExecute,
} from '../server/providers/jarvis-tools.js';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('formatUptime: formats seconds into human readable parts', () => {
  assert.equal(formatUptime(0), '0m');
  assert.equal(formatUptime(59), '0m');
  assert.equal(formatUptime(65), '1m');
  assert.equal(formatUptime(3665), '1h 1m');
  assert.equal(formatUptime(90060), '1d 1h 1m');
});

test('getSystemInfo: returns structured hardware and OS telemetry', async () => {
  const info = await getSystemInfo();
  assert.ok(info.platform, 'Must have platform');
  assert.ok(info.cpu, 'Must have cpu info');
  assert.ok(info.cpu.cores > 0, 'Must have >0 cpu cores');
  assert.ok(info.memory, 'Must have memory info');
  assert.ok(info.memory.totalBytes > 0, 'Total bytes must be positive');
  assert.ok(info.memory.usedBytes > 0, 'Used bytes must be positive');
  assert.ok(
    info.memory.usedPercent >= 0 && info.memory.usedPercent <= 100,
    'Used percent must be between 0 and 100',
  );
  assert.ok(info.hostname, 'Must have hostname');
  assert.ok(Array.isArray(info.disks), 'Disks must be an array');
});

test('executeSystemCommand: executes command on host system and returns stdout', async () => {
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'Write-Output "JARVIS HOST ONLINE"'
    : 'echo "JARVIS HOST ONLINE"';
  const res = await executeSystemCommand(cmd, { timeout: 5000 });
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.includes('JARVIS HOST ONLINE'));
  assert.equal(res.killed, false);
});

test('executeSystemCommand: security guard blocks destructive root commands', async () => {
  const res = await executeSystemCommand('format c: /fs:NTFS', {
    timeout: 1000,
  });
  assert.equal(res.exitCode, 1);
  assert.ok(res.stderr.includes('Security refusal'));
});

test('executeTool: routes system_command and system_info tools', async () => {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'Write-Output 42' : 'echo 42';

  const cmdRes = await executeTool('system_command', { command: cmd });
  assert.equal(cmdRes.exitCode, 0);
  assert.ok(cmdRes.stdout.includes('42'));

  const infoRes = await executeTool('system_info', {});
  assert.ok(infoRes.platform);
  assert.ok(infoRes.memory);
});

test('readSystemFile & writeSystemFile: writes and reads files anywhere on the system', async () => {
  const testFile = resolve(
    __dirname,
    '../.jarvis-workspace/test_system_file.txt',
  );
  const content = `JARVIS Autonomous Test ${Date.now()}`;

  const writeRes = await writeSystemFile(testFile, content);
  assert.equal(writeRes.success, true);
  assert.ok(writeRes.bytesWritten > 0);

  const readRes = await readSystemFile(testFile);
  assert.equal(readRes.content, content);
  assert.ok(readRes.size > 0);
});

test('listSystemDirectory: lists directory contents', async () => {
  const dir = resolve(__dirname, '../');
  const res = await listSystemDirectory(dir);
  assert.ok(res.count > 0);
  assert.ok(Array.isArray(res.items));
  const hasPkg = res.items.some((item) => item.name === 'package.json');
  assert.ok(hasPkg, 'Must list package.json in repository root');
});

test('setClipboard & getClipboard: sets and retrieves clipboard text', async () => {
  const token = `JARVIS_CLIPBOARD_${Date.now()}`;
  const setRes = await setClipboard(token);
  assert.equal(setRes.success, true);

  const getRes = await getClipboard();
  assert.equal(getRes.text, token);
});

test('handleJarvisSystemInfo: HTTP GET endpoint returns system telemetry', async () => {
  let statusCode = 0;
  let headers = {};
  let body = '';

  const mockReq = { method: 'GET' };
  const mockRes = {
    setHeader: (k, v) => {
      headers[k] = v;
    },
    set statusCode(val) {
      statusCode = val;
    },
    get statusCode() {
      return statusCode;
    },
    end: (data) => {
      body = data;
    },
  };

  await handleJarvisSystemInfo(mockReq, mockRes);
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.info.cpu);
  assert.ok(parsed.info.memory);
});

import { Readable } from 'node:stream';

test('handleJarvisExecute: executes system command via HTTP POST', async () => {
  let statusCode = 0;
  let headers = {};
  let body = '';

  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'Write-Output "HTTP CMD SUCCESS"'
    : 'echo "HTTP CMD SUCCESS"';

  const mockReq = Readable.from([
    Buffer.from(JSON.stringify({ command: cmd })),
  ]);
  mockReq.method = 'POST';

  const mockRes = {
    setHeader: (k, v) => {
      headers[k] = v;
    },
    set statusCode(val) {
      statusCode = val;
    },
    get statusCode() {
      return statusCode;
    },
    end: (data) => {
      body = data;
    },
  };

  await handleJarvisExecute(mockReq, mockRes);
  assert.equal(statusCode, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tool, 'system_command');
  assert.ok(parsed.result.stdout.includes('HTTP CMD SUCCESS'));
});

test('listProcesses: enumerates active running processes on host machine', async () => {
  const { listProcesses } = await import('../server/providers/jarvis-tools.js');
  const res = await listProcesses({ limit: 5 });
  assert.ok(Array.isArray(res.processes));
  assert.ok(res.processes.length > 0);
  assert.ok(res.processes[0].pid !== undefined);
  assert.ok(res.processes[0].name);
});

test('takeScreenshot: captures desktop screenshot and outputs image file', async () => {
  const { takeScreenshot } =
    await import('../server/providers/jarvis-tools.js');
  const res = await takeScreenshot({ filename: 'test_shot.png' });
  assert.equal(res.success, true);
  assert.equal(res.filename, 'test_shot.png');
  assert.ok(res.url.includes('/screenshots/test_shot.png'));
  assert.ok(res.sizeBytes > 0);
});

test('listWindows: enumerates open desktop application windows', async () => {
  const { listWindows } = await import('../server/providers/jarvis-tools.js');
  const res = await listWindows();
  assert.ok(Array.isArray(res.windows));
  assert.ok(typeof res.count === 'number');
});

test('focusWindow & sendKeys: can target window and send input keys', async () => {
  const { focusWindow, sendKeys } =
    await import('../server/providers/jarvis-tools.js');
  // Focus active Node process
  const focusRes = await focusWindow(process.pid);
  assert.ok(focusRes.target !== undefined);

  // Send a no-op harmless key sequence
  const keysRes = await sendKeys('{ESC}');
  assert.ok(keysRes.success);
});

test('scheduleTask & listScheduledTasks & cancelScheduledTask: schedules, lists, and cancels tasks', async () => {
  const { scheduleTask, listScheduledTasks, cancelScheduledTask } =
    await import('../server/providers/jarvis-tools.js');

  const schedRes = await scheduleTask({
    name: 'Unit Test Task',
    delaySeconds: 10,
    command: 'echo "scheduled ok"',
  });
  assert.equal(schedRes.success, true);
  assert.ok(schedRes.task.id);
  const taskId = schedRes.task.id;

  const listRes = await listScheduledTasks();
  assert.ok(Array.isArray(listRes.tasks));
  assert.ok(listRes.tasks.some((t) => t.id === taskId));

  const cancelRes = await cancelScheduledTask(taskId);
  assert.equal(cancelRes.success, true);
});

test('diagnoseSystem: produces comprehensive health diagnostic', async () => {
  const { diagnoseSystem } =
    await import('../server/providers/jarvis-tools.js');
  const diag = await diagnoseSystem();
  assert.ok(typeof diag.healthScore === 'number');
  assert.ok(diag.grade);
  assert.ok(diag.status);
  assert.ok(Array.isArray(diag.recommendations));
  assert.ok(diag.memory);
  assert.ok(diag.cpu);
});

test('cleanTempFiles: removes temporary execution artifacts', async () => {
  const { cleanTempFiles, writeSystemFile } =
    await import('../server/providers/jarvis-tools.js');
  const tempDummy = resolve(
    __dirname,
    '../.jarvis-workspace/.sandbox/run_dummy_test.txt',
  );
  await writeSystemFile(tempDummy, 'temporary test artifact');

  const cleanRes = await cleanTempFiles();
  assert.equal(cleanRes.success, true);
  assert.ok(cleanRes.freedFiles >= 1);
});

test('pingHost: tests network host reachability and latency', async () => {
  const { pingHost } = await import('../server/providers/jarvis-tools.js');
  const res = await pingHost('127.0.0.1');
  assert.equal(res.host, '127.0.0.1');
  assert.equal(res.reachable, true);
});
