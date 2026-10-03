/**
 * Lets other pages frame the app in embed mode (`?embed=1`). Every other
 * document keeps the server's `X-Frame-Options: DENY` and
 * `frame-ancestors 'none'`, which protect Provider Settings. Embed mode
 * shows only the globe, so for those documents framing is limited to
 * `ancestors` instead: `GEV_EMBED_FRAME_ANCESTORS`, or any frame by default.
 * "Any" sends no framing restriction at all: `frame-ancestors *` would still
 * refuse sandboxed frames with an opaque origin, which panel hosts use.
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
  ancestors = process.env.GEV_EMBED_FRAME_ANCESTORS || '*',
} = {}) {
  const anywhere = ancestors.trim() === '*';
  const policy = `frame-ancestors ${ancestors}`;
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
