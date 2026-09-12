import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, 'config', 'localai');
const BACKENDS = ['opus', 'mlx', 'parakeet-cpp', 'whisper', 'kokoro'];
const MODELS = ['silero-vad-ggml', 'parakeet-cpp-realtime_eou_120m-v1', 'kokoro'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`${label}: expected LocalAI 4.9.0/MLX-LM 0.31.3 source shape was not found`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: patch anchor is ambiguous`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

// LocalAI newer than 4.9.0 coerces both values upstream (mudler/LocalAI#11962)
// with a tuple, while our own patch writes a set. Either shape means "false"
// already reaches the chat template.
const THINKING_HONORS_FALSE = /if enable_thinking in [({]"true", "false"[)}]:/;

export function patchLocalAiBackendSource(source) {
  let output = source;
  if (!output.includes('from function_stream_filter import FunctionStreamFilter')) {
    output = replaceOnce(
      output,
      'from mlx_cache import ThreadSafeLRUPromptCache\n',
      'from mlx_cache import ThreadSafeLRUPromptCache\nfrom function_stream_filter import FunctionStreamFilter\n',
      'MLX stream filter import',
    );
  }
  if (!output.includes('function_filter = FunctionStreamFilter()')) {
    output = replaceOnce(
      output,
      '            accumulated = []\n            last_response = None\n            for response in stream_generate(',
      '            accumulated = []\n            last_response = None\n            function_filter = FunctionStreamFilter()\n            for response in stream_generate(',
      'MLX stream filter state',
    );
    output = replaceOnce(
      output,
      `                # Emit a content delta. Structured reasoning / tool parsing
                # happens on the final chunk so we don't fragment the state
                # machine in v1.
                yield backend_pb2.Reply(
                    message=bytes(response.text, encoding='utf-8'),
                    chat_deltas=[backend_pb2.ChatDelta(content=response.text)],
                )
                # Early stop on user-provided stop sequences`,
      `                # Keep ordinary text streaming, but withhold native
                # <function ...></function> markup from the TTS stage. The raw
                # output is still finalized into structured tool calls below.
                visible_text = function_filter.push(response.text)
                if visible_text:
                    yield backend_pb2.Reply(
                        message=bytes(visible_text, encoding='utf-8'),
                        chat_deltas=[backend_pb2.ChatDelta(content=visible_text)],
                    )
                # Early stop on user-provided stop sequences`,
      'MLX streaming output',
    );
    output = replaceOnce(
      output,
      `                if stop_words and any(s in "".join(accumulated) for s in stop_words):
                    break

            # Final chunk:`,
      `                if stop_words and any(s in "".join(accumulated) for s in stop_words):
                    break

            visible_tail = function_filter.finish()
            if visible_tail:
                yield backend_pb2.Reply(
                    message=bytes(visible_tail, encoding='utf-8'),
                    chat_deltas=[backend_pb2.ChatDelta(content=visible_tail)],
                )

            # Final chunk:`,
      'MLX streaming output tail',
    );
  }
  if (!THINKING_HONORS_FALSE.test(output)) {
    output = replaceOnce(
      output,
      `            if enable_thinking == "true":
                kwargs["enable_thinking"] = True`,
      `            if enable_thinking in {"true", "false"}:
                kwargs["enable_thinking"] = enable_thinking == "true"`,
      'MLX thinking toggle',
    );
  }
  return output;
}

export function patchTokenizerSource(source) {
  if (source.includes('return "minicpm5"')) return source;
  return replaceOnce(
    source,
    `    elif "<arg_key>" in chat_template:
        return "glm47"
    elif "<|tool_list_start|>" in chat_template:`,
    `    elif "<arg_key>" in chat_template:
        return "glm47"
    elif '<function name="' in chat_template and '<param name="' in chat_template:
        return "minicpm5"
    elif "<|tool_list_start|>" in chat_template:`,
    'MiniCPM5 parser detection',
  );
}

function findSitePackages(backendDir) {
  const libDir = path.join(backendDir, 'venv', 'lib');
  const pythonDir = fs.readdirSync(libDir).find((entry) => entry.startsWith('python'));
  if (!pythonDir) throw new Error(`No Python environment found under ${libDir}`);
  return path.join(libDir, pythonDir, 'site-packages');
}

