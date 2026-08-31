/**
 * Key setup ("POWER UP") — the pure core.
 *
 * One registry, three pure functions, zero dependencies. The dev server's
 * /api/setup endpoints (vite.config.js) and the in-app panel (keySetup.js)
 * are both thin shells over this module, so what a key is called, what it
 * unlocks, and how a .env line is written each live in exactly one place.
 *
 * Nothing here touches the filesystem, the network, or process.env — callers
 * pass environments in and write text out, which is also what makes every
 * behavior below unit-testable.
 */

/** Longest accepted key/token value. Real provider keys are all far shorter. */
export const KEY_SETUP_VALUE_LIMIT = 512;

/** Most env vars accepted in one save. The registry defines nine. */
export const KEY_SETUP_UPDATE_LIMIT = 16;

/** Header line written above keys the panel appends to a .env file. */
export const KEY_SETUP_APPEND_HEADER = '# Keys added by the in-app POWER UP panel';

/**
 * Every key the panel offers, in the order it offers them — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key.
 * `clientExposed` marks the two keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet + place search',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher space-missions request allowance',
    getUrl: 'https://thespacedevs.com',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'free',
  }),
]);

/** Hostnames a Provider Settings request may arrive under or originate from. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Socket addresses that count as this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Parse an exact local request authority from a Host header. */
function localAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw)) return null;
  try {
    const parsed = new URL(`${scheme}//${raw}`);
    return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase()) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** True only for a subprocess that exited normally and successfully. */
export function commandCompletedSuccessfully(result) {
  return !!result && !result.error && !result.signal && result.status === 0;
}

/** Parse one RFC-4180-shaped CSV record, sufficient for `whoami /fo csv`. */
function parseCsvRecord(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!source || /[\r\n]/.test(source)) return null;
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * Extract the current token's user SID from `whoami /user /fo csv /nh`.
 * The SID must be the second CSV field and a user-shaped local/domain or Entra
 * SID; matching an SID-looking account name or a broad group SID is forbidden.
 */
export function parseWindowsUserSid(stdout) {
  const fields = parseCsvRecord(stdout);
  if (!fields || fields.length !== 2) return null;
  const sid = fields[1].trim();
  return /^(?:S-1-5-21-(?:\d+-){3}\d+|S-1-12-1-(?:\d+-){3}\d+)$/i.test(sid)
    ? sid
    : null;
}

