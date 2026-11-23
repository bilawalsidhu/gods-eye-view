// Inspect common transport encodings before forwarding upstream text. Never
// include the credential or the upstream body in a refusal message.

/** The escapes a JSON string may carry, apart from `\uXXXX`. */
const SIMPLE_ESCAPES = Object.freeze({
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
  '/': '/',
});

/**
 * How many layers of encoding an upstream body may hide the credential in.
 * Each pass peels one layer; a body that still changes after this many
 * passes is refused rather than forwarded.
 */
const MAX_DECODE_PASSES = 8;

/**
 * The spellings the credential may travel in: itself, and the base64 forms
 * of it, whole and with up to two bytes trimmed from either end.
 */
function encodedForms(token) {
  const bytes = Buffer.from(token);
  const encoded = [token];
  // Full triples remain stable even when the token is embedded at any byte
  // offset in a larger base64 value; discard up to two bytes at each end.
  for (let offset = 0; offset < 3; offset += 1) {
    const length = Math.floor((bytes.length - offset) / 3) * 3;
    if (length >= 18) {
      const slice = bytes.subarray(offset, offset + length);
      encoded.push(slice.toString('base64'), slice.toString('base64url'));
    }
  }
  encoded.push(
    bytes.toString('base64'),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
  );
  return encoded;
}

/**
 * One pass over the escapes a JSON string may carry: `\\` becomes a
 * backslash, `\/` a slash, `\uXXXX` the character it names. A backslash
 * naming no escape is left as it is. One pass peels one layer, so the
 * escape of an escape (`\\uXXXX`, what `JSON.stringify` writes for a string
 * that holds `\uXXXX`) takes a second pass to name what it hides.
 */
function unescapeOnce(text) {
  return text.replace(/\\(u[0-9a-f]{4}|[^u])/gi, (match, sequence) => {
    if (sequence[0].toLowerCase() === 'u')
      return String.fromCharCode(parseInt(sequence.slice(1), 16));
    if (!Object.hasOwn(SIMPLE_ESCAPES, sequence)) return match;
    return SIMPLE_ESCAPES[sequence];
  });
}

/**
 * One pass over percent-encoding. A malformed UTF-8 byte must not hide the
 * ASCII escapes beside it, so the bytes that decode on their own are
 * decoded anyway.
 */
function percentDecodeOnce(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      // A malformed UTF-8 byte must not hide adjacent ASCII escapes.
      return part.replace(/%([0-7][0-9a-f])/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    }
  });
}

/**
 * Whether `text` carries `token` in any of the forms above.
 *
 * The body is peeled a layer at a time — percent-encoding first, then the
 * escapes a JSON string may carry — and the token is looked for after each
 * layer, so a token hidden behind an escape inside a JSON body is found
 * however deeply it is nested. The work is bounded and never recurses: a
 * body that keeps changing for more than `MAX_DECODE_PASSES` layers is
 * refused, not forwarded.
 */
export function containsCredentialEcho(text, token) {
  if (!token) return false;
  const encoded = encodedForms(token);
  let candidate = typeof text === 'string' ? text : String(text ?? '');
  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
    if (encoded.some((value) => candidate.includes(value))) return true;
    if (pass === MAX_DECODE_PASSES) break;
    const next = unescapeOnce(percentDecodeOnce(candidate));
    if (next === candidate) return false;
    candidate = next;
  }
  // Do not forward text whose nested escaping exceeded our bounded work.
  return true;
}