function writeChanged(file, content) {
  const previous = fs.readFileSync(file, 'utf8');
  if (previous === content) return false;
  if (!fs.existsSync(`${file}.gev-backup`)) fs.copyFileSync(file, `${file}.gev-backup`);
  fs.writeFileSync(file, content);
  return true;
}

function command(executable, args, environment) {
  const result = spawnSync(executable, args, {
    cwd: environment.GEV_LOCAL_AI_HOME,
    env: environment,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} exited with ${result.status}`);
}

export function setupLocalVoice({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  checkOnly = false,
} = {}) {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error('The bundled MiniCPM5 MLX profile requires an Apple Silicon Mac');
  }
  const executable = environment.GEV_LOCAL_AI_BIN || 'local-ai';
  const home = path.resolve(environment.GEV_LOCAL_AI_HOME || path.join(os.homedir(), '.local', 'share', 'localai'));
  const modelsDir = path.join(home, 'models');
  const backendsDir = path.join(home, 'backends');
  const childEnvironment = {
    ...environment,
    GEV_LOCAL_AI_HOME: home,
    LOCALAI_MODELS_PATH: modelsDir,
    LOCALAI_BACKENDS_PATH: backendsDir,
  };

  if (!checkOnly) {
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(backendsDir, { recursive: true });
    for (const backend of BACKENDS) command(executable, ['backends', 'install', backend], childEnvironment);
    for (const model of MODELS) command(executable, ['models', 'install', model], childEnvironment);
    for (const name of fs.readdirSync(path.join(PROFILE_DIR, 'models'))) {
      fs.copyFileSync(path.join(PROFILE_DIR, 'models', name), path.join(modelsDir, name));
    }
  }

  const mlxBackend = path.join(backendsDir, 'metal-mlx');
  const backendFile = path.join(mlxBackend, 'backend.py');
  const streamFilterTarget = path.join(mlxBackend, 'function_stream_filter.py');
  if (!fs.existsSync(backendFile)) throw new Error(`MLX backend not found at ${mlxBackend}`);
  const sitePackages = findSitePackages(mlxBackend);
  const tokenizerFile = path.join(sitePackages, 'mlx_lm', 'tokenizer_utils.py');
  const parserTarget = path.join(sitePackages, 'mlx_lm', 'tool_parsers', 'minicpm5.py');
  if (!fs.existsSync(tokenizerFile)) throw new Error(`MLX-LM tokenizer not found at ${tokenizerFile}`);

  const patchedBackend = patchLocalAiBackendSource(fs.readFileSync(backendFile, 'utf8'));
  const patchedTokenizer = patchTokenizerSource(fs.readFileSync(tokenizerFile, 'utf8'));
  if (checkOnly) {
    const missing = [];
    if (patchedBackend !== fs.readFileSync(backendFile, 'utf8')) missing.push('LocalAI MLX compatibility patch');
    if (patchedTokenizer !== fs.readFileSync(tokenizerFile, 'utf8')) missing.push('MiniCPM5 parser registration');
    if (!fs.existsSync(streamFilterTarget)) missing.push('stream function filter');
    if (!fs.existsSync(parserTarget)) missing.push('MiniCPM5 parser');
    for (const name of fs.readdirSync(path.join(PROFILE_DIR, 'models'))) {
      if (!fs.existsSync(path.join(modelsDir, name))) missing.push(`model config ${name}`);
    }
    if (missing.length) throw new Error(`Local voice setup incomplete: ${missing.join(', ')}`);
    return { home, ready: true };
  }

  writeChanged(backendFile, patchedBackend);
  writeChanged(tokenizerFile, patchedTokenizer);
  fs.copyFileSync(path.join(PROFILE_DIR, 'compat', 'function_stream_filter.py'), streamFilterTarget);
  if (!fs.existsSync(parserTarget)) {
    fs.copyFileSync(path.join(PROFILE_DIR, 'compat', 'minicpm5.py'), parserTarget);
  }
  return { home, ready: true, fingerprint: sha256(patchedBackend + patchedTokenizer) };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const result = setupLocalVoice({ checkOnly });
  console.log(checkOnly
    ? `Local voice profile is ready in ${result.home}`
    : `Local voice profile installed in ${result.home}. Set GEV_VOICE_PROVIDER=local or choose LOCAL in the mic panel.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`[local voice setup] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
