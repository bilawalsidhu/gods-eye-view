/**
 * Spoken-reply lint shared by the turn spans, the unit tests and the QA
 * harnesses. Pure: no browser or provider dependencies.
 */

/**
 * Phrases that add length without adding an answer. Tool numbers are spoken
 * verbatim, so approximations are hedges too.
 */
export const HEDGE_PHRASES = Object.freeze([
  'keep in mind',
  "it's worth noting",
  'it is worth noting',
  'please note',
  'note that',
  'based on the data available',
  'based on the available data',
  'i should mention',
  'as of my',
  'it seems',
  'it appears',
  'approximately',
  'roughly',
  'let me think',
  'let me check',
  'one moment while',
  'bear with me',
  'just to be clear',
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Count spoken words in a transcript.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  return String(text || '').match(WORD)?.length || 0;
}

/**
 * Return every hedge phrase found in a transcript, in list order.
 * @param {string} text
 * @returns {string[]}
 */
export function findHedges(text) {
  const normalized = ` ${String(text || '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')} `;
  return HEDGE_PHRASES.filter((phrase) => normalized.includes(` ${phrase} `));
}
