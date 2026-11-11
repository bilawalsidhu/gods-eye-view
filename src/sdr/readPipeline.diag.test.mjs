// Diagnostic prototype tests (isolated copy only): pipelined reads and control drain ordering.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SdrController } from './controller.js';

function rig() {
  const log = [];
  const reads = [];
  const c = new SdrController({
    storage: { getItem: () => null, setItem() {} },
    webUsb: {},
  });
  c._worker = {
    postMessage(m) {
      if (m.type === 'samples') log.push(`block:${m.buffer.byteLength}`);
      else log.push(`worker:${m.type}`);
    },
    terminate() {},
  };
  c._device = {
    readSamples: () =>
      new Promise((resolve, reject) => {
        const id = reads.length;
        reads.push({ resolve, reject, id });
        log.push(`issue:${id}`);
      }),
  };
  c._readGeneration += 1;
  void c._readLoop(c._readGeneration);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const finish = (id) => reads[id].resolve({ data: new ArrayBuffer(8 + id) });
  return {
    c,
    log,
    reads,
    settle,
    finish,
    rejectFirst: () => reads[0].reject(new Error('transfer error')),
    stop: () => {
      c._readGeneration += 1;
      c._device = null;
    },
  };
}

test('reads stay queued at the host while a completed block is handled', async () => {
  const r = rig();
  await r.settle();
  assert.equal(
    r.reads.length,
    4,
    'four reads outstanding before any completes',
  );
  r.finish(0);
  await r.settle();
  assert.equal(
    r.reads.length,
    5,
    'a replacement read is issued as soon as one completes',
  );
  assert.deepEqual(
    r.log.filter((e) => e.startsWith('block')),
    ['block:8'],
  );
  r.stop();
});

test('control work waits for in-flight reads, and no read is issued until it finishes', async () => {
  const r = rig();
  await r.settle();
  let ran = false;
  const control = r.c._queueUsb(async () => {
    r.log.push('control');
    ran = true;
  });
  await r.settle();
  assert.equal(ran, false, 'control waits for queued reads');
  for (const id of [0, 1, 2, 3]) r.finish(id);
  await control;
  await r.settle();
  const at = r.log.indexOf('control');
  assert.deepEqual(
    r.log.slice(at - 4, at),
    ['block:8', 'block:9', 'block:10', 'block:11'],
    'every pre-control block is delivered first',
  );
  assert.ok(
    r.log.slice(at + 1).some((e) => e.startsWith('issue:')),
    'reads resume after control',
  );
  assert.ok(
    !r.log
      .slice(r.log.indexOf('issue:3') + 1, at)
      .some((e) => e.startsWith('issue:')),
    'no read issued while control pending',
  );
  r.stop();
});

test('a retune posts its tagged reset only after every pre-retune block reached the worker', async () => {
  const r = rig();
  Object.assign(r.c._device, {
    setCenterFrequency: async (f) => {
      r.log.push(`tune:${f}`);
      return f;
    },
    resetBuffer: async () => {
      r.log.push('resetBuffer');
    },
  });
  r.c._setState({ mode: 'fm', status: 'streaming' });
  await r.settle();
  const tuned = r.c.tuneFm(99_000_000, { quiet: true });
  await r.settle();
  assert.ok(
    !r.log.includes('tune:99000000'),
    'tuner untouched while reads are in flight',
  );
  for (const id of [0, 1, 2, 3]) r.finish(id);
  assert.equal(await tuned, true);
  await r.settle();
  const reset = r.log.indexOf('worker:reset');
  const tune = r.log.indexOf('tune:99000000');
  const preBlocks = r.log.slice(0, tune).filter((e) => e.startsWith('block'));
  assert.deepEqual(preBlocks, ['block:8', 'block:9', 'block:10', 'block:11']);
  assert.ok(tune < reset, 'tuner and buffer reset before the worker reset');
  assert.ok(
    !r.log.slice(tune, reset).some((e) => e.startsWith('block')),
    'no block between retune and reset',
  );
  r.stop();
});

function newSession(r, name) {
  const reads = [];
  r.c._device = {
    readSamples: () =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject });
        r.log.push(`${name}:issue:${reads.length - 1}`);
      }),
  };
  r.c._readGeneration += 1;
  void r.c._readLoop(r.c._readGeneration);
  return reads;
}

test('a hung control operation cannot block a new session after the queue is abandoned', async () => {
  const r = rig();
  await r.settle();
  let release;
  const hung = r.c._queueUsb(
    () => new Promise((resolve) => (release = resolve)),
  );
  for (const id of [0, 1, 2, 3]) r.finish(id);
  await r.settle();
  assert.equal(typeof release, 'function', 'old control work is running');
  // Forced teardown: abandon the queue, end the old generation, open a new session.
  r.c._resetUsbQueue();
  r.c._readGeneration += 1;
  const reads = newSession(r, 'new');
  await r.settle();
  assert.equal(
    reads.length,
    4,
    'the new session streams despite the hung old work',
  );
  // The old work settles late: it must not touch the new gate.
  release();
  await hung;
  await r.settle();
  assert.equal(r.c._usbGate.waiting, 0);
  let ran = false;
  const control = r.c._queueUsb(async () => (ran = true));
  await r.settle();
  assert.equal(ran, false, 'new control work still waits for the new reads');
  reads.forEach((read) => read.resolve({ data: new ArrayBuffer(4) }));
  await control;
  assert.equal(ran, true);
  r.c._readGeneration += 1;
  r.c._device = null;
});

test('blocks read by an ended session are never delivered after reconnect', async () => {
  const r = rig();
  await r.settle();
  assert.equal(r.reads.length, 4);
  // Session ends with four reads outstanding; a new session starts.
  r.c._readGeneration += 1;
  const reads = newSession(r, 'new');
  await r.settle();
  for (const id of [0, 1, 2, 3]) r.finish(id); // old reads complete late
  await r.settle();
  assert.ok(
    !r.log.some((e) => /^block:(8|9|10|11)$/.test(e)),
    'no old block reached the worker',
  );
  reads[0].resolve({ data: new ArrayBuffer(100) });
  await r.settle();
  assert.ok(r.log.includes('block:100'), 'the new session delivers');
  r.c._readGeneration += 1;
  r.c._device = null;
});

test('a read that fails while control work is pending still lets the drain settle', async () => {
  const r = rig();
  await r.settle();
  r.c.stop = async () => {
    r.log.push('stop');
    return true;
  };
  let ran = false;
  const control = r.c._queueUsb(async () => (ran = true));
  // First read fails (as a stalled or aborted transfer would); the rest complete.
  r.finish(1);
  r.finish(2);
  r.finish(3);
  await r.settle();
  assert.equal(ran, false, 'drain waits for the outstanding failing read');
  // Reject the first transfer.
  r.rejectFirst();
  await control;
  await r.settle();
  assert.equal(ran, true, 'control work runs once every read has settled');
  assert.ok(r.log.includes('stop'), 'the failed read ended the session');
});
