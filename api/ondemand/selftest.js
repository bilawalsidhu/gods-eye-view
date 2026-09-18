/**
 * api/ondemand/selftest.js — GET/HEAD /api/ondemand/selftest.
 *
 * THIS ROUTE IS INVISIBLE (404, never 401/403) UNLESS
 * `ONDEMAND_SELFTEST_TOKEN` IS CONFIGURED ON THE DEPLOYMENT AND THE CALLER
 * SENDS THE SAME VALUE BACK IN THE `x-selftest-token` REQUEST HEADER. This
 * is deliberate: an operational "run the real 10-step contract test
 * in-deployment" endpoint must not be discoverable or triggerable by an
 * unauthenticated caller, but it also must not leak *which* failure mode
 * (missing token vs wrong token vs route doesn't exist) an attacker hit --
 * so every gate failure collapses to the same 404 `{error:'not_found'}`.
 *
 * Runs server/ondemand/contract-steps.js#runContractSteps() in 'direct'
 * mode using this deployment's own configuration (via `./_config.js` ->
 * server/ondemand/config.js#getConfig(), imported lazily on first request
 * so this module never fails to load before that sibling exists) and
 * reports a redacted summary. Gate order (each short-circuits the rest):
 *   1. token gate            -> 404 {error:'not_found'}
 *   2. method gate           -> 405 {error:'method_not_allowed'} (GET/HEAD only)
 *   3. rate limit gate       -> 429 {error:'rate_limited', retryAfterSec}
 *   4. ONDEMAND_API_KEY unset -> 200 {ok:false, configured:false, ...}
 *   5. otherwise             -> 200 with the full step-by-step report
 *
 * Rate limiting (module-level, i.e. scoped to the single handler instance
 * this module hands out as its default export -- a warm Vercel function
 * instance only ever runs one such instance): a second authorised request
 * either while a run is still in flight, or within 60s of the previous
 * run's start, gets 429 instead of kicking off a second real contract-test
 * run against the upstream API.
 *
 * SECURITY: the response is never allowed to carry the api key, the
 * selftest token, request headers, or the raw session id (only its sha256
 * is returned, as `sessionIdHash`) -- see `redactDeep()`/`secretsMatch()`.
 * `Cache-Control: no-store` on every response (via sendJson()).
 */

import crypto from 'node:crypto';
import { runContractSteps } from '../../server/ondemand/contract-steps.js';
import { sendJson, methodNotAllowed } from '../../server/ondemand/http.js';

const RATE_LIMIT_WINDOW_MS = 60000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/** Constant-time comparison via sha256 digests: a digest is always a fixed
 * 32 bytes, so `timingSafeEqual` never throws for a length mismatch even
 * though the two raw secrets being compared may differ in length. */
function secretsMatch(a, b) {
  if (!a || !b) return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function utcDateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Recursively replace every occurrence of any of `secrets` (non-empty
 * strings) with '***' in every string found inside `value`. Applied to the
 * whole response body right before it is sent -- a defensive last line, on
 * top of contract-steps.js never itself logging/returning the key. */
function redactDeep(value, secrets) {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join('***');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, secrets);
    }
    return out;
  }
  return value;
}

function stepStatusOf(step) {
  if (step.skipped) return 'SKIP';
  return step.ok ? 'PASS' : 'FAIL';
}

/** Shape one contract-steps.js report step into the selftest response's
 * per-step shape (never forwards fields not on the documented contract). */
function publicStep(step) {
  const out = {
    step: step.step,
    name: step.name,
    status: stepStatusOf(step),
    httpStatus: step.httpStatus,
    latencyMs: step.latencyMs,
    ttfdMs: step.timeToFirstDeltaMs ?? null,
    utc: step.utc,
  };
  if (step.skipReason) out.skipReason = step.skipReason;
  if (step.detail) out.detail = step.detail;
  if (step.error) out.error = step.error;
  return out;
}

