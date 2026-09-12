import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localVoiceInstallPlan } from '../src/voice/localVoiceSetupCore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, 'config', 'localai');
/** Pipeline config the browser asks for; every stage is read out of this file. */
const PIPELINE_NAME = 'gpt-realtime';
/** WebRTC audio codec backend. No model config names it, the transport needs it. */
const ALWAYS_BACKENDS = Object.freeze(['opus']);

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

/** Stage names a pipeline config declares (vad, transcription, llm, tts). */
export function parsePipelineStages(text) {
  const stages = {};
  let inPipeline = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (/^pipeline:\s*$/.test(line)) { inPipeline = true; continue; }
    if (!/^\s/.test(line)) { inPipeline = false; continue; }
    if (!inPipeline) continue;
    const match = /^\s{2}(vad|transcription|llm|tts):\s*(\S+)$/.exec(line);
    if (match) stages[match[1]] = match[2];
  }
  return stages;
}

/** The backend a model config runs on, if it names one. */
export function parseBackend(text) {
  return /^backend:\s*(\S+)\s*$/m.exec(String(text))?.[1] ?? null;
}

/** The `parameters.model` value a model config names, if any. */
export function parseModelParameter(text) {
  return /^\s{2}model:\s*(\S+)\s*$/m.exec(String(text))?.[1] ?? null;
}

/**
 * Whether a model value names a Hugging Face repo rather than a local weight
 * file. "openbmb/MiniCPM5-2B-MLX" is downloaded from the Hub;
 * "parakeet-cpp/realtime_eou_120m-v1-f16.gguf" comes from LocalAI's gallery.
 */
export function isHuggingFaceRepo(value) {
  return Boolean(value) && /^[^/\s]+\/[^/\s]+$/.test(value) && !/\.[A-Za-z0-9]{1,8}$/.test(value);
}

/**
 * Read what the profile actually declares, so swapping a stage is a YAML edit
 * rather than a code change: the backends to install, the gallery models to
 * pull, and the Hugging Face weights to download all come from these files.
 */
