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

const KEYWORDS = new Set(["'self'", "'none'"]);
/** A CSP host source: scheme, host (optionally `*.`-prefixed) and port, no path or quotes. */
const HOST_SOURCE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?[a-z0-9.-]+(?::(?:\d{1,5}|\*))?\/?$/i;
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/i;

/**
 * Normalizes `GEV_EMBED_FRAME_ANCESTORS` into CSP frame-ancestors sources.
 * CSP separates sources with spaces, but a comma-separated list (the usual
 * shape for env lists) used to be pasted verbatim, giving browsers an invalid
 * directive that silently blocks every framing page. Commas and any
 * whitespace now separate sources, bare keywords gain their quotes, and
 * anything that is not a source (a path, a `;`) is dropped with a warning
 * rather than injected into the header.
 */
export function parseFrameAncestors(value, { warn = console.warn } = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '*') return { anywhere: true, sources: [] };
  // A `;` would end the directive and start another one: refuse the whole value.
  if (raw.includes(';')) {
    if (raw) warn('GEV_EMBED_FRAME_ANCESTORS: contains ";"; keeping the default framing protection');
    return { anywhere: false, sources: [] };
  }
  const tokens = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const sources = [];
  for (const token of tokens) {
    const keyword = /^'?(self|none)'?$/i.exec(token);
    const source = keyword ? `'${keyword[1].toLowerCase()}'` : token.replace(/\/$/, '');
    if (token === '*') {
      warn('GEV_EMBED_FRAME_ANCESTORS: "*" must be the whole value to allow any page; ignoring it here');
    } else if (KEYWORDS.has(source) || SCHEME_SOURCE.test(source) || HOST_SOURCE.test(token)) {
      if (!sources.includes(source)) sources.push(source);
    } else {
      warn(`GEV_EMBED_FRAME_ANCESTORS: ignoring "${token}", which is not a CSP source`);
    }
  }
  // 'none' combined with other sources is ignored by browsers; keep the intent explicit.
  if (sources.includes("'none'") && sources.length > 1) {
    warn(`GEV_EMBED_FRAME_ANCESTORS: 'none' cannot be combined with other sources; using 'none'`);
    return { anywhere: false, sources: ["'none'"] };
  }
  return { anywhere: false, sources };
}

/** Vite plugin applying the embed framing policy on dev and preview servers. */
export function embedFramingPlugin({
  ancestors = process.env.GEV_EMBED_FRAME_ANCESTORS || '',
  warn,
} = {}) {
  const { anywhere, sources } = parseFrameAncestors(ancestors, { warn });
  // Unset, or nothing valid: embed documents keep the server's framing protection.
  if (!anywhere && !sources.length) return { name: 'embed-framing' };
  const policy = `frame-ancestors ${sources.join(' ')}`;
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
