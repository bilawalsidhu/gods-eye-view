import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_WARNING,
  COMMON_TRUNCATION_WINDOWS,
  PREFIX_SURVIVAL_RATIO,
  detectPrefixTruncation,
  diagnoseToolTurn,
  looksLikeDefaultWindow,
  looksLikeReasoningOverflow,
  looksLikeTextualToolCall,
} from '../../server/providers/agent/diagnostics.js';
import {
  agentPromptPrefixTokens,
  estimatePrefixTokens,
  prefixCharacters,
} from '../../server/providers/agent/prefix.js';

const ollama = { kind: 'local', label: 'Ollama' };
const hosted = { kind: 'hosted', label: 'OpenAI' };

test('the prefix size is derived from the real instructions and schemas', () => {
  const characters = prefixCharacters();
  const tokens = agentPromptPrefixTokens();
  // Big enough to be the real manual plus the real tool list, and consistent
  // with the character count rather than written down beside it.
  assert.ok(characters > 20_000, `prefix was only ${characters} characters`);
  assert.equal(tokens, Math.ceil(characters / 4));
  assert.equal(tokens, agentPromptPrefixTokens(), 'the estimate is not stable');
});

test('a smaller prompt yields a smaller estimate', () => {
  const small = estimatePrefixTokens({ instructions: 'short', tools: [] });
  assert.ok(small < agentPromptPrefixTokens());
  assert.equal(estimatePrefixTokens({ instructions: 'abcd', tools: [] }), 2);
});

test('a prompt count far under what was sent reads as truncation', () => {
  const expected = 12_000;
  assert.deepEqual(
    detectPrefixTruncation(
      { prompt_tokens: 4096 },
      { expectedPrefixTokens: expected },
    ),
    {
      truncated: true,
      promptTokens: 4096,
      expected,
    },
  );
  assert.equal(
    detectPrefixTruncation(
      { prompt_tokens: expected * PREFIX_SURVIVAL_RATIO + 1 },
      { expectedPrefixTokens: expected },
    ).truncated,
    false,
  );
});

test('absent or unusable usage is not evidence of truncation', () => {
  for (const usage of [
    null,
    undefined,
    {},
    { prompt_tokens: 0 },
    { prompt_tokens: 'many' },
  ]) {
    const detected = detectPrefixTruncation(usage);
    assert.equal(detected.truncated, false);
    assert.equal(detected.promptTokens, null);
  }
});

test('stock default windows are named so the remedy can be specific', () => {
  for (const window of COMMON_TRUNCATION_WINDOWS) {
    assert.equal(looksLikeDefaultWindow(window), true);
  }
  assert.equal(looksLikeDefaultWindow(16384), false);
  assert.equal(looksLikeDefaultWindow(null), false);
});

test('a tool call written as prose is recognised in the formats models invent', () => {
  for (const content of [
    '<function-call>move_camera</function-call>',
    '<tool_call>{"name":"x"}</tool_call>',
    '```json\n{"name":"fly_to_location","arguments":{}}\n```',
    '{"name":"fly_to_location","arguments":{"query":"Tokyo"}}',
  ]) {
    assert.equal(looksLikeTextualToolCall(content), true, `missed ${content}`);
  }
  for (const content of [
    'Flying to Tokyo.',
    '',
    null,
    'The function call convention is documented in the manual.',
  ]) {
    assert.equal(
      looksLikeTextualToolCall(content),
      false,
      `flagged ${content}`,
    );
  }
});

test('an empty answer cut off while reasoning is reasoning overflow', () => {
  assert.equal(
    looksLikeReasoningOverflow({
      content: '',
      finishReason: 'length',
      reasoningLength: 900,
    }),
    true,
  );
  // An answer, a different stop reason, or no reasoning trace: not overflow.
  assert.equal(
    looksLikeReasoningOverflow({
      content: 'ok',
      finishReason: 'length',
      reasoningLength: 900,
    }),
    false,
  );
  assert.equal(
    looksLikeReasoningOverflow({
      content: '',
      finishReason: 'stop',
      reasoningLength: 900,
    }),
    false,
  );
  assert.equal(looksLikeReasoningOverflow({ content: '' }), false);
});

test('a healthy turn produces no warnings at all', () => {
  assert.deepEqual(
    diagnoseToolTurn({
      usage: { prompt_tokens: agentPromptPrefixTokens() + 200 },
      message: { content: '', tool_calls: [{}] },
      provider: hosted,
      model: 'gpt-5-mini',
      toolCallCount: 1,
      finishReason: 'tool_calls',
    }),
    [],
  );
});

test('a truncated prefix warns, hedges, and names the local remedy', () => {
  const [warning, ...rest] = diagnoseToolTurn({
    usage: { prompt_tokens: 4096 },
    message: { content: 'Flying to Tokyo.' },
    provider: ollama,
    model: 'qwen3:4b',
    toolCallCount: 0,
    finishReason: 'stop',
  });
  assert.deepEqual(rest, []);
  assert.equal(warning.code, AGENT_WARNING.PREFIX_TRUNCATED);
  assert.equal(warning.promptTokens, 4096);
  assert.match(warning.message, /Ollama may have truncated/);
  assert.match(warning.message, /4,096 prompt tokens/);
  assert.match(warning.message, /stock default window/);
  assert.match(warning.remedy, /OLLAMA_CONTEXT_LENGTH=32768/);
});

test('a hosted provider gets a remedy it can actually act on', () => {
  const [warning] = diagnoseToolTurn({
    usage: { prompt_tokens: 100 },
    provider: hosted,
    model: 'tiny-model',
  });
  assert.match(warning.remedy, /larger context window/);
  assert.doesNotMatch(warning.remedy, /OLLAMA/);
});

test('both silent failures can be reported from one turn', () => {
  const warnings = diagnoseToolTurn({
    usage: { prompt_tokens: 4096 },
    message: { content: '<function-call>move_camera</function-call>' },
    provider: ollama,
    model: 'qwen3:4b',
  });
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    [AGENT_WARNING.PREFIX_TRUNCATED, AGENT_WARNING.TEXTUAL_TOOL_CALL],
  );
});

test('reasoning overflow is reported only when no tool actually ran', () => {
  const turn = {
    usage: { prompt_tokens: agentPromptPrefixTokens() + 50 },
    message: { content: '', reasoning: 'x'.repeat(900) },
    provider: ollama,
    model: 'qwen3:4b',
    finishReason: 'length',
  };
  assert.deepEqual(
    diagnoseToolTurn({ ...turn, toolCallCount: 0 }).map(
      (warning) => warning.code,
    ),
    [AGENT_WARNING.REASONING_OVERFLOW],
  );
  assert.deepEqual(diagnoseToolTurn({ ...turn, toolCallCount: 2 }), []);
});

test('the reasoning trace is read from either field providers use', () => {
  const warnings = diagnoseToolTurn({
    usage: { prompt_tokens: agentPromptPrefixTokens() + 50 },
    message: { content: '', reasoning_content: 'x'.repeat(900) },
    provider: hosted,
    model: 'o4-mini',
    finishReason: 'length',
  });
  assert.equal(warnings[0].code, AGENT_WARNING.REASONING_OVERFLOW);
  assert.match(warnings[0].remedy, /reasoning effort/);
});

test('a turn with nothing to assess is assessed without throwing', () => {
  assert.deepEqual(diagnoseToolTurn({}), []);
});
