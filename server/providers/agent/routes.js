import {
  buildRequestMessages,
  toolResultMessage,
} from '../../../src/agent/conversation.js';
import { estimateCommandCostUsd } from '../../../src/agent/cost.js';
import { readRequestBody } from '../common/request.js';
import { enforceRateLimit } from '../openai/rate-limit.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { diagnoseToolTurn } from './diagnostics.js';
import { buildAgentInstructions } from './instructions.js';
import { agentPromptPrefixTokens } from './prefix.js';
import { agentRateLimiter } from './rate-limit.js';
import {
  MIN_TOOL_CONTEXT_TOKENS,
  describeProviders,
  gateModels,
  isProviderConfigured,
  modelAllowList,
  providerApiKey,
  providerBaseUrl,
  resolveConfiguredModel,
  resolveConfiguredProvider,
  resolveProvider,
  resolveRequestedModel,
  sortModelsForPicker,
} from './registry.js';
import {
  indexToolsByName,
  prepareToolCall,
  toChatCompletionTools,
} from './toolSchema.js';
import { fetchModels, requestChatCompletion } from './upstream.js';

/**
 * The typed agent's three endpoints.
 *
 * The browser owns the transcript and executes the tools, because the tools
 * drive its own Cesium viewer. This server owns the credentials, the operating
 * manual, the tool schemas and which model may run, so the client never sees a
 * key and cannot substitute its own instructions.
 *
 * The malformed-tool-call correction loop also lives here: Ollama's compatible
 * endpoint does not accept `tool_choice`, so a bad call cannot be prevented,
 * only caught and handed back. Running that loop server-side keeps the retry
 * off the browser round trip and out of the visible transcript.
 */

/**
 * Request body ceiling for one typed command: a long transcript plus its tool
 * results. The console trims its own history to stay inside this, so reaching
 * it means a single exchange is enormous rather than that a session got long.
 */
const AGENT_REQUEST_MAX_BYTES = 512 * 1024;

/** Correction attempts allowed before a malformed call is surfaced. */
const MAX_TOOL_CORRECTIONS = 2;

/** Chat-shaped tool schemas and their index, derived once per process. */
let _chatTools;
let _toolIndex;

function chatTools() {
  if (!_chatTools) _chatTools = toChatCompletionTools(GEV_REALTIME_TOOLS);
  return _chatTools;
}

function toolIndex() {
  if (!_toolIndex) _toolIndex = indexToolsByName(GEV_REALTIME_TOOLS);
  return _toolIndex;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  sendJson(res, 405, { error: 'Method not allowed' });
  return false;
}

/** The `provider` querystring value, or null when the URL is unreadable. */
function requestedProviderId(req) {
  try {
    return new URL(req.url || '', 'http://localhost').searchParams.get(
      'provider',
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the provider a request names, answering the error itself.
 *
 * @returns {{provider: object, baseUrl: string, apiKey: string|null}|null}
 */
function resolveRequestProvider(requestedId, res, env) {
  const provider = requestedId
    ? resolveProvider(requestedId)
    : resolveConfiguredProvider(env);
  if (!provider) {
    sendJson(res, 400, {
      error: `Unknown provider "${String(requestedId).slice(0, 40)}"`,
    });
    return null;
  }
  if (!isProviderConfigured(provider, env)) {
    sendJson(res, 503, {
      error: `${provider.label} is not configured. Set ${provider.apiKeyEnv} to use it.`,
      provider: provider.id,
    });
    return null;
  }
  return {
    provider,
    baseUrl: providerBaseUrl(provider, env),
    apiKey: providerApiKey(provider, env),
  };
}

/**
 * GET /api/agent/config — providers, defaults and prefix size for the console.
 *
 * @param {{env?: Record<string,string|undefined>}} [options]
 */
function createAgentConfigHandler({ env = process.env } = {}) {
  return (req, res) => {
    if (!requireMethod(req, res, 'GET')) return;
    const configured = resolveConfiguredProvider(env);
    sendJson(res, 200, {
      providers: describeProviders(env),
      defaultProvider: configured.id,
      defaultModel: resolveConfiguredModel(configured, env),
      toolCount: GEV_REALTIME_TOOLS.length,
      promptPrefixTokens: agentPromptPrefixTokens(),
      minContextTokens: MIN_TOOL_CONTEXT_TOKENS,
    });
  };
}

/**
 * GET /api/agent/models — the capability-gated listing for one provider.
 *
 * @param {{env?: Record<string,string|undefined>, fetchImpl?: Function,
 *   limiter?: () => ((key: string) => boolean)|null}} [options]
 */
function createAgentModelsHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  limiter = agentRateLimiter,
} = {}) {
  return async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return;
    if (!enforceRateLimit(limiter(env), req, res)) return;

    const resolved = resolveRequestProvider(requestedProviderId(req), res, env);
    if (!resolved) return;

    const listing = await fetchModels({ ...resolved, fetchImpl });
    if (!listing.ok) {
      sendJson(res, 502, {
        error: listing.error,
        provider: resolved.provider.id,
        models: [],
      });
      return;
    }

    const prefixTokens = agentPromptPrefixTokens();
    const { usable, rejected } = gateModels(listing.models, {
      allowList: modelAllowList(resolved.provider, env),
    });
    sendJson(res, 200, {
      provider: resolved.provider.id,
      models: sortModelsForPicker(usable).map((model) => ({
        ...model,
        costPerCommandUsd: estimateCommandCostUsd(model, { prefixTokens }),
      })),
      rejected: rejected.map(({ model, reason }) => ({ id: model.id, reason })),
      defaultModel: resolveConfiguredModel(resolved.provider, env),
      promptPrefixTokens: prefixTokens,
    });
  };
}

