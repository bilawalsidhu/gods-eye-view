import {
  TTS_MODEL,
  checkLocalVoiceSupport,
  storageAdvice,
} from './modelCatalog.js';
import { MODEL_CACHE_NAME, isModelCached } from './workers/modelCache.js';
import { createWorkerClient } from './workerClient.js';

// Caches written by transformers.js (speech recognition, Kokoro weights) and
// by kokoro-js (voice vectors).
const LIBRARY_CACHES = ['transformers-cache', 'kokoro-voices'];

/** Language model client backed by the LiteRT-LM worker. */
export function createLlmClient(
  worker = new Worker(new URL('./workers/llm.worker.js', import.meta.url), {
    type: 'module',
    name: 'gev-local-llm',
  }),
) {
  const client = createWorkerClient(worker);
  let turnSequence = 0;
  let loadedUrl = null;

  function runStream(turnId, send, { onToolCalls, onDelta } = {}) {
    return new Promise((resolve, reject) => {
      const settle = (callback, value) => {
        unsubscribe();
        unsubscribeFailure();
        callback(value);
      };
      const unsubscribe = client.subscribe((data) => {
        if (data.turnId !== turnId) return;
        if (data.type === 'tool_calls') onToolCalls?.(data.calls, data.ms);
        else if (data.type === 'delta') onDelta?.(data.text);
        else if (data.type === 'done') settle(resolve, data);
        else if (data.type === 'error') settle(reject, new Error(data.message));
      });
      const unsubscribeFailure = client.onFailure((error) =>
        settle(reject, error),
      );
      send();
    });
  }

  return {
    get loadedUrl() {
      return loadedUrl;
    },
    async load(model, { onProgress, maxNumTokens = 8192 } = {}) {
      const result = await client.request(
        {
          type: 'load',
          modelUrl: model.url,
          sha256: model.sha256 || null,
          bytes: model.bytes || 0,
          maxNumTokens,
        },
        { onProgress, done: (data) => data.type === 'loaded' },
      );
      loadedUrl = model.url;
      return result;
    },
    prepare({ system, tools, constrained = false, maxOutputTokens = 256 }) {
      return client.request(
        { type: 'prepare', system, tools, constrained, maxOutputTokens },
        { done: (data) => data.type === 'prepared' },
      );
    },
    /** Starts one turn on a clone of the prepared prefix. */
    turn(text, handlers = {}) {
      const turnId = `turn-${++turnSequence}`;
      const done = runStream(
        turnId,
        () => client.post({ type: 'turn', turnId, text }),
        handlers,
      );
      return { turnId, done };
    },
    continueTurn(turnId, results, handlers = {}) {
      return runStream(
        turnId,
        () => client.post({ type: 'tool_result', turnId, results }),
        handlers,
      );
    },
    cancel(turnId) {
      client.post({ type: 'cancel', turnId });
    },
    release(turnId) {
      return client.request({ type: 'release', turnId }).catch(() => {});
    },
    terminate() {
      loadedUrl = null;
      client.terminate();
    },
  };
}

/** Speech recognition client backed by a transformers.js worker. */
export function createSttClient() {
  const client = createWorkerClient(
    new Worker(new URL('./workers/stt.worker.js', import.meta.url), {
      type: 'module',
      name: 'gev-local-stt',
    }),
  );
  return {
    load(model, { onProgress } = {}) {
      return client.request(
        {
          type: 'load',
          repo: model.repo,
          revision: model.revision,
          dtype: model.dtype,
          language: model.language || null,
        },
        { onProgress, done: (data) => data.type === 'loaded' },
      );
    },
    transcribe(audio) {
      return client.request(
        { type: 'transcribe', audio },
        {
          transfer: [audio.buffer],
          done: (data) => data.type === 'transcript',
        },
      );
    },
    terminate() {
      client.terminate();
    },
  };
}

/** Kokoro speech synthesis client backed by a worker. */
export function createKokoroClient({
  voice = TTS_MODEL.voice,
  speed = 1,
} = {}) {
  const client = createWorkerClient(
    new Worker(new URL('./workers/tts.worker.js', import.meta.url), {
      type: 'module',
      name: 'gev-local-tts',
    }),
  );
  return {
    load({ onProgress } = {}) {
      return client.request(
        {
          type: 'load',
          repo: TTS_MODEL.repo,
          revision: TTS_MODEL.revision,
          dtype: TTS_MODEL.dtype,
          voice,
        },
        { onProgress, done: (data) => data.type === 'loaded' },
      );
    },
    synthesize(text) {
      return client.request(
        { type: 'speak', text, voice, speed },
        { done: (data) => data.type === 'audio' },
      );
    },
    flush() {
      return client.request({ type: 'flush' }).catch(() => {});
    },
    terminate() {
      client.terminate();
    },
  };
}

/** Checks WebGPU, adapter limits and reported memory for a model. */
export async function probeLocalVoiceSupport(model) {
  const hasWebGpu = Boolean(globalThis.navigator?.gpu);
  let adapter = null;
  if (hasWebGpu) {
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch {
      adapter = null;
    }
  }
  return checkLocalVoiceSupport({
    hasWebGpu,
    adapter: Boolean(adapter),
    maxBufferSize: adapter?.limits?.maxBufferSize,
    deviceMemoryGB: globalThis.navigator?.deviceMemory,
    isSecureContext: globalThis.isSecureContext,
    model,
  });
}

