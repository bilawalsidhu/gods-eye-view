const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'mt',
  'ft',
  'vs',
  'etc',
  'approx',
  'no',
  'jr',
  'sr',
]);

const DIGIT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

/**
 * Incremental sentence splitter for streamed model text.
 * push() returns sentences completed so far; flush() returns the remainder.
 */
export function createSentenceSplitter({ minChars = 12, maxChars = 220 } = {}) {
  let buffer = '';
  const take = (final) => {
    const out = [];
    for (;;) {
      const end = findBoundary(buffer, minChars);
      if (end < 0) break;
      out.push(buffer.slice(0, end).trim());
      buffer = buffer.slice(end);
    }
    if (buffer.length > maxChars) {
      const cut = buffer.lastIndexOf(' ', maxChars);
      const at = cut > minChars ? cut : maxChars;
      out.push(buffer.slice(0, at).trim());
      buffer = buffer.slice(at);
    }
    if (final && buffer.trim()) {
      out.push(buffer.trim());
      buffer = '';
    }
    return out.filter(Boolean);
  };
  return {
    push(text) {
      buffer += String(text || '');
      return take(false);
    },
    flush() {
      return take(true);
    },
    reset() {
      buffer = '';
    },
  };
}

function findBoundary(text, minChars) {
  const pattern = /[.!?…]+["')\]]*(\s+|$)|\n+/g;
  let match;
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length;
    if (end < minChars) continue;
    if (match.index + match[0].length === text.length && !/\s$/.test(match[0]))
      return -1;
    if (text[match.index] === '.') {
      const word = /([A-Za-z]+)$/.exec(text.slice(0, match.index))?.[1];
      if (word && ABBREVIATIONS.has(word.toLowerCase())) continue;
      if (/\d$/.test(text.slice(0, match.index)) && /^\d/.test(text.slice(end)))
        continue;
    }
    return end;
  }
  return -1;
}

/**
 * Prepares text for speech: strips markdown and markup, spells callsign-like
 * tokens (letters followed by digits) and expands common units.
 */
export function normalizeForSpeech(text) {
  return String(text || '')
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`>|]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b([A-Z]{2,4})(\d{1,4}[A-Z]?)\b/g, (_, letters, digits) =>
      spellCallsign(letters, digits),
    )
    .replace(/(\d)\s?km\b/g, '$1 kilometers')
    .replace(/(\d)\s?m\/s\b/g, '$1 meters per second')
    .replace(/(\d)\s?ft\b/g, '$1 feet')
    .replace(/(\d)\s?kts?\b/g, '$1 knots')
    .replace(/\s+/g, ' ')
    .trim();
}

function spellCallsign(letters, digits) {
  const spoken = [...digits].map((char) =>
    /\d/.test(char) ? DIGIT_WORDS[Number(char)] : char,
  );
  return [...letters, ...spoken].join(' ');
}

/** Clips a reply to a short spoken form; the full text stays on screen. */
export function spokenExcerpt(text, maxSentences = 2) {
  const splitter = createSentenceSplitter({ minChars: 1 });
  const sentences = [...splitter.push(String(text || '')), ...splitter.flush()];
  return sentences.slice(0, maxSentences).join(' ');
}