/** Shape the tool calls one completion asked for, or the reason it cannot run. */
function prepareCalls(message) {
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return raw.map((call) => ({
    id: call.id,
    result: prepareToolCall(call.function, toolIndex()),
  }));
}

/**
 * POST /api/agent/command — one model turn, tool calls validated before return.
 *
 * @param {{env?: Record<string,string|undefined>, fetchImpl?: Function,
 *   limiter?: () => ((key: string) => boolean)|null,
 *   annotationGuidance?: string, maxBytes?: number}} [options]
 */
function createAgentCommandHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  limiter = agentRateLimiter,
  annotationGuidance,
  maxBytes = AGENT_REQUEST_MAX_BYTES,
} = {}) {
  return async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return;
    if (!enforceRateLimit(limiter(env), req, res)) return;

    let payload;
    try {
      payload = JSON.parse((await readRequestBody(req, maxBytes)) || '{}');
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE';
      sendJson(res, tooLarge ? 413 : 400, {
        error: tooLarge
          ? 'Command transcript is too large. Clear the console and retry.'
          : 'Malformed request body',
      });
      return;
    }

    const resolved = resolveRequestProvider(payload.provider, res, env);
    if (!resolved) return;

    // Server-side model policy: the console picks from a listing this server
    // produced, but a malformed, over-long or disallowed id degrades to the
    // configured default rather than reaching the upstream verbatim.
    const selection = resolveRequestedModel(
      payload.model,
      resolved.provider,
      env,
    );
    if (!selection.model) {
      sendJson(res, 400, {
        error: selection.fallback
          ? `That model is not available for ${resolved.provider.label}. Pick one from the list.`
          : `No model selected for ${resolved.provider.label}. Pick one, or set GEV_AGENT_MODEL.`,
        provider: resolved.provider.id,
      });
      return;
    }
    const model = selection.model;
    res.setHeader('X-GEV-Agent-Model', model);
    if (selection.fallback) res.setHeader('X-GEV-Agent-Model-Fallback', '1');

    const messages = buildRequestMessages({
      instructions: buildAgentInstructions({ annotationGuidance }),
      messages: payload.messages,
    });

    // Correction loop: a rejected tool call is answered with its own error so
    // the model can restate it, without that exchange reaching the browser.
    const corrections = [];
    for (let attempt = 0; attempt <= MAX_TOOL_CORRECTIONS; attempt += 1) {
      const completion = await requestChatCompletion({
        ...resolved,
        model,
        messages: [...messages, ...corrections],
        tools: chatTools(),
        fetchImpl,
      });

      if (!completion.ok) {
        sendJson(
          res,
          completion.status && completion.status < 500
            ? completion.status
            : 502,
          { error: completion.error, provider: resolved.provider.id },
        );
        return;
      }

      const prepared = prepareCalls(completion.message);
      const invalid = prepared.filter((entry) => !entry.result.ok);

      // Heuristic health checks on the FIRST turn only: a correction turn
      // legitimately carries a different shape and token count.
      const warnings = corrections.length
        ? []
        : diagnoseToolTurn({
            usage: completion.usage,
            message: completion.message,
            provider: resolved.provider,
            model: completion.model,
            toolCallCount: prepared.length,
            finishReason: completion.finishReason,
          });

      if (!invalid.length) {
        sendJson(res, 200, {
          provider: resolved.provider.id,
          model: completion.model,
          message: prepared.length
            ? completion.message
            : { role: 'assistant', content: completion.message.content || '' },
          toolCalls: prepared.map((entry) => ({
            id: entry.id,
            name: entry.result.name,
            args: entry.result.args,
          })),
          usage: completion.usage,
          corrections: attempt,
          modelFallback: selection.fallback,
          warnings,
        });
        return;
      }

      if (attempt === MAX_TOOL_CORRECTIONS) {
        sendJson(res, 200, {
          provider: resolved.provider.id,
          model: completion.model,
          message: {
            role: 'assistant',
            content: `I could not form a valid command for that. ${invalid[0].result.error}`,
          },
          toolCalls: [],
          usage: completion.usage,
          corrections: attempt,
          modelFallback: selection.fallback,
          toolCallFailed: true,
          warnings,
        });
        return;
      }

      corrections.push(completion.message);
      for (const entry of prepared) {
        corrections.push(
          toolResultMessage(
            entry.id,
            entry.result.ok
              ? {
                  ok: false,
                  error:
                    'Not run: another tool call in the same turn was invalid. Reissue both.',
                }
              : { ok: false, error: entry.result.error },
          ),
        );
      }
    }
  };
}

export {
  AGENT_REQUEST_MAX_BYTES,
  MAX_TOOL_CORRECTIONS,
  createAgentCommandHandler,
  createAgentConfigHandler,
  createAgentModelsHandler,
};
