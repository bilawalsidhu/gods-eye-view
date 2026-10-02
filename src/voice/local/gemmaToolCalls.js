// Gemma 4 tool-call text format:
//   <|tool_call>call:NAME{key:<|"|>text<|"|>,flag:true,list:[1,2]}<tool_call|>
// Keys are bare, strings are wrapped in the <|"|> token and other scalars
// are bare JSON-like words. Engines that template for us return structured
// calls; this parser covers raw text output and leaked markup.

const QUOTE = '<|"|>';
const CALL_PATTERN = /<\|tool_call>([\s\S]*?)(?:<tool_call\|>|$)/g;
const MARKUP_PATTERN =
  /<\|tool_call>[\s\S]*?(?:<tool_call\|>|$)|<\|tool_response>[\s\S]*?(?:<tool_response\|>|$)|<\|channel>[\s\S]*?(?:<channel\|>|$)|<\|?turn\|?>|<turn\|>|<\|"\|>/g;

/**
 * Extracts every complete or trailing tool call from model text.
 * @param {string} text
 * @returns {{calls: Array<{name: string, arguments: object}>, text: string}}
 */
export function parseGemmaToolCalls(text) {
  const source = String(text || '');
  const calls = [];
  for (const match of source.matchAll(CALL_PATTERN)) {
    const call = parseCallBody(match[1]);
    if (call) calls.push(call);
  }
  return { calls, text: stripGemmaMarkup(source) };
}

/** Removes tool, thought and turn markup so it never reaches speech. */
export function stripGemmaMarkup(text) {
  return String(text || '')
    .replace(MARKUP_PATTERN, '')
    .trim();
}

function parseCallBody(body) {
  const match = /^\s*call:([A-Za-z_][\w-]*)\s*/.exec(body);
  if (!match) return null;
  const rest = body.slice(match[0].length);
  if (!rest.trim()) return { name: match[1], arguments: {} };
  try {
    const parser = new ValueParser(rest);
    const value = parser.parseValue();
    return {
      name: match[1],
      arguments: value && typeof value === 'object' ? value : {},
    };
  } catch {
    return null;
  }
}

class ValueParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  skip() {
    while (/\s/.test(this.text[this.index] || '')) this.index++;
  }

  startsWith(token) {
    return this.text.startsWith(token, this.index);
  }

  parseValue() {
    this.skip();
    if (this.startsWith(QUOTE)) return this.parseString();
    const char = this.text[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseJsonString();
    return this.parseWord();
  }

  parseString() {
    this.index += QUOTE.length;
    const end = this.text.indexOf(QUOTE, this.index);
    if (end < 0) throw new SyntaxError('Unterminated string');
    const value = this.text.slice(this.index, end);
    this.index = end + QUOTE.length;
    return value;
  }

  parseJsonString() {
    let end = this.index + 1;
    while (end < this.text.length && this.text[end] !== '"') {
      if (this.text[end] === '\\') end++;
      end++;
    }
    const value = JSON.parse(this.text.slice(this.index, end + 1));
    this.index = end + 1;
    return value;
  }

  parseObject() {
    this.index++;
    const out = {};
    for (;;) {
      this.skip();
      if (this.text[this.index] === '}') {
        this.index++;
        return out;
      }
      const key = this.parseKey();
      this.skip();
      if (this.text[this.index] !== ':') throw new SyntaxError('Expected :');
      this.index++;
      out[key] = this.parseValue();
      this.skip();
      if (this.text[this.index] === ',') this.index++;
      else if (this.text[this.index] !== '}')
        throw new SyntaxError('Expected , or }');
    }
  }

  parseKey() {
    if (this.startsWith(QUOTE)) return this.parseString();
    if (this.text[this.index] === '"') return this.parseJsonString();
    const match = /^[A-Za-z_$][\w$-]*/.exec(this.text.slice(this.index));
    if (!match) throw new SyntaxError('Expected key');
    this.index += match[0].length;
    return match[0];
  }

  parseArray() {
    this.index++;
    const out = [];
    for (;;) {
      this.skip();
      if (this.text[this.index] === ']') {
        this.index++;
        return out;
      }
      out.push(this.parseValue());
      this.skip();
      if (this.text[this.index] === ',') this.index++;
      else if (this.text[this.index] !== ']')
        throw new SyntaxError('Expected , or ]');
    }
  }

  parseWord() {
    const match = /^[^,}\]\s]+/.exec(this.text.slice(this.index));
    if (!match) throw new SyntaxError('Expected value');
    this.index += match[0].length;
    const word = match[0];
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    const number = Number(word);
    return Number.isFinite(number) ? number : word;
  }
}

/** Serializes arguments in the Gemma call format (used by tests and evals). */
export function formatGemmaValue(value) {
  if (typeof value === 'string') return QUOTE + value + QUOTE;
  if (Array.isArray(value))
    return '[' + value.map(formatGemmaValue).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => `${key}:${formatGemmaValue(item)}`)
        .join(',') +
      '}'
    );
  return String(value);
}

/** Formats one call exactly as a Gemma 4 model emits it. */
export function formatGemmaToolCall(name, args = {}) {
  return `<|tool_call>call:${name}${formatGemmaValue(args)}<tool_call|>`;
}

const REGIONS = [
  ['<|tool_call>', '<tool_call|>'],
  ['<|tool_response>', '<tool_response|>'],
  ['<|channel>', '<channel|>'],
];
const TOKENS = ['<|turn>', '<turn|>', '<|"|>'];
const MARKERS = [...REGIONS.map(([open]) => open), ...TOKENS];

/**
 * Removes Gemma markup from streamed text without touching whitespace.
 * Markup split across chunks is held until it can be recognised.
 * push() returns speakable text; flush() returns what is left.
 */
export function createMarkupFilter() {
  let buffer = '';
  const drain = (final) => {
    let out = '';
    for (;;) {
      const at = buffer.indexOf('<');
      if (at < 0) {
        out += buffer;
        buffer = '';
        return out;
      }
      out += buffer.slice(0, at);
      buffer = buffer.slice(at);
      const region = REGIONS.find(([open]) => buffer.startsWith(open));
      if (region) {
        const end = buffer.indexOf(region[1], region[0].length);
        if (end < 0) {
          if (final) buffer = '';
          return out;
        }
        buffer = buffer.slice(end + region[1].length);
        continue;
      }
      const token = TOKENS.find((item) => buffer.startsWith(item));
      if (token) {
        buffer = buffer.slice(token.length);
        continue;
      }
      const partial = MARKERS.some((marker) => marker.startsWith(buffer));
      if (partial && !final) return out;
      out += '<';
      buffer = buffer.slice(1);
    }
  };
  return {
    push: (text) => {
      buffer += String(text || '');
      return drain(false);
    },
    flush: () => drain(true),
  };
}
