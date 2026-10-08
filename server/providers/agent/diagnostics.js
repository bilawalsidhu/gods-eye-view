import { agentPromptPrefixTokens } from './prefix.js';

/**
 * Turns the silent failures of chat-completions tool calling into loud ones.
 *
 * Both of these return HTTP 200 with a plausible-looking body, so neither
 * surfaces as an error anywhere else:
 *
 * 1. A truncated tool prefix. Ollama's stock runtime context is 4096 tokens
 *    against this app's much larger prefix, which silently cuts the tool list;
 *    the model then writes a `<function-call>` block as prose and picks the
 *    wrong tool. The registry's context gate cannot catch it, because
 *    `/api/show` reports the model's ARCHITECTURAL context, not the runtime
 *    window the daemon allocated. The only evidence is the prompt token count
 *    that comes back after the fact.
 *
 * 2. Reasoning overflow. A reasoning model spends its whole output budget
 *    thinking and returns empty content with `finish_reason: "length"`.
 *    Raising the ceiling does not help; the remedy is a different model, so
 *    the message has to say that rather than report an empty answer.
 *
 * Every finding here is a WARNING, never a refusal. The prefix size is a
 * character-count heuristic compared against another provider's tokenizer, so
 * it can be wrong in both directions; a turn that produced a valid tool call
 * is a working turn whatever the token arithmetic says.
 */

/** Warning codes carried back to the console. */
const AGENT_WARNING = Object.freeze({
  PREFIX_TRUNCATED: 'prefix-truncated',
  TEXTUAL_TOOL_CALL: 'textual-tool-call',
  REASONING_OVERFLOW: 'reasoning-overflow',
});

/**
 * Fraction of the expected prefix that must survive for a turn to look intact.
 *
 * Deliberately loose: token counting differs between tokenizers, so this is
 * distinguishing "roughly the whole manual arrived" from "the window is a
 * quarter of what we sent".
 */
const PREFIX_SURVIVAL_RATIO = 0.7;

/** Runtime context windows an operator is likely to have left at a default. */
const COMMON_TRUNCATION_WINDOWS = Object.freeze([2048, 4096, 8192]);

/**
 * Detect that the upstream silently truncated the prompt.
 *
 * @param {object|null} usage Upstream usage block.
 * @param {{expectedPrefixTokens?: number}} [options]
 * @returns {{truncated: boolean, promptTokens: number|null, expected: number}}
 */
function detectPrefixTruncation(usage, { expectedPrefixTokens } = {}) {
  const expected = Number.isFinite(expectedPrefixTokens)
    ? expectedPrefixTokens
    : agentPromptPrefixTokens();
  const promptTokens = Number(usage?.prompt_tokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    return { truncated: false, promptTokens: null, expected };
  }
  return {
    truncated: promptTokens < expected * PREFIX_SURVIVAL_RATIO,
    promptTokens,
    expected,
  };
}

/**
 * Whether a prompt-token count lands on a familiar stock window, which makes
 * the remedy specific rather than speculative.
 *
 * @param {number|null} promptTokens
 * @returns {boolean}
 */
function looksLikeDefaultWindow(promptTokens) {
  return COMMON_TRUNCATION_WINDOWS.includes(promptTokens);
}

/**
 * Detect a tool call written as prose instead of issued as a tool call.
 *
 * A model whose tool schemas were truncated away still knows it is supposed to
 * call something, so it improvises a format. Catching this distinguishes a
 * configuration fault from a model that is merely weak.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
function looksLikeTextualToolCall(content) {
  if (typeof content !== 'string' || !content) return false;
  const patterns = [
    /<\s*function[_-]?call\s*>/i,
    /<\s*tool[_-]?call\s*>/i,
    /^\s*```(?:json)?\s*\{\s*"(?:name|function|tool_name)"\s*:/i,
    /^\s*\{\s*"(?:name|tool_name)"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"\s*:/i,
  ];
  return patterns.some((pattern) => pattern.test(content.trim()));
}

/**
 * Detect a reasoning model that spent its whole output budget thinking.
 *
 * @param {{content?: string, finishReason?: string|null, reasoningLength?: number}} turn
 * @returns {boolean}
 */
