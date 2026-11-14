// Inspect common transport encodings before forwarding upstream text. Never
// include the credential or the upstream body in a refusal message.
export function containsCredentialEcho(text, token) {
  if (!token) return false;
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
  let candidate = text;
  for (let i = 0; i < 8; i += 1) {
    if (encoded.some((value) => candidate.includes(value))) return true;
    const next = candidate
      .replace(/\\\//g, '/')
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          // A malformed UTF-8 byte must not hide adjacent ASCII escapes.
          return part.replace(/%([0-7][0-9a-f])/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        }
      });
    if (next === candidate) return false;
    candidate = next;
  }
  // Do not forward text whose nested escaping exceeded our bounded work.
  return true;
}
