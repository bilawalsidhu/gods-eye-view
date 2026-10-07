import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGateStateStore } from '../../server/providers/regional/nominatimGate.js';

const moduleUrl = new URL(
  '../../server/providers/regional/nominatimGate.js',
  import.meta.url,
).href;

function startModule(script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const waiters = [];
  let stdout = '';
  let stderr = '';

  const publish = (line) => {
    lines.push(line);
    for (const waiter of [...waiters]) {
      if (!line.startsWith(waiter.prefix)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const parts = stdout.split('\n');
    stdout = parts.pop();
    for (const line of parts) publish(line);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    lines,
    waitFor(prefix, timeoutMs = 3000) {
      const existing = lines.find((line) => line.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { prefix, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `timed out waiting for ${prefix}; stderr: ${stderr.trim()}`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    exited: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
}

function holderScript(lockFile) {
  return `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(${JSON.stringify(lockFile)});
    database.exec('BEGIN IMMEDIATE');
    process.stdout.write('LOCKED\\n');
    process.stdin.once('data', () => {
      database.exec('ROLLBACK');
      database.close();
      process.stdout.write('RELEASED\\n');
    });
    process.stdin.resume();
  `;
}

function contenderScript(stateFile, lockWaitMs) {
  return `
    const { createGateStateStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createGateStateStore({
      file: ${JSON.stringify(stateFile)},
      lockWaitMs: ${lockWaitMs},
      onError: () => {},
    });
    process.stdout.write('ATTEMPTING\\n', () => {
      const result = store.reserve('2026-10-01', {
        now: 1000,
        dailyCap: 50,
        minSpacingMs: 1100,
      });
      process.stdout.write('RESULT:' + JSON.stringify(result) + '\\n');
    });
  `;
}

test('a crashed lock owner cannot delete or bypass a successor lock', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nominatim-lock-'));
  const stateFile = path.join(dir, 'state.json');
  const lockFile = `${stateFile}.lock.sqlite`;
  const children = [];
  t.after(() => {
    for (const process of children) {
      if (process.exitCode == null && process.signalCode == null)
        process.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const crashedOwner = startModule(holderScript(lockFile));
  children.push(crashedOwner.child);
  await crashedOwner.waitFor('LOCKED');
  const originalLock = fs.statSync(lockFile);

  const blockedByCrashedOwner = startModule(contenderScript(stateFile, 0));
  children.push(blockedByCrashedOwner.child);
  const blockedResult = JSON.parse(
    (await blockedByCrashedOwner.waitFor('RESULT:')).slice('RESULT:'.length),
  );
  assert.equal(blockedResult.status, 'unavailable');
  assert.equal((await blockedByCrashedOwner.exited).code, 0);
  assert.equal(fs.existsSync(stateFile), false);

  crashedOwner.child.kill();
  await crashedOwner.exited;

  const successorOwner = startModule(holderScript(lockFile));
  children.push(successorOwner.child);
  await successorOwner.waitFor('LOCKED');
  assert.equal(fs.statSync(lockFile).ino, originalLock.ino);

  const refused = startModule(contenderScript(stateFile, 0));
  children.push(refused.child);
  const refusedResult = JSON.parse(
    (await refused.waitFor('RESULT:')).slice('RESULT:'.length),
  );
  assert.equal(refusedResult.status, 'unavailable');
  assert.equal((await refused.exited).code, 0);
  assert.equal(
    createGateStateStore({ file: stateFile }).count('2026-10-01'),
    0,
    'a timed-out contender fails closed without spending a public slot',
  );
  assert.equal(fs.statSync(lockFile).ino, originalLock.ino);

  successorOwner.child.stdin.end('release\n');
  await successorOwner.waitFor('RELEASED');
  assert.equal((await successorOwner.exited).code, 0);
  const afterRelease = createGateStateStore({ file: stateFile }).reserve(
    '2026-10-01',
    {
      now: 2200,
      dailyCap: 50,
      minSpacingMs: 1100,
    },
  );
  assert.equal(afterRelease.status, 'reserved');
  assert.equal(afterRelease.count, 1);
  assert.equal(fs.statSync(lockFile).ino, originalLock.ino);
});

test('a public pause stays authoritative while another process owns the lock', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-nominatim-pause-'));
  const stateFile = path.join(dir, 'state.json');
  const lockFile = `${stateFile}.lock.sqlite`;
  const children = [];
  t.after(() => {
    for (const process of children) {
      if (process.exitCode == null && process.signalCode == null)
        process.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      day: '2026-10-01',
      count: 1,
      pausedUntil: 0,
      nextStartAt: 0,
    }),
  );
  const owner = startModule(holderScript(lockFile));
  children.push(owner.child);
  await owner.waitFor('LOCKED');

  const errors = [];
  const blockedWriter = createGateStateStore({
    file: stateFile,
    lockWaitMs: 0,
    onError: (error) => errors.push(error),
  });
  blockedWriter.pauseUntil(9000);
  assert.equal(errors.length, 1, 'the blocked JSON consolidation is reported');
  assert.equal(
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).pausedUntil,
    0,
    'the lock owner prevents an unsafe JSON overwrite',
  );

  owner.child.stdin.end('release\n');
  await owner.waitFor('RELEASED');
  assert.equal((await owner.exited).code, 0);

  const successor = createGateStateStore({ file: stateFile });
  assert.deepEqual(
    successor.reserve('2026-10-01', {
      now: 1000,
      dailyCap: 50,
      minSpacingMs: 1100,
    }),
    { status: 'paused', retryAfterMs: 8000 },
    'a fresh process observes the pending refusal pause',
  );
  const resumed = successor.reserve('2026-10-01', {
    now: 9001,
    dailyCap: 50,
    minSpacingMs: 1100,
  });
  assert.equal(resumed.status, 'reserved');
  assert.equal(resumed.count, 2);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith('state.json.pause.')),
    false,
    'the next successful transaction consolidates and removes the marker',
  );
});
