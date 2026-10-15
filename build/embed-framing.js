/**
 * Lets chosen pages frame the app in embed mode (`?embed=1`). Every
 * document keeps the server's `X-Frame-Options: DENY` and
 * `frame-ancestors 'none'` unless `GEV_EMBED_FRAME_ANCESTORS` names who may
 * frame embed-mode documents: CSP frame-ancestors sources, or `*` for any
 * page. A framing page can change what the app shows, so no page may frame
 * it by default. Other documents, including Provider Settings, are never
 * framable. "Any" sends no framing restriction at all: `frame-ancestors *`
 * would still refuse sandboxed frames with an opaque origin.
 */

const FRAMING_HEADERS = new Set(['x-frame-options', 'content-security-policy']);

/** The directives of a CSP header value, minus any frame-ancestors rule. */
function withoutFraming(value) {
  return String(value ?? '')
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !/^frame-ancestors\b/i.test(directive));
}

/** Whether a request is for an embed-mode document. */
export function isEmbedDocumentRequest(url) {
  let parsed;
  try {
    parsed = new URL(url || '/', 'http://localhost');
  } catch {
    return false;
  }
  return (
    parsed.searchParams.get('embed') === '1' &&
    (parsed.pathname === '/' || parsed.pathname.endsWith('.html'))
  );
}

/** Vite plugin applying the embed framing policy on dev and preview servers. */
export function embedFramingPlugin({
  ancestors = process.env.GEV_EMBED_FRAME_ANCESTORS || '',
} = {}) {
  const allowed = ancestors.trim();
  // Unset: embed documents keep the server's framing protection.
  if (!allowed) return { name: 'embed-framing' };
  const anywhere = allowed === '*';
  const policy = `frame-ancestors ${allowed}`;
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!isEmbedDocumentRequest(req.url)) return next();
      // The server's own headers are written when the response is sent, so
      // intercept them rather than setting ours first.
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        const key = String(name).toLowerCase();
        if (!FRAMING_HEADERS.has(key)) return setHeader(name, value);
        if (key === 'content-security-policy') {
          // Keep every other directive of the server's policy (script-src,
          // connect-src, ...) and only swap the framing rule.
          const kept = withoutFraming(value);
          const next = anywhere ? kept : [...kept, policy];
          return next.length ? setHeader(name, next.join('; ')) : res;
        }
        return res;
      };
      if (!anywhere) setHeader('Content-Security-Policy', policy);
      next();
    });
  };
  return {
    name: 'embed-framing',
    configureServer: install,
    configurePreviewServer: install,
  };
}
