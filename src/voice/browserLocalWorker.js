import {
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
  pipeline,
} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import createPiperPhonemize from '@diffusionstudio/piper-wasm';
import piperWasm from '@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url';
import piperData from '@diffusionstudio/piper-wasm/build/piper_phonemize.data?url';
import {
  modelCacheReader,
  openModelCache,
  selectedLocalModels,
} from './localModelCache.js';
import {
  localChatPayload,
  parseLocalCompletion,
  pcmToWav,
} from './localPrompt.js';

// A single WASM thread works without COEP, which would break third-party map tiles.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = { wasm: ortWasm };
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: ortWasm };
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
let cache;
// Loading inference never initiates a hidden model download, including optional files.
env.fetch = async (url) =>
  (await env.customCache.match(String(url))) ||
  new Response(null, { status: 404 });

let tokenizer, model, recognizer, voice, voiceConfig, phonemizer;
let printedPhonemes;
async function prepare(config, kind, status) {
  if (
    (kind === 'chat' && model) ||
    (kind === 'recognition' && recognizer) ||
    (kind === 'speech' && voice)
  )
    return;
  cache ||= await openModelCache();
  const [chat, recognition, speech] = selectedLocalModels(config);
  env.customCache = modelCacheReader(cache, [chat, recognition, speech]);
  if (kind === 'chat') {
    status(`Loading ${chat.title} from browser cache…`);
    tokenizer = await AutoTokenizer.from_pretrained(chat.repo, {
      revision: chat.revision,
      progress_callback: () => {},
    });
    model = await AutoModelForCausalLM.from_pretrained(chat.repo, {
      revision: chat.revision,
      progress_callback: () => {},
      dtype: chat.dtype,
      device: 'webgpu',
    });
  } else if (kind === 'recognition') {
    status(`Loading ${recognition.title} from browser cache…`);
    recognizer = await pipeline(
      'automatic-speech-recognition',
      recognition.repo,
      {
        revision: recognition.revision,
        progress_callback: () => {},
        dtype: recognition.dtype,
        device: 'wasm',
      },
    );
  } else if (kind === 'speech') {
    status(`Loading ${speech.title} from browser cache…`);
    voiceConfig = await (
      await env.customCache.match(speech.files[1].url)
    ).json();
    voice = await ort.InferenceSession.create(
      await (await env.customCache.match(speech.files[0].url)).arrayBuffer(),
      { executionProviders: ['wasm'] },
    );
    const data = await (await fetch(piperData)).arrayBuffer();
    const wasm = new Uint8Array(await (await fetch(piperWasm)).arrayBuffer());
    phonemizer = await createPiperPhonemize({
      wasmBinary: wasm,
      getPreloadedPackage: () => data,
      print: (line) => {
        printedPhonemes = JSON.parse(line).phoneme_ids;
      },
      printErr: (line) => {
        throw new Error(line);
      },
    });
  } else throw new Error('Unknown local model kind');
}

async function generate(messages, config) {
  const payload = localChatPayload(messages, config);
  // Qwen's template expects parsed arguments for prior assistant tool calls.
  const conversation = payload.messages.map((message) =>
    message.tool_calls
      ? {
          ...message,
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            function: {
              ...call.function,
              arguments: JSON.parse(call.function.arguments),
            },
          })),
        }
      : message,
  );
  let inputs, output;
  try {
    while (true) {
      inputs = tokenizer.apply_chat_template(conversation, {
        tools: payload.tools,
        enable_thinking: false,
        add_generation_prompt: true,
        return_dict: true,
      });
      if (inputs.input_ids.dims.at(-1) + config.maxTokens <= config.context)
        break;
      for (const tensor of Object.values(inputs)) tensor.dispose();
      inputs = null;
      const nextTurn = conversation.findIndex(
        (message, index) => index > 1 && message.role === 'user',
      );
      if (nextTurn < 0)
        throw new Error('This request is too long. Please shorten it.');
      conversation.splice(1, nextTurn - 1);
    }
    const inputLength = inputs.input_ids.dims.at(-1);
    output = await model.generate({
      ...inputs,
      max_new_tokens: config.maxTokens,
      do_sample: false,
    });
    const tokens = output.tolist()[0].slice(inputLength);
    if (tokens.length >= config.maxTokens)
      throw new Error(
        'Bonsai reached the response limit. Try a shorter request.',
      );
    return {
      message: parseLocalCompletion(
        tokenizer.decode(tokens, { skip_special_tokens: true }),
      ),
    };
  } finally {
    output?.dispose();
    for (const tensor of Object.values(inputs || {})) tensor.dispose();
  }
}

async function synthesize(text) {
  printedPhonemes = undefined;
  phonemizer.callMain([
    '-l',
    voiceConfig.espeak.voice,
    '--input',
    JSON.stringify([{ text: text.trim() }]),
    '--espeak_data',
    '/espeak-ng-data',
  ]);
  if (!printedPhonemes?.length)
    throw new Error('Piper could not pronounce this text');
  const ids = BigInt64Array.from(printedPhonemes, BigInt);
  const feeds = {
    input: new ort.Tensor('int64', ids, [1, ids.length]),
    input_lengths: new ort.Tensor(
      'int64',
      BigInt64Array.of(BigInt(ids.length)),
      [1],
    ),
    scales: new ort.Tensor(
      'float32',
      Float32Array.of(
        voiceConfig.inference.noise_scale,
        voiceConfig.inference.length_scale,
        voiceConfig.inference.noise_w,
      ),
      [3],
    ),
  };
  if (Object.keys(voiceConfig.speaker_id_map).length)
    feeds.sid = new ort.Tensor('int64', BigInt64Array.of(0n), [1]);
  let result;
  try {
    result = await voice.run(feeds);
    return new Blob(
      [pcmToWav(result.output.data, voiceConfig.audio.sample_rate)],
      { type: 'audio/wav' },
    );
  } finally {
    for (const tensor of [
      ...Object.values(feeds),
      ...Object.values(result || {}),
    ])
      tensor.dispose();
  }
}

// Main thread serializes turns; reject any overlapping work instead of racing model state.
let busy = false;
self.onmessage = async ({ data: { id, type, data, config } }) => {
  if (busy) {
    self.postMessage({ id, error: 'Local model is busy' });
    return;
  }
  busy = true;
  try {
    let result;
    const kind =
      type === 'prepare'
        ? data.kind
        : type === 'transcribe'
          ? 'recognition'
          : type;
    await prepare(config, kind, (status) => self.postMessage({ id, status }));
    if (type === 'prepare') result = { ready: true };
    else if (type === 'chat') result = await generate(data.messages, config);
    else if (type === 'transcribe')
      result = await recognizer(data.audio, {
        language: config.language === 'ru' ? 'russian' : 'english',
        task: 'transcribe',
        max_new_tokens: 128,
      });
    else if (type === 'speech') result = await synthesize(data.text);
    else throw new Error('Unknown local inference operation');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  } finally {
    busy = false;
  }
};
