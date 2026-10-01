import crypto from 'node:crypto';

/**
 * Authentication for the hosted profile.
 *
 * Two ways in, both ending in the same signed session cookie:
 *   tokens    GEV_ACCESS_TOKENS="alice:longrandomtoken:admin,bob:othertoken"
 *   supabase  SUPABASE_URL (+ SUPABASE_JWT_SECRET for legacy HS256 projects;
 *             otherwise the project's JWKS is fetched for ES256/RS256)
 *
 * The session cookie is HMAC-SHA256 signed with GEV_SESSION_SECRET and
 * carries only {sub, name, admin, exp}. Nothing else about the user is kept.
 */

export const COOKIE = 'gev_session';
const SESSION_MAX_MS = 12 * 3_600_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

export function signSession(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifySession(cookie, secret, now = Date.now()) {
  if (typeof cookie !== 'string' || !cookie.includes('.')) return null;
  const [body, mac] = cookie.split('.', 2);
  const expect = b64u(
    crypto.createHmac('sha256', secret).update(body).digest(),
  );
  if (!timingSafeEqualStr(mac, expect)) return null;
  let p;
  try {
    p = JSON.parse(fromB64u(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!p || typeof p.sub !== 'string' || !(p.exp > now)) return null;
  return {
    id: p.sub,
    name: p.name || p.sub,
    admin: p.admin === true,
    exp: p.exp,
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(
  value,
  { secure = true, maxAgeMs = SESSION_MAX_MS } = {},
) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure = true) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Parse GEV_ACCESS_TOKENS into [{name, token, admin}]. Tokens must be >= 24 chars. */
export function parseAccessTokens(text) {
  const list = [];
  for (const raw of String(text || '').split(',')) {
    const [name, token, flag] = raw.trim().split(':');
    if (!name || !token) continue;
    if (token.length < 24)
      throw new Error(
        `access token for "${name}" must be at least 24 characters`,
      );
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name))
      throw new Error(`invalid access-token user name "${name}"`);
    list.push({ name, token, admin: flag === 'admin' });
  }
  return list;
}

export function checkAccessToken(list, token) {
  let hit = null;
  for (const entry of list)
    if (timingSafeEqualStr(entry.token, token)) hit = entry;
  return hit;
}

// ---------------------------------------------------------------- JWT

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(fromB64u(parts[0]).toString('utf8')),
      payload: JSON.parse(fromB64u(parts[1]).toString('utf8')),
      signed: `${parts[0]}.${parts[1]}`,
      signature: fromB64u(parts[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase access token.
 * @param {string} token JWT.
 * @param {{secret?: string, getKey?: (kid: string) => Promise<crypto.KeyObject|null>,
 *   issuer?: string, now?: number}} o
 * @returns {Promise<object|null>} Claims or null.
 */
export async function verifyJwt(
  token,
  { secret, getKey, issuer, now = Date.now() },
) {
  const jwt = decodeJwt(token);
  if (!jwt) return null;
  const { alg, kid } = jwt.header || {};
  let ok = false;
  if (alg === 'HS256' && secret) {
    const mac = crypto.createHmac('sha256', secret).update(jwt.signed).digest();
    ok =
      mac.length === jwt.signature.length &&
      crypto.timingSafeEqual(mac, jwt.signature);
  } else if ((alg === 'ES256' || alg === 'RS256') && getKey) {
    const key = await getKey(kid);
    if (!key) return null;
    ok = crypto.verify(
      'sha256',
      Buffer.from(jwt.signed),
      alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
      jwt.signature,
    );
  }
  if (!ok) return null;
  const p = jwt.payload;
  const sec = Math.floor(now / 1000);
  if (typeof p.exp !== 'number' || p.exp <= sec) return null;
  if (typeof p.nbf === 'number' && p.nbf > sec + 30) return null;
  if (issuer && p.iss !== issuer) return null;
  if (p.role && p.role !== 'authenticated') return null;
  if (typeof p.sub !== 'string' || !p.sub) return null;
  return p;
}

/** JWKS-backed key lookup with a 1 h cache. */
export function createJwks(url, { fetchImpl = fetch, now = Date.now } = {}) {
  let cache = { at: 0, keys: new Map() };
  return async function getKey(kid) {
    if (now() - cache.at > 3_600_000 || !cache.keys.has(kid)) {
      try {
        const res = await fetchImpl(url, { redirect: 'error' });
        if (res.ok) {
          const body = await res.json();
          const keys = new Map();
          for (const jwk of body?.keys || []) {
            try {
              keys.set(
                jwk.kid,
                crypto.createPublicKey({ key: jwk, format: 'jwk' }),
              );
            } catch {
              // unsupported key type
            }
          }
          cache = { at: now(), keys };
        }
      } catch {
        // keep the previous cache
      }
    }
    return cache.keys.get(kid) || null;
  };
}

/**
 * Build the authenticator from environment.
 * @returns {{mode: string, authenticate: (req) => object|null,
 *   login: (req, body) => Promise<object|null>, secure: boolean, page: object}}
 */
export function createAuth(env = process.env, { fetchImpl = fetch } = {}) {
  const secret = env.GEV_SESSION_SECRET || '';
  if (secret.length < 32)
    throw new Error('GEV_SESSION_SECRET must be set to at least 32 characters');
  const secure = env.GEV_COOKIE_SECURE !== '0';
  const admins = new Set(
    String(env.GEV_ADMIN_USERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const mode = env.GEV_AUTH_MODE;
  const allowed = new Set(
    String(env.GEV_ALLOWED_USERS || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );

  let login;
  let page;
  if (mode === 'tokens') {
    const tokens = parseAccessTokens(env.GEV_ACCESS_TOKENS);
    // A single owner token (what a host's "generate secret" button makes).
    if (env.GEV_ACCESS_TOKEN) {
      if (String(env.GEV_ACCESS_TOKEN).length < 24)
        throw new Error('GEV_ACCESS_TOKEN must be at least 24 characters');
      tokens.push({
        name: 'owner',
        token: String(env.GEV_ACCESS_TOKEN),
        admin: true,
      });
    }
    if (!tokens.length)
      throw new Error(
        'GEV_AUTH_MODE=tokens needs GEV_ACCESS_TOKEN or GEV_ACCESS_TOKENS',
      );
    login = async (_req, body) => {
      const hit = checkAccessToken(tokens, String(body?.token || ''));
      return hit
        ? {
            sub: `token:${hit.name}`,
            name: hit.name,
            admin: hit.admin || admins.has(hit.name.toLowerCase()),
          }
        : null;
    };
    page = { mode };
  } else if (mode === 'supabase') {
    const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base))
      throw new Error('GEV_AUTH_MODE=supabase needs SUPABASE_URL (https)');
    if (!env.SUPABASE_ANON_KEY)
      throw new Error(
        'GEV_AUTH_MODE=supabase needs SUPABASE_ANON_KEY (publishable key)',
      );
    const getKey = env.SUPABASE_JWT_SECRET
      ? undefined
      : createJwks(`${base}/auth/v1/.well-known/jwks.json`, { fetchImpl });
    login = async (_req, body) => {
      const claims = await verifyJwt(String(body?.access_token || ''), {
        secret: env.SUPABASE_JWT_SECRET,
        getKey,
        issuer: `${base}/auth/v1`,
      });
      if (!claims) return null;
      const email =
        typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
      if (
        allowed.size &&
        !allowed.has(email) &&
        !allowed.has(claims.sub.toLowerCase())
      )
        return { forbidden: true };
      return {
        sub: `sb:${claims.sub}`,
        name: email || claims.sub,
        admin:
          admins.has(claims.sub.toLowerCase()) || (email && admins.has(email)),
        exp: claims.exp * 1000,
      };
    };
    page = { mode, supabaseUrl: base, anonKey: env.SUPABASE_ANON_KEY };
  } else {
    throw new Error(
      'GEV_AUTH_MODE must be "tokens" or "supabase" in the hosted profile',
    );
  }

  return {
    mode,
    secure,
    page,
    authenticate(req) {
      const cookie = parseCookies(req.headers.cookie)[COOKIE];
      return cookie ? verifySession(cookie, secret) : null;
    },
    async login(req, body) {
      const who = await login(req, body);
      if (!who) return null;
      if (who.forbidden) return { forbidden: true };
      const exp = Math.min(Date.now() + SESSION_MAX_MS, who.exp || Infinity);
      const cookie = signSession(
        { sub: who.sub, name: who.name, admin: !!who.admin, exp },
        secret,
      );
      return {
        cookie: sessionCookie(cookie, { secure, maxAgeMs: exp - Date.now() }),
        user: who,
      };
    },
  };
}
