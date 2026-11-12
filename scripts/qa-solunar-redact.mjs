/**
 * Masking for scripts/qa-solunar.mjs output. The --url may carry
 * credentials (user:pass@host) or tokens in its query; none of that may reach
 * stdout, stderr, log.txt or report.json, whole or in part.
 */
import { redact as redactTokens } from './qa-browserEvidence.mjs';

const safeDecode = (v) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** The secret-bearing parts of a URL: userinfo and every query value. */
export function urlSecrets(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const values = [u.username, u.password, ...u.searchParams.values()];
  return values
    .flatMap((v) => {
      const decoded = safeDecode(v);
      return [
        v,
        decoded,
        encodeURIComponent(decoded),
        Buffer.from(decoded).toString('base64'),
        ...(decoded.length >= 8
          ? [decoded.slice(0, 8), decoded.slice(-6)]
          : []),
      ];
    })
    .filter((v, i, all) => v && v.length >= 3 && all.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);
}

/** redact(text): masks URL userinfo, query strings and the given secrets. */
export function makeRedactor(secrets = []) {
  return (text) => {
    let s = redactTokens(text)
      .replace(/(\/\/)[^/\s@"']*@/g, '$1***@')
      .replace(/\?[^#\s"']*/g, '?***');
    for (const v of secrets) s = s.split(v).join('***');
    return s;
  };
}