export function readProfile(profileDir = PROFILE_DIR, pipelineName = PIPELINE_NAME) {
  const dir = path.join(profileDir, 'models');
  const stages = parsePipelineStages(fs.readFileSync(path.join(dir, `${pipelineName}.yaml`), 'utf8'));
  const names = Object.values(stages);
  if (!names.length) throw new Error(`${pipelineName}.yaml declares no pipeline stages`);

  const backends = new Set(ALWAYS_BACKENDS);
  const gallery = [];
  const weights = [];
  for (const name of names) {
    const file = path.join(dir, `${name}.yaml`);
    if (!fs.existsSync(file)) {
      // A stage with no config of ours is a plain gallery model.
      gallery.push(name);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const backend = parseBackend(text);
    if (backend) backends.add(backend);
    const parameter = parseModelParameter(text);
    if (isHuggingFaceRepo(parameter)) weights.push({ name, repoId: parameter });
    else gallery.push(name);
  }
  return { pipelineName, stages, backends: [...backends], gallery, weights };
}

/** Hugging Face cache directory name for a repo id. */
export function hfCacheDirName(repoId) {
  return `models--${repoId.replace(/\//g, '--')}`;
}

/**
 * Whether a COMPLETE snapshot of the repo is cached under modelsDir.
 *
 * Hugging Face links a snapshot file only once its blob finishes, so a
 * snapshot carrying both config and weights means the download is done —
 * an interrupted pull leaves the config without any .safetensors beside it.
 */
export function weightsPresent(modelsDir, repoId) {
  const snapshots = path.join(modelsDir, hfCacheDirName(repoId), 'snapshots');
  if (!fs.existsSync(snapshots)) return false;
  return fs.readdirSync(snapshots).some((entry) => {
    const dir = path.join(snapshots, entry);
    if (!fs.statSync(dir).isDirectory()) return false;
    const names = fs.readdirSync(dir);
    return names.includes('config.json') && names.some((name) => name.endsWith('.safetensors'));
  });
}

/**
 * Weights are pulled during setup rather than left to the first session:
 * LocalAI downloads them lazily on first load, which turns a click on LOCAL
 * into a silent multi-GB wait.
 *
 * The venv ships from a build machine, so its console scripts (hf,
 * huggingface-cli) carry that machine's interpreter path and cannot run here.
 * Calling the library through the venv's own python avoids the shebang and
 * still reports progress.
 */
const HF_SNAPSHOT_SNIPPET = 'import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1]))';

/**
 * The exact process an install step runs, or null when the step is file work in
 * this process. One policy for the CLI and for the dev server's installer.
 */
export function stepCommand(step, { executable, backendsDir, modelsDir, environment = {} } = {}) {
  if (step?.kind === 'backend') {
    return { command: executable, args: ['backends', 'install', step.arg], environment };
  }
  if (step?.kind === 'model') {
    return { command: executable, args: ['models', 'install', step.arg], environment };
  }
  if (step?.kind === 'weights') {
    const python = path.join(backendsDir, 'metal-mlx', 'venv', 'bin', 'python');
    return {
      command: python,
      args: ['-c', HF_SNAPSHOT_SNIPPET, step.arg],
      environment: { ...environment, HF_HUB_CACHE: modelsDir },
    };
  }
  return null;
}

/** Steps that are file work rather than a spawned command. */
export function runLocalStep(step, { profileDir = PROFILE_DIR, modelsDir, backendsDir } = {}) {
  if (step?.kind === 'configs') {
    for (const name of fs.readdirSync(path.join(profileDir, 'models'))) {
      fs.copyFileSync(path.join(profileDir, 'models', name), path.join(modelsDir, name));
    }
    return null;
  }
  if (step?.kind === 'compat') {
    return applyMlxCompatibility({ backendsDir, profileDir, checkOnly: false, missing: [] });
  }
  return null;
}

/**
 * Patch the installed MLX backend and MLX-LM for MiniCPM-style tool calls.
 * Only profiles that actually run an mlx stage need this.
 */
function applyMlxCompatibility({ backendsDir, checkOnly, missing, profileDir }) {
  const mlxBackend = path.join(backendsDir, 'metal-mlx');
  const backendFile = path.join(mlxBackend, 'backend.py');
  const streamFilterTarget = path.join(mlxBackend, 'function_stream_filter.py');
  if (!fs.existsSync(backendFile)) throw new Error(`MLX backend not found at ${mlxBackend}`);
  const sitePackages = findSitePackages(mlxBackend);
  const tokenizerFile = path.join(sitePackages, 'mlx_lm', 'tokenizer_utils.py');
  const parserTarget = path.join(sitePackages, 'mlx_lm', 'tool_parsers', 'minicpm5.py');
  if (!fs.existsSync(tokenizerFile)) throw new Error(`MLX-LM tokenizer not found at ${tokenizerFile}`);

  const backendSource = fs.readFileSync(backendFile, 'utf8');
  const tokenizerSource = fs.readFileSync(tokenizerFile, 'utf8');
  const patchedBackend = patchLocalAiBackendSource(backendSource);
  const patchedTokenizer = patchTokenizerSource(tokenizerSource);

  if (checkOnly) {
    if (patchedBackend !== backendSource) missing.push('LocalAI MLX compatibility patch');
    if (patchedTokenizer !== tokenizerSource) missing.push('MiniCPM5 parser registration');
    if (!fs.existsSync(streamFilterTarget)) missing.push('stream function filter');
    if (!fs.existsSync(parserTarget)) missing.push('MiniCPM5 parser');
    return null;
  }

  writeChanged(backendFile, patchedBackend);
  writeChanged(tokenizerFile, patchedTokenizer);
  fs.copyFileSync(path.join(profileDir, 'compat', 'function_stream_filter.py'), streamFilterTarget);
  if (!fs.existsSync(parserTarget)) {
    fs.copyFileSync(path.join(profileDir, 'compat', 'minicpm5.py'), parserTarget);
  }
  return { fingerprint: sha256(patchedBackend + patchedTokenizer) };
}

export function setupLocalVoice({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  checkOnly = false,
  profileDir = PROFILE_DIR,
} = {}) {
  const profile = readProfile(profileDir);
  const usesMlx = profile.backends.includes('mlx');
  // Only the MLX stack is Apple-Silicon-bound; a profile that swaps in a
  // llama.cpp stage has no reason to refuse to install elsewhere.
  if (usesMlx && (platform !== 'darwin' || architecture !== 'arm64')) {
    throw new Error('The mlx stage in this profile requires an Apple Silicon Mac');
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

  let fingerprint = null;
  if (!checkOnly) {
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(backendsDir, { recursive: true });
    const cachedRepos = profile.weights
      .filter(({ repoId }) => weightsPresent(modelsDir, repoId))
      .map(({ repoId }) => repoId);
    for (const step of localVoiceInstallPlan(profile, { cachedRepos })) {
      console.log(step.cached ? step.label : `${step.label}…`);
      if (step.cached) continue;
      const spec = stepCommand(step, { executable, backendsDir, modelsDir, environment: childEnvironment });
      if (spec) command(spec.command, spec.args, spec.environment);
      else fingerprint = runLocalStep(step, { profileDir, modelsDir, backendsDir })?.fingerprint ?? fingerprint;
    }
  }

  const missing = [];
  for (const name of fs.readdirSync(path.join(profileDir, 'models'))) {
    if (!fs.existsSync(path.join(modelsDir, name))) missing.push(`model config ${name}`);
  }
  for (const { name, repoId } of profile.weights) {
    if (!weightsPresent(modelsDir, repoId)) missing.push(`${name} weights (${repoId})`);
  }
  // Both paths verify; only the check path refuses.
  if (usesMlx) applyMlxCompatibility({ backendsDir, checkOnly: true, missing, profileDir });

  if (checkOnly && missing.length) {
    throw new Error(`Local voice setup incomplete (${missing.join(', ')}) — run npm run voice:local:setup`);
  }
  return { home, ready: true, profile: profile.pipelineName, fingerprint };
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