/**
 * The admission gate for the Provider Settings endpoints — pure, exported so
 * every refusal below is pinned by a unit assertion rather than a review note.
 *
 * Why each check exists:
 *  - sharing signals: any tunnel/LAN sharing mode disables the surface
 *    outright — a credential-writing endpoint has no business existing on a
 *    shared instance, and tunnel traffic reaches the server FROM loopback, so
 *    the socket check below cannot carry that boundary alone;
 *  - loopback socket: refuses LAN peers when the server is bound wide;
 *  - local Host header: tunnel and DNS-rebinding traffic carries a foreign
 *    Host even when the socket says loopback;
 *  - exact same Origin on POST: a hostile web page can make a browser POST to
 *    localhost, and a non-browser caller must not bypass that boundary merely
 *    by omitting the header;
 *  - JSON Content-Type on POST: forces cross-origin browsers into a CORS
 *    preflight this server never answers, closing the simple-request CSRF
 *    write primitive.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function admitKeySetupRequest({
  method,
  remoteAddress,
  hostHeader,
  protocol = 'http:',
  origin,
  contentType,
  proxyHeaders = {},
  env = {},
} = {}) {
  // A request carrying reverse-proxy / CDN forwarding headers did not originate
  // on this machine, whatever its socket says. Refuse them outright as defense
  // in depth — the shipped tunnel (Pinokio) is force-closed at boot, so these
  // only appear when someone has deliberately fronted the dev server.
  const PROXY_SIGNALS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];
  if (PROXY_SIGNALS.some((name) => String(proxyHeaders[name] || '').trim() !== '')) {
    return { ok: false, status: 403, error: 'Provider Settings does not answer proxied requests' };
  }
  // Every sharing signal the launcher recognizes (scripts/pinokio-preflight.mjs)
  // also disables this surface — so the gate's set is complete, not a subset the
  // two files could drift apart on. One DELIBERATE divergence: preflight is a
  // boot check that treats an empty PINOKIO_SHARE_VAR as sharing-on (fail closed
  // before Start), but here an empty/unset value is the NORMAL git-clone and
  // Pinokio state — treating it as sharing would disable Provider Settings for
  // every ordinary launch. So a bare/sentinel value is not sharing; only a real
  // tunnel var is. This is defense in depth regardless: the loopback+Host checks
  // below independently refuse LAN/tunnel traffic, and under Pinokio the launcher
  // refuses to boot at all when sharing is genuinely on.
  const shareVar = String(env.PINOKIO_SHARE_VAR ?? '').trim();
  const sharingEnabled = ['PINOKIO_SHARE_CLOUDFLARE', 'PINOKIO_SHARE_LOCAL']
    .some((name) => /^(1|true)$/i.test(String(env[name] || '').trim()))
    || (shareVar !== '' && shareVar !== '__gev_sharing_disabled__');
  if (sharingEnabled) {
    return { ok: false, status: 403, error: 'Provider Settings is disabled while sharing is enabled' };
  }
  if (!LOOPBACK_ADDRESSES.has(String(remoteAddress || ''))) {
    return { ok: false, status: 403, error: 'Provider Settings answers only the machine running the server' };
  }
  const authority = localAuthority(hostHeader, protocol);
  if (!authority) {
    return { ok: false, status: 403, error: 'Provider Settings answers only local hostnames' };
  }
  if (method === 'POST' && (origin === undefined || origin === null || origin === '')) {
    return { ok: false, status: 403, error: 'Provider Settings requires an exact local Origin' };
  }
  if (origin !== undefined && origin !== null && origin !== '') {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin = parsedOrigin.username === ''
      && parsedOrigin.password === ''
      && parsedOrigin.pathname === '/'
      && parsedOrigin.search === ''
      && parsedOrigin.hash === ''
      && parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return { ok: false, status: 403, error: 'Cross-origin requests are refused' };
    }
  }
  if (method === 'POST' && !String(contentType || '').toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' };
  }
  return { ok: true };
}

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
  }
  return names;
}

/**
 * Decide whether a live provider value belongs to a source outside the store
 * Provider Settings is allowed to edit. `wasExternalAtBoot` carries source
 * provenance without carrying the credential itself; it closes the otherwise
 * undecidable case where an exported value and a dotenv assignment happen to
 * contain the same bytes.
 * @param {{effectiveValue: unknown, storedValue: unknown, wasExternalAtBoot?: boolean}} input
 */
export function isKeySetupExternallyManaged({
  effectiveValue,
  storedValue,
  wasExternalAtBoot = false,
} = {}) {
  const effective = String(effectiveValue ?? '').trim();
  const stored = String(storedValue ?? '').trim();
  return effective !== '' && (wasExternalAtBoot || effective !== stored);
}

/**
 * Build the status payload the panel renders from: the registry, plus
 * per-entry `set` resolved against the given environment. It never includes
 * a value, suffix, or other credential material.
 * @param {Record<string, string|undefined>} env e.g. process.env
 */
export function keySetupStatus(env = {}) {
  const keys = KEY_SETUP_KEYS.map((entry) => {
    const values = entry.envVars.map((name) => String(env[name] ?? '').trim());
    const set = values.every((value) => value.length > 0);
    return {
      id: entry.id,
      title: entry.title,
      unlocks: entry.unlocks,
      getUrl: entry.getUrl,
      envVars: [...entry.envVars],
      tier: entry.tier,
      clientExposed: Boolean(entry.clientExposed),
      set,
    };
  });
  return {
    keys,
    setCount: keys.filter((key) => key.set).length,
    total: keys.length,
  };
}

