import { realtimeDirectives } from '../openai/instructions.js';

// Voice wording in the shared directives and its written form. A test checks
// each phrase still occurs in the directives, so rewording one there fails
// rather than leaking spoken wording into chat.
export const TEXT_WORDING = Object.freeze([
  ['without speaking first', 'without writing a preamble'],
  ['before speaking', 'before confirming'],
  ['may first say ONE sentence', 'may first write ONE sentence'],
  ["speak the result's say line", "write the result's say line"],
  ['on the voice card: speak a caveat', 'in the tool result: include a caveat'],
  ['as you talk', 'as you write'],
  ['you can read aloud', 'you can report'],
]);

// Shared-manual adaptation follows Darren Dignam's GEV COMMAND approach (#976).
// Keep our Radio handoff and annotation outcome policies from the shared manual.
// `options.overpass` matches the tools offered, as for voice.
export function textInstructions(annotationGuidance, options) {
  return realtimeDirectives(annotationGuidance, options)
    .map((line, index) => {
      if (index === 0)
        return "You are GEV Chat, a concise text assistant for a Cesium geospatial app called God's Eye View.";
      if (index === 1)
        return 'Have a natural written conversation. This is text-only chat; no microphone or generated audio is used.';
      return TEXT_WORDING.reduce(
        (text, [spoken, written]) => text.replace(spoken, written),
        line,
      );
    })
    .join('\n');
}