async function libraryCacheHas(fragment, cachesApi = globalThis.caches) {
  for (const name of LIBRARY_CACHES) {
    try {
      const cache = await cachesApi.open(name);
      const keys = await cache.keys();
      if (keys.some((request) => request.url.includes(fragment))) return true;
    } catch {
      /* cache unavailable */
    }
  }
  return false;
}

/**
 * Asks the browser to keep downloaded models and reports when the models
 * still to download do not fit, or when storage is not persistent.
 * @param {{llm: object, stt: object, ttsEngine: string}} selection
 */
export async function checkModelStorage({ llm, stt, ttsEngine }) {
  const storage = globalThis.navigator?.storage;
  let persisted;
  try {
    persisted = (await storage?.persisted?.()) || (await storage?.persist?.());
  } catch {
    persisted = undefined;
  }
  const pending = [];
  if (!(await isModelCached(llm.url))) pending.push(llm);
  if (!(await libraryCacheHas(`${stt.repo}/resolve/`)))
    pending.push({ label: stt.label, bytes: stt.approxBytes });
  if (
    ttsEngine === 'kokoro' &&
    !(await libraryCacheHas(`${TTS_MODEL.repo}/resolve/`))
  )
    pending.push({ label: 'Kokoro voice', bytes: TTS_MODEL.approxBytes });
  let estimate = null;
  try {
    estimate = await storage?.estimate?.();
  } catch {
    estimate = null;
  }
  return {
    note: storageAdvice(estimate, pending, {
      persisted: persisted === undefined ? undefined : Boolean(persisted),
    }),
    persisted,
    usage: estimate?.usage ?? null,
  };
}

/** Deletes every downloaded on-device voice model from browser storage. */
export async function clearDownloadedModels(cachesApi = globalThis.caches) {
  let removed = 0;
  for (const name of [MODEL_CACHE_NAME, ...LIBRARY_CACHES]) {
    try {
      if (await cachesApi.delete(name)) removed++;
    } catch {
      /* cache unavailable */
    }
  }
  return removed;
}

let sharedEngine = null;

/**
 * The page's on-device engine: workers for the language model, speech
 * recognition and (when chosen) Kokoro speech. Loaded models outlive a
 * voice session so reopening the microphone is instant.
 */
export function localVoiceEngine() {
  if (sharedEngine) return sharedEngine;
  const llm = createLlmClient();
  const stt = createSttClient();
  let kokoro = null;
  const engine = {
    llm,
    stt,
    get kokoro() {
      return kokoro;
    },
    llmId: null,
    sttId: null,
    kokoroReady: false,
    prepared: false,
    loads: [],
    pending: null,
    /**
     * Loads whatever is missing, then prefills the tool prompt once.
     * @param {{llmModel: object, sttModel: object, ttsEngine: string,
     *   system: string, tools: object[], onProgress?: Function,
     *   onPhase?: Function}} options
     */
    async ensure(options) {
      // A second start while models load waits for the first, then only
      // loads what is still missing.
      while (engine.pending) await engine.pending.catch(() => {});
      engine.pending = load(options);
      try {
        return await engine.pending;
      } finally {
        engine.pending = null;
      }
    },
    terminate() {
      llm.terminate();
      stt.terminate();
      kokoro?.terminate();
      if (sharedEngine === engine) sharedEngine = null;
    },
  };
  async function load({
    llmModel,
    sttModel,
    ttsEngine,
    system,
    tools,
    onProgress,
    onPhase,
  }) {
    const timings = {};
    const jobs = [];
    const report = (key) => (event) => onProgress?.(key, event);
    if (engine.llmId !== llmModel.id) {
      engine.prepared = false;
      engine.llmId = null;
      jobs.push(
        llm.load(llmModel, { onProgress: report('llm') }).then((result) => {
          timings.llm = result;
          engine.llmId = llmModel.id;
        }),
      );
    }
    if (engine.sttId !== sttModel.id) {
      engine.sttId = null;
      jobs.push(
        stt.load(sttModel, { onProgress: report('stt') }).then((result) => {
          timings.stt = result;
          engine.sttId = sttModel.id;
        }),
      );
    }
    if (ttsEngine === 'kokoro' && !engine.kokoroReady) {
      kokoro ||= createKokoroClient();
      // Natural voice is optional: when it cannot load (its phonemizer
      // download or hash check failed, or the weights did not load) the
      // session speaks with a system voice instead of failing to start.
      const client = kokoro;
      jobs.push(
        client.load({ onProgress: report('tts') }).then(
          (result) => {
            timings.tts = result;
            engine.kokoroReady = true;
          },
          (error) => {
            timings.ttsError = error?.message || String(error);
            client.terminate();
            if (kokoro === client) kokoro = null;
          },
        ),
      );
    }
    await Promise.all(jobs);
    if (!engine.prepared) {
      onPhase?.('preparing');
      timings.prepare = await llm.prepare({ system, tools });
      engine.prepared = true;
    }
    engine.loads.push({ at: Date.now(), llm: llmModel.id, timings });
    return engine;
  }
  sharedEngine = engine;
  return engine;
}
