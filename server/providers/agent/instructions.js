import { realtimeDirectives } from '../openai/instructions.js';

/**
 * The typed agent's operating manual, adapted from voice's.
 *
 * The manual encodes what the app does, not how the user reached it, so the
 * text transport reads the SAME directive list the Realtime session gets and
 * rewrites only the lines that describe the channel. Keeping a second copy
 * would let the two drift, and every drift is a behaviour difference nobody
 * chose: voice has been tuned for a year and text would silently miss it.
 *
 * A rewrite is matched by its opening words rather than by index, and
 * `adaptDirectives` reports any adaptation that matched no line or more than
 * one, so rewording a voice directive fails a test instead of quietly leaving
 * a "speak your confirmation" instruction in the typed prompt.
 */

/**
 * Channel rewrites applied to the voice manual.
 *
 * Deliberately small. Every entry here is a line that would otherwise tell a
 * typed agent to speak, which produces stage directions in the transcript
 * instead of an answer.
 *
 * @type {ReadonlyArray<{anchor: RegExp, line: string}>}
 */
const TEXT_ADAPTATIONS = Object.freeze([
  {
    anchor: /^You are GEV Voice Control,/,
    line: "You are GEV Command, a concise text controller for a Cesium geospatial app called God's Eye View.",
  },
  {
    anchor: /^Have a natural spoken conversation/,
    line: 'Reply in short written messages. The user types commands into a console; there is no microphone and no spoken audio, so never narrate that you are about to speak.',
  },
  {
    anchor: /^PREAMBLES:/,
    line: 'PREAMBLES: for instant commands (layers, styles, HUD, detection, zoom, panels, basemap, radio controls, and lookups such as get_entity_context) call the tool and write nothing alongside the call. Only for slow or multi-step work (annotate_map, a searched fly_to_location, select_nearest_aircraft, analyst_query over a named place, or two or more tools) you may first write ONE line of at most 12 words naming the actual steps ("Finding the Capitol, then outlining its grounds."), then call the tools at once in the same response.',
  },
  {
    anchor: /^AFTER TOOLS:/,
    line: 'AFTER TOOLS: write the result\'s say line once, lightly rephrased at most, never repeating your preamble. For a requested analyst list or ranking, also name up to three returned items with the relevant returned values; keep their order. A count alone does not answer that request; if say is null, finish any remaining requested tools before confirming. Never add a count, list or action claim that the executed tool results do not support. Add a source, note or caveat only when it changes the answer, or when asked why, how sure or which source. Lower bounds ("at least 500"), partial answers and stale, degraded or unavailable feed states in say are part of the answer — always preserve them. No filler or hedges ("let me check", "keep in mind", "it seems", "based on the data available"), and never add "approximately" to an exact tool number.',
  },
]);

/**
 * Apply channel rewrites to a directive list.
 *
 * Total: it never throws on a missed anchor, because the running server must
 * keep answering commands with a slightly stale manual rather than refuse to
 * start. The `unmatched` and `ambiguous` reports are what the test asserts on.
 *
 * @param {string[]} directives
 * @param {ReadonlyArray<{anchor: RegExp, line: string}>} [adaptations]
 * @returns {{directives: string[], unmatched: RegExp[], ambiguous: RegExp[]}}
 */
function adaptDirectives(directives, adaptations = TEXT_ADAPTATIONS) {
  const adapted = [...(Array.isArray(directives) ? directives : [])];
  const unmatched = [];
  const ambiguous = [];
  for (const { anchor, line } of adaptations) {
    const hits = adapted.reduce(
      (indexes, directive, index) =>
        anchor.test(directive) ? [...indexes, index] : indexes,
      [],
    );
    if (!hits.length) {
      unmatched.push(anchor);
      continue;
    }
    if (hits.length > 1) ambiguous.push(anchor);
    for (const index of hits) adapted[index] = line;
  }
  return { directives: adapted, unmatched, ambiguous };
}

/**
 * The typed agent's directives.
 *
 * @param {{annotationGuidance?: string}} [options]
 * @returns {string[]}
 */
function agentDirectives({ annotationGuidance } = {}) {
  return adaptDirectives(realtimeDirectives(annotationGuidance)).directives;
}

/**
 * The typed agent's system prompt.
 *
 * @param {{annotationGuidance?: string}} [options]
 * @returns {string}
 */
function buildAgentInstructions(options = {}) {
  return agentDirectives(options).join('\n');
}

export {
  TEXT_ADAPTATIONS,
  adaptDirectives,
  agentDirectives,
  buildAgentInstructions,
};
