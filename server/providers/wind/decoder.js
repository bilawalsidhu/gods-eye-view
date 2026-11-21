import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./decode-worker.js', import.meta.url);
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Decode GRIB messages on one lazily started worker thread.
 *
 * ecCodes decodes a 0.25° message synchronously (~1.04 M doubles), and
 * validating and resampling those values is synchronous too, so on the server
 * thread each refresh stalled every other API route. The worker does all three
 * and transfers back only the display-grid samples.
 *
 * The worker is referenced only while a job is pending, so it never keeps the
 * process alive. A crash, an exit or a job that outlives `jobTimeoutMs`
 * rejects every pending job and retires the worker; the next decode starts a
 * new one.
 *
 * @param {{workerUrl?: URL, jobTimeoutMs?: number}} [options]
 * @returns {{decode: Function, close: Function}}
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
      if (!job) return; // Already rejected by an abort.
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
   * An aborted `signal` rejects at once; the worker finishes the bounded job
   * and its result is dropped.
   */
  const decode = (buffer, { targetDx = 1, signal } = {}) =>
    new Promise((resolve, reject) => {
      if (buffer.byteLength > MAX_MESSAGE_BYTES)
        throw new Error('Wind GRIB exceeds byte budget');
      signal?.throwIfAborted();
      // A private copy: transferring the caller's (possibly pooled) Buffer
      // would detach memory it still owns.
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      const state = (active ??= start());
      const id = nextId++;
      const settle = (finish) => (value) => {
        if (state.pending.get(id) === job) state.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (state.pending.size === 0) state.worker.unref();
        finish(value);
      };
      const job = { resolve: settle(resolve), reject: settle(reject) };
      const abort = () => job.reject(signal.reason);
      const timer = setTimeout(
        () => retire(state, new Error('Wind decode timed out')),
        jobTimeoutMs,
      );
      timer.unref();
      state.pending.set(id, job);
      state.worker.ref();
      signal?.addEventListener('abort', abort, { once: true });
      state.worker.postMessage({ id, bytes, targetDx }, [bytes.buffer]);
    });
  return {
    decode,
    /** Stop the worker; pending jobs reject and a later decode restarts it. */
    close() {
      if (active) retire(active, new Error('Wind decode worker closed'));
    },
  };
}

let shared = null;

/**
 * Default decoder for the wind provider: one worker for the whole process,
 * started by the first wind request, however many `windProxy` instances exist.
 */
export function decodeWindGribInWorker(buffer, options) {
  shared ??= createWindDecoder();
  return shared.decode(buffer, options);
}
