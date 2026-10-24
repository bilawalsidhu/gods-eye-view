import { createServer } from 'node:http';
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createChatGptStore } from './store.js';
import {
  AUTH_ORIGIN,
  RESOURCE,
  TOKEN_URL,
  ChatGptError,
  chatGptJson,
} from './http.js';

const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';
const random = () => randomBytes(32).toString('base64url');
const clearTokens = (account) => {
  delete account.tokens;
};

function equalState(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Local GEV sign-in, independent of Codex/Realtime and of API-key billing. */
export function createChatGptAuth({
  store = createChatGptStore({
    directory: process.env.GEV_CHATGPT_AUTH_DIR || undefined,
  }),
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  loginTimeoutMs = 10 * 60_000,
} = {}) {
  const jwks = createRemoteJWKSet(
    new URL(`${AUTH_ORIGIN}/.well-known/jwks.json`),
    {
      [customFetch]: async (url, init) => {
        const data = await chatGptJson(url, { ...init, fetchImpl });
        return Response.json(data);
      },
    },
  );
  let pending = null;
  let exchanging = false;
  let starting = false;
  let lastError = null;
  let epoch = 0;
  let requests = new AbortController();

  function invalidate() {
    epoch += 1;
    requests.abort();
    requests = new AbortController();
  }

  function closeAttempt() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending = null;
  }

  async function verifyIdentity(token, clientId, nonce, subject) {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: AUTH_ORIGIN,
      audience: clientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
      currentDate: new Date(now()),
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (subject && payload.sub !== subject) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    )
      throw new ChatGptError('ChatGPT account validation failed.', 401);
    return payload;
  }

  function tokenSet(data, previous) {
    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/\s+/)
        : previous?.scopes || [];
    if (
      data.token_type?.toLowerCase() !== 'bearer' ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      !scopes.includes(DIRECT_SCOPE) ||
      !scopes.includes('resource.invoke')
    )
      throw new ChatGptError(
        'ChatGPT plan permission was not granted. Sign in and enable plan usage.',
        403,
      );
    const refreshToken = data.refresh_token || previous?.refresh_token;
    if (typeof refreshToken !== 'string' || !refreshToken)
      throw new ChatGptError('ChatGPT did not grant a renewable session.', 403);
    return {
      access_token: data.access_token,
      refresh_token: refreshToken,
      id_token: data.id_token || previous?.id_token,
      scopes,
      expiresAt: now() + data.expires_in * 1000,
    };
  }

  async function tokenRequest(parameters) {
    return chatGptJson(TOKEN_URL, {
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, resource: RESOURCE }),
    });
  }

  function status() {
    const data = store.read();
    const active = data?.accounts.find((a) => a.id === data.active);
    return {
      configured: Boolean(active?.tokens),
      active: active?.id || null,
      binding: data?.binding || null,
      pending: Boolean(pending || exchanging || starting),
      error: lastError,
      accounts: (data?.accounts || []).map((a) => ({
        id: a.id,
        label: `${a.email || 'ChatGPT'} · ${a.id.slice(0, 8)}`,
        signedIn: Boolean(a.tokens),
      })),
    };
  }

  async function start(accountId = null) {
    if (pending || exchanging || starting)
      throw new ChatGptError('A ChatGPT sign-in is already in progress.', 409);
    starting = true;
    const startEpoch = epoch;
    try {
      lastError = null;
      // Persist the stable host identity before opening a browser.
      const prepared = await store.transaction((data) => {
        const account = accountId
          ? data.accounts.find((a) => a.id === accountId)
          : null;
        if (accountId && !account)
          throw new ChatGptError('Unknown ChatGPT account.', 400);
        return {
          hostId: data.hostId,
          account: account && structuredClone(account),
        };
      });
      // A concurrent start may have awaited the same storage lock.
      if (pending || exchanging)
        throw new ChatGptError(
          'A ChatGPT sign-in is already in progress.',
          409,
        );
      const attempt = {
        ...prepared,
        state: random(),
        nonce: random(),
        verifier: random(),
        ticket: random(),
        epoch: startEpoch,
        used: false,
      };
      const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        let url;
        try {
          url = new URL(req.url, attempt.redirectUri);
        } catch {
          res.statusCode = 400;
          res.end('Invalid sign-in callback.');
          return;
        }
        if (
          req.method !== 'GET' ||
          req.headers.host !== new URL(attempt.redirectUri).host ||
          url.pathname !== CALLBACK_PATH ||
          url.origin !== new URL(attempt.redirectUri).origin ||
          pending !== attempt ||
          attempt.used ||
          url.searchParams.getAll('state').length !== 1 ||
          !equalState(url.searchParams.get('state'), attempt.state)
        ) {
          res.statusCode = 400;
          res.end('Invalid sign-in callback. Return to GEV COMMAND.');
          return;
        }
        attempt.used = true;
        exchanging = true;
        closeAttempt();
        let abandonedSession = null;
        try {
          if (url.searchParams.has('error'))
            throw new ChatGptError('ChatGPT sign-in was declined.', 403);
          const issued =
            url.searchParams.get('client_id') || attempt.account?.clientId;
          const code = url.searchParams.get('code');
          if (
            !issued ||
            issued === 'dynamic_agent_client' ||
            issued.length > 256 ||
            !/^[\w-]+$/.test(issued) ||
            !code ||
            url.searchParams.getAll('code').length !== 1 ||
            url.searchParams.getAll('client_id').length > 1 ||
            code.length > 8192 ||
            (attempt.account && issued !== attempt.account.clientId)
          )
            throw new ChatGptError(
              'Incomplete or mismatched ChatGPT registration.',
              400,
            );
          // Keep the issued registration even if exchange fails (invalid_grant).
          const account = await store.transaction((data) => {
            let record =
              attempt.account &&
              data.accounts.find((a) => a.id === attempt.account.id);
            if (!record) {
              record = data.accounts.find((a) => a.clientId === issued);
              if (!record) {
                record = { id: randomUUID(), clientId: issued };
                data.accounts.push(record);
              }
            }
            return structuredClone(record);
          });
          const reply = await tokenRequest({
            grant_type: 'authorization_code',
            client_id: issued,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirectUri,
          });
          if (reply.refresh_token)
            abandonedSession = { clientId: issued, token: reply.refresh_token };
          const identity = await verifyIdentity(
            reply.id_token,
            issued,
            attempt.nonce,
            account.subject,
          );
          const tokens = tokenSet(reply);
          await store.transaction((data) => {
            if (attempt.epoch !== epoch)
              throw new ChatGptError('ChatGPT sign-in was cancelled.', 409);
            const record = data.accounts.find((a) => a.id === account.id);
            Object.assign(record, {
              subject: identity.sub,
              email: identity.email || null,
              tokens,
            });
            data.active = account.id;
            data.binding = randomUUID();
          });
          abandonedSession = null;
          invalidate();
          res.end(
            'ChatGPT is connected. Close this tab and return to GEV COMMAND.',
          );
        } catch (error) {
          lastError =
            error instanceof ChatGptError
              ? error.message
              : 'ChatGPT account validation failed. Try signing in again.';
          res.statusCode = 400;
          res.end(lastError);
        } finally {
          if (
            abandonedSession &&
            !(await revoke(abandonedSession.token, abandonedSession.clientId))
          ) {
            lastError =
              'Sign-in was not saved. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.';
          }
          exchanging = false;
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      if (startEpoch !== epoch) {
        server.close();
        throw new ChatGptError('ChatGPT sign-in was cancelled.', 409);
      }
      attempt.server = server;
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
      const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`);
      const params = {
        client_id: attempt.account?.clientId || 'dynamic_agent_client',
        ext_agent_host_id: attempt.hostId,
        response_type: 'code',
        redirect_uri: attempt.redirectUri,
        scope:
          'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        resource: RESOURCE,
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256')
          .update(attempt.verifier)
          .digest('base64url'),
      };
      if (!attempt.account) params.agent_name_hint = "God's Eye View";
      // The URL is only delivered via a 302 to the system browser, never JSON.
      if (attempt.account?.tokens?.id_token)
        params.id_token_hint = attempt.account.tokens.id_token;
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
      attempt.authorizationUrl = url.href;
      attempt.timer = setTimeout(() => {
        if (pending !== attempt) return;
        closeAttempt();
        lastError = 'ChatGPT sign-in timed out. Try again.';
      }, loginTimeoutMs);
      attempt.timer.unref?.();
      pending = attempt;
      return { path: `/api/agent/chatgpt/authorize?ticket=${attempt.ticket}` };
    } finally {
      starting = false;
    }
  }

  function authorize(ticket) {
    if (!pending || !equalState(ticket, pending.ticket))
      throw new ChatGptError('Expired sign-in link.', 400);
    const url = pending.authorizationUrl;
    pending.ticket = random();
    return url;
  }

  async function select(id) {
    if (pending || exchanging || starting)
      throw new ChatGptError('Finish or cancel ChatGPT sign-in first.', 409);
    await store.transaction((data) => {
      if (!data.accounts.find((a) => a.id === id)?.tokens)
        throw new ChatGptError('Sign in to this ChatGPT account first.', 401);
      data.active = id;
      data.binding = randomUUID();
    });
    invalidate();
    return status();
  }

  function assertBinding(binding) {
    if (!binding || store.read()?.binding !== binding)
      throw new ChatGptError(
        'ChatGPT account changed. Reload models and start a new conversation.',
        409,
      );
  }

  async function lease(binding) {
    assertBinding(binding);
    const signal = requests.signal;
    const result = await store.transaction(async (data) => {
      if (data.binding !== binding)
        throw new ChatGptError('ChatGPT account changed.', 409);
      const account = data.accounts.find((a) => a.id === data.active);
      if (!account?.tokens)
        throw new ChatGptError(
          'Continue with ChatGPT before sending commands.',
          401,
        );
      if (account.tokens.expiresAt <= now() + 60_000) {
        try {
          const reply = await tokenRequest({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: account.tokens.refresh_token,
          });
          try {
            if (reply.id_token)
              await verifyIdentity(
                reply.id_token,
                account.clientId,
                undefined,
                account.subject,
              );
            account.tokens = tokenSet(reply, account.tokens);
          } catch {
            clearTokens(account);
            return {
              error: new ChatGptError(
                'ChatGPT renewal could not be validated. Sign in again.',
                401,
              ),
            };
          }
        } catch (error) {
          if (error.code === 'invalid_grant') clearTokens(account);
          return { error };
        }
      }
      return { token: account.tokens.access_token, signal };
    });
    if (result.error) throw result.error;
    assertBinding(binding);
    signal.throwIfAborted();
    return result;
  }

  async function revoke(token, clientId) {
    try {
      const discovery = await chatGptJson(
        `${AUTH_ORIGIN}/.well-known/openid-configuration`,
        { fetchImpl },
      );
      const endpoint = new URL(discovery.revocation_endpoint);
      if (
        discovery.issuer !== AUTH_ORIGIN ||
        endpoint.origin !== AUTH_ORIGIN ||
        endpoint.username ||
        endpoint.password
      )
        return false;
      const response = await fetchImpl(endpoint.href, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }),
      });
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async function logout() {
    invalidate();
    closeAttempt();
    let revoked = true;
    await store.transaction(async (data) => {
      const account = data.accounts.find((a) => a.id === data.active);
      if (account?.tokens) {
        revoked = await revoke(account.tokens.refresh_token, account.clientId);
        clearTokens(account);
      }
      data.active = null;
      data.binding = randomUUID();
    });
    lastError = null;
    return { ...status(), revoked };
  }

  return {
    status,
    start,
    authorize,
    select,
    lease,
    assertBinding,
    logout,
    close() {
      invalidate();
      closeAttempt();
    },
  };
}
