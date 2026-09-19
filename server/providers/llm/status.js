import {
  LLM_LOCAL_CAPABILITY_NOTE,
  LLM_VOICE_LIMITATION_NOTE,
  isProbeableLlmBaseUrl,
  llmProviderDescriptor,
  llmSettingsStatus,
  normalizeLlmBaseUrl,
  parseLlmModelList,
} from '../../../src/llmSettings.mjs';
import { readResponseJsonCapped } from '../common/http.js';
import {
  LLM_PROBE_TIMEOUT_MS,
  boundFetch,
  llmAuthHeaders,
  llmRequestedConfig,
  llmRuntimeConfig,
} from './config.js';

/** A model list is a few hundred short ids at most. */
const MODEL_LIST_BYTE_CAP = 512 * 1024;

/**
 * Ask a provider which models it has.
 *
 * Total by construction: every failure mode — refused connection, timeout,
 * HTTP error, junk body — resolves to `{reachable:false, error}` instead of
 * throwing. An LLM that is not running must never be able to break anything,
 * and this function is the chokepoint that guarantees it.
 *
 * @param {{config: object, fetchImpl?: Function, timeoutMs?: number}} input
 * @returns {Promise<{reachable: boolean, models: string[], endpoint: string, error: string|null}>}
 */
export async function probeLlmProvider({
  config,
  fetchImpl = boundFetch(),
  timeoutMs = LLM_PROBE_TIMEOUT_MS,
} = {}) {
  const endpoint = config?.modelsUrl || '';
  const result = { reachable: false, models: [], endpoint, error: null };
  if (!endpoint) {
    result.error = 'No usable base URL is configured';
    return result;
  }
  if (config.requiresKey && !config.apiKey) {
    result.error = 'OPENAI_API_KEY is not set';
    return result;
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', ...llmAuthHeaders(config) },
    });
    if (!response?.ok) {
      result.error = `${config.label} answered ${response?.status ?? '(no status)'}`;
      // A 4xx from a server that answered still proves something is listening;
      // say so, because "wrong path" and "nothing running" need different fixes.
      result.reachable = Number.isFinite(response?.status);
      return result;
    }
    const payload = await readResponseJsonCapped(response, MODEL_LIST_BYTE_CAP);
    result.reachable = true;
    result.models = parseLlmModelList(config.provider, payload);
    return result;
  } catch (error) {
    result.error =
      error?.name === 'TimeoutError'
        ? `No answer from ${endpoint} within ${Math.round(timeoutMs / 1000)}s`
        : error?.message || 'Could not reach the model server';
    return result;
  }
}

/**
 * Assemble the /api/llm/status payload for one config.
 * @param {{config: object, env?: Record<string, string|undefined>, fetchImpl?: Function, timeoutMs?: number}} input
 */
export async function llmStatusPayload({
  config,
  env = process.env,
  fetchImpl = boundFetch(),
  timeoutMs = LLM_PROBE_TIMEOUT_MS,
} = {}) {
  const probe = await probeLlmProvider({ config, fetchImpl, timeoutMs });
  return {
    ...llmSettingsStatus(env),
    // What was actually probed — which may be a not-yet-saved provider/base
    // URL the panel is testing, so the panel never mislabels its own result.
    probed: {
      provider: config.provider,
      label: config.label,
      baseUrl: config.baseUrl,
      model: config.model,
      endpoint: probe.endpoint,
    },
    reachable: probe.reachable,
    models: probe.models,
    error: probe.error,
    notes: [LLM_VOICE_LIMITATION_NOTE, LLM_LOCAL_CAPABILITY_NOTE],
  };
}

/**
 * Parse the optional ?provider= / ?baseUrl= overrides off a request URL.
 *
 * A caller-supplied base URL is a request-forgery primitive, so it is only
 * honored for addresses that can only mean "a server on this machine or LAN"
 * (see isProbeableLlmBaseUrl). Anything else is refused with a reason rather
 * than silently probed or silently ignored.
 * @param {string} url
 * @returns {{provider: string|undefined, baseUrl: string|undefined, refusal: string|null}}
 */
export function parseLlmStatusQuery(url) {
  let params;
  try {
    params = new URL(url || '', 'http://localhost').searchParams;
  } catch {
    return { provider: undefined, baseUrl: undefined, refusal: null };
  }
  const rawProvider = params.get('provider');
  const rawBaseUrl = params.get('baseUrl');
  if (rawProvider && !llmProviderDescriptor(rawProvider)) {
    return {
      provider: undefined,
      baseUrl: undefined,
      refusal: `Unknown provider: ${String(rawProvider).slice(0, 40)}`,
    };
  }
  if (rawBaseUrl && !isProbeableLlmBaseUrl(rawBaseUrl)) {
    return {
      provider: undefined,
      baseUrl: undefined,
      refusal: normalizeLlmBaseUrl(rawBaseUrl)
        ? 'Only a local or private-network base URL can be tested from here'
        : 'That base URL is not an http(s) address',
    };
  }
  return {
    provider: rawProvider || undefined,
    baseUrl: rawBaseUrl || undefined,
    refusal: null,
  };
}

/**
 * GET /api/llm/status — which text backend is configured, whether it answers,
 * and what models it has.
 *
 * Always 200 for an admitted GET, even when nothing is running: "the local
 * server is down" is a fact this endpoint reports, not an error it raises.
 * The `admit` gate is injected (the dev server passes Provider Settings'
 * loopback-only admission) so this surface can never be probed from the LAN.
 *
 * @param {{fetchImpl?: Function, admit?: (req: any) => {ok: boolean, status?: number, error?: string}, env?: Record<string,string|undefined>, timeoutMs?: number}} options
 */
export function createLlmStatusHandler({
  fetchImpl = boundFetch(),
  admit = () => ({ ok: true }),
  env = process.env,
  timeoutMs = LLM_PROBE_TIMEOUT_MS,
} = {}) {
  const respond = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(JSON.stringify(payload));
  };
  return async (req, res) => {
    if (req.method !== 'GET') {
      return respond(res, 405, { error: 'Method not allowed' });
    }
    const admission = admit(req);
    if (!admission.ok) {
      return respond(res, admission.status || 403, {
        error: admission.error || 'Refused',
      });
    }
    const query = parseLlmStatusQuery(req.url);
    if (query.refusal) {
      return respond(res, 400, { error: query.refusal });
    }
    try {
      const config =
        query.provider || query.baseUrl
          ? llmRequestedConfig({
              provider: query.provider,
              baseUrl: query.baseUrl,
              env,
            })
          : llmRuntimeConfig(env);
      respond(
        res,
        200,
        await llmStatusPayload({ config, env, fetchImpl, timeoutMs }),
      );
    } catch (error) {
      // Belt and braces: the probe is already total, so reaching here means a
      // bug in our own assembly — still never a 5xx storm on the globe.
      respond(res, 200, {
        ...llmSettingsStatus(env),
        reachable: false,
        models: [],
        error: error?.message || 'LLM status unavailable',
        notes: [LLM_VOICE_LIMITATION_NOTE, LLM_LOCAL_CAPABILITY_NOTE],
      });
    }
  };
}
