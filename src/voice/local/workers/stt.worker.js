import { env, pipeline } from '@huggingface/transformers';
import { onnxWasmPaths, requireRuntime } from './runtimeAssets.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = {
  ...requireRuntime(onnxWasmPaths.transformers, 'ONNX Runtime'),
};

let recognizer = null;
let recognizerKey = null;
let recognizerLanguage = null;
let queue = Promise.resolve();

const post = (message, transfer) => self.postMessage(message, transfer || []);

self.onmessage = ({ data }) => {
  const { type, id } = data || {};
  queue = queue
    .then(async () => {
      if (type === 'load') await load(data);
      else if (type === 'transcribe') await transcribe(data);
    })
    .catch((error) =>
      post({ type: 'error', id, message: error?.message || String(error) }),
    );
};

async function load({ id, repo, revision, dtype, language = null }) {
  const key = JSON.stringify({ repo, revision, dtype });
  if (recognizer && recognizerKey === key) {
    recognizerLanguage = language;
    post({ type: 'loaded', id, ms: 0, reused: true });
    return;
  }
  const started = performance.now();
  await recognizer?.dispose?.();
  const files = new Map();
  recognizer = await pipeline('automatic-speech-recognition', repo, {
    device: 'webgpu',
    dtype,
    revision,
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
  recognizerKey = key;
  recognizerLanguage = language;
  await recognizer(new Float32Array(16000), recognizerOptions());
  post({ type: 'loaded', id, ms: performance.now() - started });
}

function recognizerOptions() {
  return recognizerLanguage
    ? { language: recognizerLanguage, task: 'transcribe', max_new_tokens: 96 }
    : { max_new_tokens: 96 };
}

async function transcribe({ id, audio }) {
  if (!recognizer) throw new Error('Speech recognition is not loaded');
  const started = performance.now();
  const output = await recognizer(audio, recognizerOptions());
  const text = (Array.isArray(output) ? output[0]?.text : output?.text) || '';
  post({
    type: 'transcript',
    id,
    text: text.trim(),
    ms: performance.now() - started,
    audioMs: (audio.length / 16000) * 1000,
  });
}
