import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hfCacheDirName,
  llmWeightsPresent,
  patchLocalAiBackendSource,
  patchTokenizerSource,
  readLlmRepoId,
} from '../../scripts/setup-local-voice.mjs';

const BACKEND_FIXTURE = `from mlx_cache import ThreadSafeLRUPromptCache

            accumulated = []
            last_response = None
            for response in stream_generate(
                model,
            ):
                # Emit a content delta. Structured reasoning / tool parsing
                # happens on the final chunk so we don't fragment the state
                # machine in v1.
                yield backend_pb2.Reply(
                    message=bytes(response.text, encoding='utf-8'),
                    chat_deltas=[backend_pb2.ChatDelta(content=response.text)],
                )
                # Early stop on user-provided stop sequences
                if stop_words and any(s in "".join(accumulated) for s in stop_words):
                    break

            # Final chunk:

            if enable_thinking == "true":
                kwargs["enable_thinking"] = True
`;

test('LocalAI compatibility patch filters spoken function markup and honors thinking=false', () => {
  const patched = patchLocalAiBackendSource(BACKEND_FIXTURE);
  assert.match(patched, /FunctionStreamFilter/);
  assert.match(patched, /visible_text = function_filter\.push/);
  assert.match(patched, /visible_tail = function_filter\.finish/);
  assert.match(patched, /enable_thinking in \{"true", "false"\}/);
  assert.equal(patchLocalAiBackendSource(patched), patched, 'patch must be idempotent');
});

test('MLX-LM compatibility patch registers the MiniCPM5 parser once', () => {
  const source = `    elif "<arg_key>" in chat_template:
        return "glm47"
    elif "<|tool_list_start|>" in chat_template:
        return "pythonic"
`;
  const patched = patchTokenizerSource(source);
  assert.match(patched, /return "minicpm5"/);
  assert.equal(patchTokenizerSource(patched), patched, 'patch must be idempotent');
});

test('LocalAI compatibility patch skips the thinking fix when upstream already honors false', () => {
  const upstream = BACKEND_FIXTURE.replace(
    `            if enable_thinking == "true":
                kwargs["enable_thinking"] = True`,
    `            if enable_thinking in ("true", "false"):
                kwargs["enable_thinking"] = enable_thinking == "true"`,
  );
  const patched = patchLocalAiBackendSource(upstream);
  assert.match(patched, /FunctionStreamFilter/);
  assert.match(patched, /enable_thinking in \("true", "false"\)/);
  assert.doesNotMatch(patched, /enable_thinking in \{"true", "false"\}/);
});

test('LLM weights are detected through the Hugging Face cache layout', () => {
  const repoId = readLlmRepoId();
  assert.equal(repoId, 'openbmb/MiniCPM5-2B-MLX');
  assert.equal(hfCacheDirName(repoId), 'models--openbmb--MiniCPM5-2B-MLX');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-localai-'));
  try {
    assert.equal(llmWeightsPresent(root, repoId), false, 'an empty models directory has no weights');

    const snapshot = path.join(root, hfCacheDirName(repoId), 'snapshots', 'abc123');
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, 'config.json'), '{}');
    assert.equal(llmWeightsPresent(root, repoId), false, 'config without weights is an unfinished download');

    fs.writeFileSync(path.join(snapshot, 'model.safetensors'), 'x');
    assert.equal(llmWeightsPresent(root, repoId), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
