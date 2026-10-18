import { t } from '../i18n/index.js';
import { checkLocalGpu, requireCachedModels } from './localModelCache.js';
import { localAiConfig } from './localConfig.js';

const stopped = () => new DOMException('Local inference stopped', 'AbortError');
function inferenceError(message) {
  const oom = /out of memory|\boom\b|memory access out of bounds/iu.test(
    message,
  );
  const error = new Error(
    oom
      ? t(
          'Local model ran out of memory. Its memory has been released. Try again with a shorter request or the low profile.',
        )
      : message,
  );
  error.code = oom ? 'LOCAL_AI_OOM' : 'LOCAL_AI_INFERENCE';
  return error;
}

/** Independent WASM heaps; ordinary map commands never allocate Bonsai. */
export function createBrowserLocalRuntime(
  selection,
  {
    createWorker = () =>
      new Worker(new URL('./browserLocalWorker.js', import.meta.url), {
        type: 'module',
        name: 'gev-local-ai',
      }),
    checkGpu = checkLocalGpu,
    checkCache = requireCachedModels,
    chatIdleMs = 120000,
  } = {},
) {
  const config = {
    ...localAiConfig({
      LOCAL_AI_PROFILE: selection.profile,
      LOCAL_AI_LANGUAGE: selection.language,
    }),
    ...selection,
  };
  const workers = new Map();
  let serial = 0,
    generation = 0;
  function release(kind, reason = stopped()) {
    const owner = workers.get(kind);
    if (!owner) return;
    clearTimeout(owner.timer);
    owner.worker.terminate();
    workers.delete(kind);
    for (const item of owner.pending.values()) {
      item.cleanup();
      item.reject(reason);
    }
    owner.pending.clear();
  }
  function stop() {
    generation++;
    for (const kind of [...workers.keys()]) release(kind);
  }
  async function request(type, data, signal, onStatus) {
    signal?.throwIfAborted();
    const kind =
      type === 'prepare'
        ? data.kind
        : type === 'transcribe'
          ? 'recognition'
          : type;
    const epoch = generation;
    if (kind === 'chat' && !workers.has(kind)) await checkGpu();
    signal?.throwIfAborted();
    if (epoch !== generation) throw stopped();
    // The 8B ONNX graph also needs substantial CPU/WASM memory. Independent
    // heaps alone are insufficient when recognition, chat and VITS stay warm.
    if (config.profile === 'max') {
      if (
        [...workers].some(
          ([name, owner]) => name !== kind && owner.pending.size,
        )
      )
        throw new Error('Local model is busy');
      for (const name of [...workers.keys()]) if (name !== kind) release(name);
    }
    let owner = workers.get(kind);
    if (!owner) {
      owner = { worker: createWorker(kind), pending: new Map() };
      workers.set(kind, owner);
      owner.worker.onerror = (event) => {
        if (workers.get(kind) === owner)
          release(
            kind,
            inferenceError(event.message || 'Local model worker failed'),
          );
      };
      owner.worker.onmessage = ({ data: reply }) => {
        if (workers.get(kind) !== owner) return;
        const item = owner.pending.get(reply.id);
        if (!item) return;
        if (reply.status) {
          const loading = reply.status.match(
            /^Loading (.+) from browser cache…$/u,
          );
          item.onStatus?.(
            loading
              ? t('Loading {model} from browser cache…', { model: loading[1] })
              : reply.status,
          );
          return;
        }
        if (reply.error) {
          release(kind, inferenceError(reply.error));
          return;
        }
        owner.pending.delete(reply.id);
        item.cleanup();
        item.resolve(reply.result);
        if (kind === 'chat' && !owner.pending.size)
          owner.timer = setTimeout(() => release(kind), chatIdleMs);
      };
    }
    if (owner.pending.size) throw new Error('Local model is busy');
    clearTimeout(owner.timer);
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const abort = () => release(kind, signal.reason);
      const cleanup = () => signal?.removeEventListener('abort', abort);
      owner.pending.set(id, { resolve, reject, cleanup, onStatus });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        owner.worker.postMessage(
          { id, type, data, config },
          data?.audio ? [data.audio.buffer] : [],
        );
      } catch (error) {
        release(kind, error);
      }
    });
  }
  async function speech(text, signal, onStatus) {
    const epoch = generation;
    try {
      return await request('speech', { text }, signal, onStatus);
    } catch (error) {
      signal?.throwIfAborted();
      if (epoch !== generation) throw stopped();
      if (
        error.code !== 'LOCAL_AI_OOM' ||
        [...workers.values()].some((owner) => owner.pending.size)
      )
        throw error;
      // Nothing has played yet. A fresh voice heap after releasing idle
      // models can safely retry this utterance once without duplicate audio.
      for (const name of [...workers.keys()]) release(name);
      return request('speech', { text }, signal, onStatus);
    }
  }
  return {
    async prepare(signal, onStatus) {
      const epoch = generation;
      await checkCache(config);
      signal?.throwIfAborted();
      if (epoch !== generation) throw stopped();
      await request('prepare', { kind: 'recognition' }, signal, onStatus);
    },
    chat: (messages, signal, onStatus) =>
      request('chat', { messages }, signal, onStatus),
    transcribe: (audio, signal) => request('transcribe', { audio }, signal),
    speech,
    diagnostics: () => ({
      loadedWorkers: [...workers.keys()],
      pending: [...workers.values()].reduce(
        (n, owner) => n + owner.pending.size,
        0,
      ),
    }),
    stop,
  };
}