/**
 * Validate a POST body into a clean {ENV_VAR: value} map, or say exactly why
 * not. Values must be single-line printable ASCII with no spaces — every real
 * provider credential is — which is also what makes the raw `KEY=value` line
 * below safe to write without quoting rules. A `null` value means REMOVE:
 * the writer comments the assignment back out, returning the file to its
 * template state for that key.
 * @param {unknown} body Parsed JSON from the request.
 */
export function validateKeySetupUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object of {ENV_VAR: value}' };
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return { ok: false, error: 'No keys provided' };
  if (entries.length > KEY_SETUP_UPDATE_LIMIT) {
    return { ok: false, error: `At most ${KEY_SETUP_UPDATE_LIMIT} keys per save` };
  }
  const known = knownKeySetupEnvVars();
  const updates = {};
  for (const [name, raw] of entries) {
    if (!known.has(name)) return { ok: false, error: `Unknown key: ${name}` };
    if (raw === null) {
      updates[name] = null;
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, error: `${name} must be a string` };
    const value = raw.trim();
    if (!value) return { ok: false, error: `${name} is empty` };
    if (value.length > KEY_SETUP_VALUE_LIMIT) {
      return { ok: false, error: `${name} is longer than any real key (${KEY_SETUP_VALUE_LIMIT} max)` };
    }
    if (!/^[\x21-\x7e]+$/.test(value)) {
      return { ok: false, error: `${name} may only contain printable characters with no spaces` };
    }
    // Reject the dotenv metacharacters that would round-trip WRONG when written
    // unquoted (# starts a comment, quotes redelimit, $ expands, backslash and
    // backtick are escapes) — so a saved value can never differ from what Node's
    // parseEnv and Vite's expansion read back. Real provider keys never contain
    // these; they are base64url / hex / JWT alphabets.
    if (/[#"'$\\`]/.test(value)) {
      return { ok: false, error: `${name} contains a character that is not valid in a key (#, quotes, $, \\, or backtick)` };
    }
    updates[name] = value;
  }
  return { ok: true, updates };
}

/**
 * Upsert `KEY=value` lines into dotenv text, disturbing nothing else.
 *
 * Placement, per key: the LAST active assignment is replaced in place (last
 * is what dotenv parsing lets win); failing that, the last commented-out
 * assignment is uncommented in place, so a file copied from .env.example
 * keeps its curated shape; failing both, the line is appended at the end
 * under one shared header. Every untouched line — comments, blanks, other
 * keys — survives byte for byte, and the result always ends in a newline.
 *
 * A `null` value REMOVES: every active assignment for that key is commented
 * back out (`# KEY=`), returning the file to its template shape; a key with
 * no active assignment is left untouched.
 * @param {string} text Existing file content ('' births a new file).
 * @param {Record<string, string|null>} updates Validated {ENV_VAR: value} map.
 */
export function upsertDotenvValues(text, updates) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.length ? source.split(/\r?\n/) : [];
  const additions = [];
  for (const [name, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*=`);
    if (value === null) {
      lines.forEach((line, index) => {
        if (active.test(line)) lines[index] = `# ${name}=`;
      });
      continue;
    }
    const assignment = `${name}=${value}`;
    let lastActive = -1;
    let lastCommented = -1;
    lines.forEach((line, index) => {
      if (active.test(line)) lastActive = index;
      else if (commented.test(line)) lastCommented = index;
    });
    if (lastActive >= 0) lines[lastActive] = assignment;
    else if (lastCommented >= 0) lines[lastCommented] = assignment;
    else additions.push(assignment);
  }
  if (additions.length) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.some((line) => line.trim() === KEY_SETUP_APPEND_HEADER)) {
      if (lines.length) lines.push('');
      lines.push(KEY_SETUP_APPEND_HEADER);
    }
    lines.push(...additions);
  }
  const joined = lines.join('\n');
  if (!joined) return '';
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}