/**
 * @param {object} [deps]
 * @param {() => object} [deps.getConfig] server/ondemand/config.js#getConfig
 *   (via api/ondemand/_config.js); lazily imported on first request when
 *   omitted (the production default export's case).
 * @param {typeof runContractSteps} [deps.runSteps]
 * @param {() => number} [deps.now]
 */
export function createSelftestHandler({
  getConfig,
  runSteps = runContractSteps,
  now = Date.now,
} = {}) {
  let resolvedGetConfig = getConfig || null;
  let lastRunStartedAt = -Infinity;
  let inFlight = false;

  return async function selftestHandler(req, res) {
    // 1. Token gate -- collapses every failure mode to 404, never 401/403.
    const configuredToken = process.env.ONDEMAND_SELFTEST_TOKEN || '';
    const providedToken = req.headers?.['x-selftest-token'];
    if (
      !configuredToken ||
      !providedToken ||
      !secretsMatch(configuredToken, providedToken)
    ) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    // 2. Method gate.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, ['GET']);
      return;
    }

    // 3. Rate limit gate.
    const startedAt = now();
    if (inFlight || startedAt - lastRunStartedAt < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSec = inFlight
        ? Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
        : Math.max(
            1,
            Math.ceil(
              (RATE_LIMIT_WINDOW_MS - (startedAt - lastRunStartedAt)) / 1000,
            ),
          );
      res.setHeader('Retry-After', String(retryAfterSec));
      sendJson(res, 429, { error: 'rate_limited', retryAfterSec });
      return;
    }

    if (!resolvedGetConfig) {
      ({ getConfig: resolvedGetConfig } = await import('./_config.js'));
    }
    const cfg = resolvedGetConfig() || {};
    const apiKey = cfg.apiKey || '';
    const secrets = [apiKey, configuredToken];

    // 4. Not configured -- always 200, no upstream call.
    if (!apiKey) {
      sendJson(
        res,
        200,
        redactDeep(
          {
            ok: false,
            configured: false,
            message:
              'ONDEMAND_API_KEY is not configured on this deployment; no upstream call was made',
            steps: [],
          },
          secrets,
        ),
      );
      return;
    }

    // 5. Run the real 10-step contract test against this deployment's own
    // configuration.
    lastRunStartedAt = startedAt;
    inFlight = true;
    try {
      const fulfillmentEndpointId = cfg.fulfillmentEndpointId || '';
      const report = await runSteps({
        mode: 'direct',
        apiKey,
        baseUrl: cfg.baseUrl,
        fulfillmentEndpointId,
        pluginIds: cfg.defaultPluginIds || [],
        flowId: cfg.spatialFlowId || '',
        externalUserId: `ondemand-spatial-selftest-${utcDateStamp()}`,
      });

      const sessionIdHash = report.sessionId
        ? crypto
            .createHash('sha256')
            .update(report.sessionId, 'utf8')
            .digest('hex')
        : null;

      const body = {
        ok: report.summary.failed === 0,
        configured: true,
        generatedAtUtc: report.generatedAtUtc,
        mode: 'direct',
        sessionIdHash,
        fulfillmentEndpointId,
        steps: report.steps.map(publicStep),
        summary: report.summary,
        durationMs: now() - startedAt,
      };
      // The raw session id must never reach the client (only its hash,
      // above) -- a step's `detail` string (e.g. step 1's "sessionId=...")
      // can otherwise carry it verbatim, so it is scrubbed here too.
      sendJson(res, 200, redactDeep(body, [...secrets, report.sessionId]));
    } catch (err) {
      sendJson(
        res,
        200,
        redactDeep(
          {
            ok: false,
            configured: true,
            message: `contract test run failed unexpectedly: ${err?.message || String(err)}`,
            steps: [],
          },
          secrets,
        ),
      );
    } finally {
      inFlight = false;
    }
  };
}

export default createSelftestHandler();
