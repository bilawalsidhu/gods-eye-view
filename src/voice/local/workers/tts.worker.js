import { KokoroTTS, env } from 'kokoro-js';
import { loadPhonemizer } from './phonemizerRuntime.js';
import { onnxWasmPaths, requireRuntime } from './runtimeAssets.js';

env.wasmPaths = { ...requireRuntime(onnxWasmPaths.kokoro, 'ONNX Runtime') };

// kokoro-js loads the model and its voice vectors from the repository's
// main branch without a revision option; pin those requests to the
// catalogued revision.
const REPOSITORY_PATH =
  /(\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/)main\//;
let pinnedRevision = null;
const baseFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (pinnedRevision && url && REPOSITORY_PATH.test(url))
    return baseFetch(
      url.replace(REPOSITORY_PATH, `$1${pinnedRevision}/`),
      init,
    );
  return baseFetch(input, init);
};

let tts = null;
let queue = Promise.resolve();
let generation = 0;

const post = (message, transfer) => self.postMessage(message, transfer || []);

self.onmessage = ({ data }) => {
  const { type, id } = data || {};
  if (type === 'flush') {
    generation++;
    post({ type: 'flushed', id });
    return;
  }
  const epoch = generation;
  queue = queue
    .then(async () => {
      if (type === 'load') await load(data);
      else if (type === 'speak') await speak(data, epoch);
    })
    .catch((error) =>
      post({ type: 'error', id, message: error?.message || String(error) }),
    );
};

async function load({ id, repo, revision, dtype, voice = 'af_heart' }) {
  if (tts) {
    post({ type: 'loaded', id, ms: 0, reused: true });
    return;
  }
  const started = performance.now();
  // The phonemizer is downloaded and verified first, so a failed check
  // stops natural voice before any model weights are fetched.
  const phonemizer = await loadPhonemizer();
  const files = new Map();
  pinnedRevision = revision || null;
  tts = await KokoroTTS.from_pretrained(repo, {
    dtype,
    device: 'webgpu',
    progress_callback: (event) => {
      if (event.status !== 'progress' || !event.file) return;
      files.set(event.file, { loaded: event.loaded, total: event.total });
      let loaded = 0;
      let total = 0;
      for (const file of files.values()) {
        loaded += file.loaded || 0;
        total += file.total || 0;
      }
      post({ type: 'progress', id, loaded, total, phase: 'download' });
    },
  });
  await tts.generate('Ready.', { voice });
  post({
    type: 'loaded',
    id,
    ms: performance.now() - started,
    phonemizer: phonemizer.source,
  });
}

async function speak({ id, text, voice, speed }, epoch) {
  if (epoch !== generation) {
    post({ type: 'audio', id, skipped: true });
    return;
  }
  if (!tts) throw new Error('Speech synthesis is not loaded');
  const started = performance.now();
  const audio = await tts.generate(text, { voice, speed });
  if (epoch !== generation) {
    post({ type: 'audio', id, skipped: true });
    return;
  }
  const samples = audio.audio;
  post(
    {
      type: 'audio',
      id,
      samples,
      sampleRate: audio.sampling_rate,
      ms: performance.now() - started,
    },
    [samples.buffer],
  );
}
