// Must match the installed @litert-lm/core; a unit test pins them together.
export const LITERT_VERSION = '0.17.1';

/**
 * Request/response and stream plumbing for one worker. Pending requests and
 * open streams are rejected when the worker fails or is terminated.
 */
export function createWorkerClient(worker) {
  let sequence = 0;
  let failure = null;
  const pending = new Map();
  const listeners = new Set();
  const failureListeners = new Set();
  const fail = (error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const listener of [...failureListeners]) listener(error);
    failureListeners.clear();
  };
  worker.addEventListener('message', ({ data }) => {
    for (const listener of [...listeners]) listener(data);
    const request = data?.id != null ? pending.get(data.id) : null;
    if (!request) return;
    if (data.type === 'progress') {
      request.onProgress?.(data);
      return;
    }
    if (data.type === 'error') {
      pending.delete(data.id);
      request.reject(new Error(data.message));
      return;
    }
    if (request.done(data)) {
      pending.delete(data.id);
      request.resolve(data);
    }
  });
  worker.addEventListener('error', (event) => {
    fail(new Error(event.message || 'Voice worker failed'));
  });
  return {
    worker,
    request(message, { transfer, onProgress, done = () => true } = {}) {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress, done });
        worker.postMessage({ ...message, id }, transfer || []);
      });
    },
    post(message) {
      if (!failure) worker.postMessage(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Calls back once if the worker fails or stops; returns an unsubscribe. */
    onFailure(listener) {
      if (failure) {
        listener(failure);
        return () => {};
      }
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    terminate() {
      worker.terminate();
      fail(new DOMException('Voice worker stopped', 'AbortError'));
    },
  };
}
