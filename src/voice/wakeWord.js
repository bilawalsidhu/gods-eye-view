/**
 * Opt-in wake word for the local voice path. Porcupine (Picovoice) runs in a
 * WASM worker fed by the browser microphone; on detection the adapter starts
 * a voice session, and the listener stands down while a session is active so
 * the mic belongs to one owner at a time. Requires a Picovoice AccessKey:
 * PICOVOICE_ACCESS_KEY in .env (served by /api/voice/config) or the
 * localStorage key below. The acoustic model is fetched once by
 * `npm run wakeword:fetch` into public/wakeword/.
 */
export const WAKE_WORD_STORAGE = Object.freeze({
  accessKey: 'gev-wake-word-access-key',
  keyword: 'gev-wake-word-keyword',
  enabled: 'gev-wake-word-enabled',
});

export const DEFAULT_WAKE_WORD = 'Computer';

export function readWakeWordSettings({
  storage = safeStorage(),
  config = null,
} = {}) {
  const read = (key) => {
    try {
      return storage?.getItem(key) || '';
    } catch {
      return '';
    }
  };
  const accessKey =
    read(WAKE_WORD_STORAGE.accessKey) || config?.accessKey || '';
  const keyword =
    read(WAKE_WORD_STORAGE.keyword) || config?.keyword || DEFAULT_WAKE_WORD;
  const disabled = read(WAKE_WORD_STORAGE.enabled) === '0';
  return { accessKey, keyword, enabled: Boolean(accessKey) && !disabled };
}

/**
 * @param {object} options
 * @param {string} options.accessKey
 * @param {string} [options.keyword] Built-in keyword label ("Computer",
 *   "Jarvis", "Porcupine", ...) or a custom keyword object.
 * @param {(detection: object) => void} options.onDetect
 * @param {(error: Error) => void} [options.onError]
 */
export function createWakeWordListener({
  accessKey,
  keyword = DEFAULT_WAKE_WORD,
  onDetect,
  onError = () => {},
  loadPorcupine = () => import('@picovoice/porcupine-web'),
  loadProcessor = () => import('@picovoice/web-voice-processor'),
  modelPath = '/wakeword/porcupine_params.pv',
}) {
  let worker = null;
  let processor = null;
  let subscribed = false;
  let starting = null;
  let destroyed = false;
  let armed = false;

  async function ensureWorker() {
    if (worker) return worker;
    const [{ PorcupineWorker, BuiltInKeyword }, { WebVoiceProcessor }] =
      await Promise.all([loadPorcupine(), loadProcessor()]);
    processor = WebVoiceProcessor;
    const builtIn = Object.values(BuiltInKeyword || {}).find(
      (label) => String(label).toLowerCase() === String(keyword).toLowerCase(),
    );
    const created = await PorcupineWorker.create(
      accessKey,
      [builtIn || keyword],
      (detection) => {
        if (!destroyed && armed) onDetect?.(detection);
      },
      { publicPath: modelPath, forceWrite: false },
      { processErrorCallback: (error) => onError(toError(error)) },
    );
    if (destroyed) {
      await created.release?.();
      created.terminate?.();
      return null;
    }
    worker = created;
    return worker;
  }

  return {
    get listening() {
      return subscribed;
    },
    /** Start listening for the keyword (idempotent). */
    async start() {
      if (destroyed) return false;
      armed = true;
      if (starting) return starting;
      starting = (async () => {
        try {
          const instance = await ensureWorker();
          if (!instance || !armed || destroyed) return false;
          if (!subscribed) {
            await processor.subscribe(instance);
            subscribed = true;
          }
          return true;
        } catch (error) {
          onError(toError(error));
          return false;
        } finally {
          starting = null;
        }
      })();
      return starting;
    },
    /** Stop listening but keep the engine warm (session took the mic). */
    async pause() {
      armed = false;
      if (!subscribed || !worker || !processor) return;
      subscribed = false;
      try {
        await processor.unsubscribe(worker);
      } catch {
        /* no-op */
      }
    },
    async destroy() {
      destroyed = true;
      armed = false;
      if (subscribed && worker && processor) {
        subscribed = false;
        try {
          await processor.unsubscribe(worker);
        } catch {
          /* no-op */
        }
      }
      try {
        await worker?.release?.();
        worker?.terminate?.();
      } catch {
        /* no-op */
      }
      worker = null;
    },
  };
}

function toError(value) {
  return value instanceof Error
    ? value
    : new Error(String(value?.message || value));
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
