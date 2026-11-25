import { Worker } from 'node:worker_threads';
import { waitForSignal } from '../../../src/sources/requestDeadline.js';

const WORKER_URL = new URL('./decode-worker.js', import.meta.url);

/**
 * One lazily started worker thread for GRIB decode, validation and sampling,
 * which are synchronous and too slow for the server thread (a 0.25° message is
 * ~1.04 M doubles); only the display-grid samples come back.
 *
 * The worker is ref'd only while a job is pending. A crash, an exit or a job
 * over `jobTimeoutMs` rejects every pending job and retires the worker; the
 * next decode starts a new one.
 */
export function createWindDecoder({
  workerUrl = WORKER_URL,
  jobTimeoutMs = 30_000,
} = {}) {
  let active = null;
  let nextId = 1;
  const retire = (state, error) => {
    if (active === state) active = null;
    const jobs = [...state.pending.values()];
    state.pending.clear();
    for (const job of jobs) job.reject(error);
    void state.worker.terminate();
  };
  const start = () => {
    const state = {
      worker: new Worker(workerUrl),
      pending: new Map(),
    };
    state.worker.unref();
    state.worker.on('message', ({ id, field, error }) => {
      const job = state.pending.get(id);
      if (!job) return; // Its worker was already retired.
      if (error === undefined) job.resolve(field);
      else job.reject(new Error(error));
    });
    state.worker.on('error', (cause) =>
      retire(state, new Error('Wind decode worker failed', { cause })),
    );
    state.worker.on('exit', () =>
      retire(state, new Error('Wind decode worker exited')),
    );
    return state;
  };
  /**
   * Decode one message and sample it to `targetDx` (see `sampleWindField`).
   * An aborted `signal` ends this caller's wait at once; the job keeps its
   * deadline and its result is dropped.
   */
  const decode = async (buffer, { targetDx = 1, signal } = {}) => {
    signal?.throwIfAborted();
    const job = new Promise((resolve, reject) => {
      const state = (active ??= start());
      const id = nextId++;
      const settle = (finish) => (value) => {
        state.pending.delete(id);
        clearTimeout(timer);
        if (state.pending.size === 0) state.worker.unref();
        finish(value);
      };
      const timer = setTimeout(
        () => retire(state, new Error('Wind decode timed out')),
        jobTimeoutMs,
      );
      timer.unref();
      state.pending.set(id, {
        resolve: settle(resolve),
        reject: settle(reject),
      });
      state.worker.ref();
      state.worker.postMessage({ id, bytes: buffer, targetDx });
    });
    return waitForSignal(job, signal);
  };
  return {
    decode,
    /** Stop the worker; pending jobs reject and a later decode restarts it. */
    close() {
      if (active) retire(active, new Error('Wind decode worker closed'));
    },
  };
}
