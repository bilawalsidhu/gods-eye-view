/**
 * Cut a streamed reply into speakable sentences so text-to-speech can start
 * on the first sentence while the model is still generating the rest.
 */
const ABBREVIATIONS =
  /(?:\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|u\.s|u\.k)\.)$/i;

export function createSentenceSplitter({ minChars = 24, maxChars = 220 } = {}) {
  let pending = '';

  function takeSentences() {
    const out = [];
    for (;;) {
      const cut = findBoundary(pending, minChars, maxChars);
      if (cut < 0) break;
      const sentence = pending.slice(0, cut).trim();
      pending = pending.slice(cut).replace(/^\s+/, '');
      if (sentence) out.push(sentence);
    }
    return out;
  }

  return {
    push(delta) {
      if (!delta) return [];
      pending += String(delta);
      return takeSentences();
    },
    flush() {
      const out = takeSentences();
      const rest = pending.trim();
      pending = '';
      if (rest) out.push(rest);
      return out;
    },
    get buffered() {
      return pending;
    },
  };
}

function findBoundary(text, minChars, maxChars) {
  const newline = text.indexOf('\n');
  if (newline >= 0 && text.slice(0, newline).trim()) return newline + 1;
  const pattern = /[.!?…]+["')\]]*\s/g;
  let match;
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length;
    if (end < minChars) continue;
    const before = text.slice(0, match.index + 1);
    if (/\d\.$/.test(before) && /^\d/.test(text.slice(end))) continue;
    if (ABBREVIATIONS.test(before)) continue;
    return end;
  }
  if (text.length >= maxChars) {
    const space = text.lastIndexOf(' ', maxChars);
    return space > minChars ? space + 1 : maxChars;
  }
  return -1;
}

/** Remove markdown decoration so speech and the transcript read naturally. */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,!?])/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
