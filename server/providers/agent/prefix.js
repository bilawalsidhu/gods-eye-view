import { CHARS_PER_TOKEN } from '../../../src/agent/conversation.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { buildAgentInstructions } from './instructions.js';
import { toChatCompletionTools } from './toolSchema.js';

/**
 * How large the fixed part of every agent request is.
 *
 * Instructions plus the tool schemas are resent on every round trip, so their
 * size decides which models can hold the request at all and dominates the
 * per-command cost. It is DERIVED from the actual instruction string and the
 * actual schemas rather than written down, because a hard-coded figure stops
 * being true the first time somebody edits a directive or adds a tool — and
 * it stops being true silently, which is the whole failure mode the truncation
 * warning exists to catch.
 *
 * The figure is a heuristic: it counts characters, not tokens, because the
 * tokenizer differs per provider and is not available server-side. Everything
 * reading it treats it as approximate.
 */

/** Serialized size of the fixed request prefix, in characters. */
function prefixCharacters({
  instructions = buildAgentInstructions(),
  tools = toChatCompletionTools(GEV_REALTIME_TOOLS),
} = {}) {
  return String(instructions).length + JSON.stringify(tools).length;
}

/**
 * Heuristic token size of the fixed request prefix.
 *
 * @param {{instructions?: string, tools?: object[]}} [parts]
 * @returns {number}
 */
function estimatePrefixTokens(parts = {}) {
  return Math.ceil(prefixCharacters(parts) / CHARS_PER_TOKEN);
}

// Computed once on first use, not at import: the instruction builder reads the
// voice manual and the schema reshape walks every tool, and both are stable
// for the life of the process.
let cached;

/** The running server's prefix estimate. */
function agentPromptPrefixTokens() {
  if (cached === undefined) cached = estimatePrefixTokens();
  return cached;
}

export { agentPromptPrefixTokens, estimatePrefixTokens, prefixCharacters };