function looksLikeReasoningOverflow({
  content,
  finishReason,
  reasoningLength = 0,
}) {
  const emptyAnswer = typeof content !== 'string' || !content.trim();
  return emptyAnswer && finishReason === 'length' && reasoningLength > 0;
}

/** Phrase the observed window against what was sent. */
function windowNote({ promptTokens, expected }) {
  if (!promptTokens) return '';
  const stock = looksLikeDefaultWindow(promptTokens)
    ? ', which is a stock default window'
    : '';
  return ` The provider processed ${promptTokens.toLocaleString()} prompt tokens against the roughly ${expected.toLocaleString()} this app sends${stock}.`;
}

/**
 * Assess one completed tool-calling turn.
 *
 * @param {{usage?: object|null, message?: object|null, provider?: object|null,
 *   model?: string, toolCallCount?: number, finishReason?: string|null,
 *   expectedPrefixTokens?: number}} turn
 * @returns {Array<{code: string, message: string, remedy: string,
 *   promptTokens?: number|null}>}
 */
function diagnoseToolTurn({
  usage = null,
  message = null,
  provider = null,
  model = '',
  toolCallCount = 0,
  finishReason = null,
  expectedPrefixTokens,
}) {
  const warnings = [];
  const isLocal = provider?.kind === 'local';
  const label = provider?.label || 'The provider';
  const named = model || 'the model';

  const truncation = detectPrefixTruncation(usage, { expectedPrefixTokens });
  if (truncation.truncated) {
    warnings.push({
      code: AGENT_WARNING.PREFIX_TRUNCATED,
      promptTokens: truncation.promptTokens,
      message: `${label} may have truncated the tool prefix, so ${named} may not have seen the full tool list.${windowNote(truncation)}`,
      remedy: isLocal
        ? 'Raise the runtime context window: set OLLAMA_CONTEXT_LENGTH=16384 on the Ollama server (or PARAMETER num_ctx 16384 in a Modelfile) and restart it.'
        : 'Select a model with a larger context window.',
    });
  }

  if (looksLikeTextualToolCall(message?.content)) {
    warnings.push({
      code: AGENT_WARNING.TEXTUAL_TOOL_CALL,
      message: `${named} wrote a tool call as text instead of issuing one, which usually means its tool definitions were truncated or it does not support tool calling.`,
      remedy: isLocal
        ? 'Confirm the model reports the "tools" capability, and raise OLLAMA_CONTEXT_LENGTH to at least 16384.'
        : 'Select a model that supports tool calling.',
    });
  }

  const reasoning = message?.reasoning ?? message?.reasoning_content;
  if (
    !toolCallCount &&
    looksLikeReasoningOverflow({
      content: message?.content,
      finishReason,
      reasoningLength: typeof reasoning === 'string' ? reasoning.length : 0,
    })
  ) {
    warnings.push({
      code: AGENT_WARNING.REASONING_OVERFLOW,
      message: `${named} spent its entire output budget on internal reasoning and returned no answer.`,
      remedy: isLocal
        ? 'Use a non-reasoning instruct model for typed commands. A reasoning model can think past any output ceiling on a one-line task.'
        : 'Select a non-reasoning model, or one whose reasoning effort can be set to minimal.',
    });
  }

  return warnings;
}

export {
  AGENT_WARNING,
  COMMON_TRUNCATION_WINDOWS,
  PREFIX_SURVIVAL_RATIO,
  detectPrefixTruncation,
  diagnoseToolTurn,
  looksLikeDefaultWindow,
  looksLikeReasoningOverflow,
  looksLikeTextualToolCall,
};
