/**
 * server/ondemand/capability-loop.js — the interim "OnDemand decides, the
 * gateway executes" loop that REPLACES the run-B context-injection pattern
 * (where the gateway pre-fetched provider data and pasted it into the
 * prompt). Labelled INTERIM in docs/ONDEMAND_PROXY_DESIGN.md: agent-tool
 * registration is dashboard-only (docs/ONDEMAND_API_CURRENT.md §8) and the
 * deployment has no stable public URL yet, so OnDemand cannot call the
 * /api/sources/* adapters itself; until it can, the platform is asked to
 * DECIDE which capabilities to run and the gateway runs only those.
 *
 * Contract (documented OnDemand surfaces only — §2.1 create session,
 * §3.1/§3.2 submit query in `sync` mode with `endpointId`, `pluginIds`,
 * `modelConfigs.fulfillmentPrompt`):
 *
 *   1. buildCatalogue(registry) — src/registry/capabilities.json rows that
 *      have an adapter and whose status is not PENDING / rendering-only.
 *   2. decision turn — POST …/query (sync) with the catalogue + the user
 *      query + the fresh spatial context (viewport bbox, UTC now). The
 *      answer MUST be one JSON object {"decisions":[{"capabilityId",
 *      "params"}]}; validateDecision() rejects anything else: a
 *      capabilityId outside the catalogue (hallucinated), a param outside
 *      that capability's whitelist, more than `maxDecisions` entries.
 *   3. execution — ONLY the validated decisions are executed through the
 *      adapters map (server/sources/index.js). Nothing is pre-fetched.
 *   4. tool-result turn — the adapter results (data + provenance) are sent
 *      back into the SAME session as the next query, and
 *   5. the answer is validated against the 7-key StructuredResponse
 *      contract (server/ondemand/workflow-definition.js).
 *
 * Pure w.r.t. process.env: every dependency (registry, adapters, upstream
 * client, endpoint ids, clock) is injected; api/ondemand/chat.js and
 * scripts/ondemand-capability-loop.mjs supply the production values. The
 * api key never enters this module — `ondemandFetch` adds it.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  validateStructuredResponse,
  STRUCTURED_RESPONSE_KEYS,
} from './workflow-definition.js';

export const EXCLUDED_STATUSES = Object.freeze(['PENDING', 'rendering-only']);
export const DEFAULT_MAX_DECISIONS = 4;

/** Load src/registry/capabilities.json (the only registry this loop reads). */
export async function loadRegistry(
  url = new URL('../../src/registry/capabilities.json', import.meta.url),
) {
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * Catalogue = registry rows that can actually be executed: they name an
 * adapter file and their status is not PENDING / rendering-only. Each entry
 * is reduced to what the decision prompt needs (id, description, params,
 * route, provider, coverage) — never internal notes.
 */
export function buildCatalogue(registry) {
  const rows = Array.isArray(registry?.capabilities)
    ? registry.capabilities
    : [];
  return rows
    .filter(
      (row) =>
        row &&
        typeof row.id === 'string' &&
        typeof row.adapter === 'string' &&
        row.adapter.length > 0 &&
        !EXCLUDED_STATUSES.includes(String(row.status)),
    )
    .map((row) => ({
      id: row.id,
      provider: row.provider ?? null,
      route: row.route ?? null,
      description: row.description ?? row.notes ?? '',
      params: Array.isArray(row.params) ? [...row.params] : [],
      required_params: Array.isArray(row.required_params)
        ? [...row.required_params]
        : [],
      coverage: row.coverage ?? null,
    }));
}

export function sessionIdHash(sessionId) {
  return crypto
    .createHash('sha256')
    .update(String(sessionId), 'utf8')
    .digest('hex');
}

/** Strip Markdown fences / leading prose and parse the first JSON object. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start > -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Strict validation of the decision object. Returns
 * { ok, decisions:[{capabilityId, params}], errors:[…] } — any error means
 * NOTHING is executed.
 */
export function validateDecision(
  candidate,
  catalogue,
  { maxDecisions = DEFAULT_MAX_DECISIONS } = {},
) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      ok: false,
      decisions: [],
      errors: ['decision is not a JSON object'],
    };
  }
  const extra = Object.keys(candidate).filter((k) => k !== 'decisions');
  if (extra.length)
    errors.push(`unexpected top-level keys: ${extra.join(', ')}`);
  if (!Array.isArray(candidate.decisions)) {
    errors.push('decisions must be an array');
    return { ok: false, decisions: [], errors };
  }
  if (candidate.decisions.length > maxDecisions) {
    errors.push(`more than ${maxDecisions} decisions`);
  }
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const decisions = [];
  const seen = new Set();
  candidate.decisions.forEach((d, i) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      errors.push(`decisions[${i}] is not an object`);
      return;
    }
    const keys = Object.keys(d).filter(
      (k) => !['capabilityId', 'params', 'reason'].includes(k),
    );
    if (keys.length)
      errors.push(`decisions[${i}] has unknown keys: ${keys.join(', ')}`);
    const cap = byId.get(d.capabilityId);
    if (!cap) {
      errors.push(
        `decisions[${i}].capabilityId "${String(d.capabilityId)}" is not in the catalogue`,
      );
      return;
    }
    if (seen.has(cap.id)) {
      errors.push(`decisions[${i}] repeats capability "${cap.id}"`);
      return;
    }
    seen.add(cap.id);
    const params = d.params === undefined ? {} : d.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      errors.push(`decisions[${i}].params must be an object`);
      return;
    }
    const clean = {};
    for (const [k, v] of Object.entries(params)) {
      if (!cap.params.includes(k)) {
        errors.push(
          `decisions[${i}].params.${k} is not a parameter of "${cap.id}"`,
        );
        continue;
      }
      if (v === null || v === undefined) continue;
      if (['string', 'number', 'boolean'].includes(typeof v)) {
        clean[k] = String(v);
      } else {
        errors.push(`decisions[${i}].params.${k} must be a scalar`);
      }
    }
    for (const req of cap.required_params) {
      if (!(req in clean))
        errors.push(
          `decisions[${i}] is missing required param "${req}" of "${cap.id}"`,
        );
    }
    decisions.push({
      capabilityId: cap.id,
      params: clean,
      reason: typeof d.reason === 'string' ? d.reason.slice(0, 200) : undefined,
    });
  });
  return {
    ok: errors.length === 0,
    decisions: errors.length === 0 ? decisions : [],
    errors,
  };
}

export function decisionSystemPrompt(maxDecisions) {
  return (
    `You are the capability router of the God's Eye spatial intelligence gateway. ` +
    `You will receive a JSON object with the analyst query, the live spatial context (viewport bbox, centre, UTC now, active layers) and a CATALOGUE of executable data capabilities (id, provider, description, params, required_params). ` +
    `Decide which capabilities (0 to ${maxDecisions}) the gateway must execute to answer the query, and with which parameters. ` +
    `Use ONLY capabilityId values that appear in the catalogue and ONLY parameter names listed for that capability; derive geographic parameters from the spatial context and time parameters from "now". ` +
    `Respond with ONE JSON object and nothing else: {"decisions":[{"capabilityId":"<id>","params":{...},"reason":"<short>"}]}. ` +
    `If no capability is relevant, respond {"decisions":[]}. Never invent a capability, never add keys, never write prose or Markdown.`
  );
}

export function answerSystemPrompt() {
  return (
    `You are the God's Eye spatial intelligence analyst. You receive the analyst query, the spatial context, and TOOL RESULTS that the gateway executed for you (each with provenance: provider, license, fetched_at, freshness, coverage, completeness). ` +
    `Answer ONLY from those results and the spatial context; never invent entities, coordinates, counts or sources. Distinguish observed values from inferences; state what could not be checked (failed or missing capabilities). ` +
    `Respond with ONE JSON object and nothing else, with EXACTLY these seven keys: ${STRUCTURED_RESPONSE_KEYS.join(', ')}. ` +
    `"message": 3–8 plain sentences quoting literal values; "entities": [{id, layerId, label, role, latitude, longitude}] taken from the results; "actions": [] or MapActions from this allow-list only: fly_to_location, set_layer_visibility, annotate_map, analyst_query, frame_overhead, track_entity (each {name, params, reason, findingIds}); "evidence": [{findingId, entityId, field, value, sourceLayer}]; "sources": one entry per tool result {id: capabilityId, kind: "capability", label: provider, status: "used"|"failed"|"empty"}; "suggestedNextActions": [{label, action|null}]; "runMeta": {"mode":"capability-loop","executed":[capabilityIds],"generatedAtUtc":<now>}.`
  );
}

function scalarize(value) {
  return value === undefined ? null : value;
}

/**
 * Run the loop. `ondemand` = { fetch: ondemandFetch-compatible (url, init)
 * → Response, chatBase: 'https://api.on-demand.io/chat/v1' }.
 * `adapters` = { [capabilityId]: (params, ctx) => Promise<adapterResult> }.
 */
export async function runCapabilityLoop({
  query,
  spatialContext = {},
  tier = 'INVESTIGATE',
  userId,
  sessionId,
  registry,
  adapters,
  ondemand,
  endpointId,
  reasoningMode,
  pluginIds = [],
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  maxDecisions = DEFAULT_MAX_DECISIONS,
  log = () => {},
  signal,
}) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new TypeError('runCapabilityLoop: query is required');
  }
  if (!ondemand || typeof ondemand.fetch !== 'function' || !ondemand.chatBase) {
    throw new TypeError(
      'runCapabilityLoop: ondemand {fetch, chatBase} is required',
    );
  }
  if (!endpointId)
    throw new TypeError('runCapabilityLoop: endpointId is required');
  const t0 = Date.now();
  const nowIso = now().toISOString();
  const catalogue = buildCatalogue(registry);
  const result = {
    ok: false,
    tier,
    endpointId,
    reasoningMode: reasoningMode ?? null,
    reasoningModeSent: false,
    catalogue: catalogue.map((c) => c.id),
    sessionIdHash: null,
    decision: null,
    executed: [],
    structuredResponse: null,
    validation: null,
    latencies: {
      sessionMs: 0,
      decisionMs: 0,
      executeMs: 0,
      answerMs: 0,
      totalMs: 0,
    },
    startedAtUtc: nowIso,
  };

  // 1. Session (§2.1) — create when no sessionId was supplied.
  let sid = sessionId;
  const tSession = Date.now();
  if (!sid) {
    const externalUserId =
      userId || `godseye-capability-loop-${nowIso.slice(0, 10)}`;
    const res = await ondemand.fetch(`${ondemand.chatBase}/sessions`, {
      method: 'POST',
      body: { externalUserId, pluginIds },
      signal,
    });
    if (!res.ok) {
      result.error = {
        stage: 'session',
        status: res.status,
        message: 'session create failed',
      };
      result.latencies.totalMs = Date.now() - t0;
      return result;
    }
    const json = await res.json().catch(() => null);
    sid = json?.data?.id;
    if (!sid) {
      result.error = {
        stage: 'session',
        status: res.status,
        message: 'session id missing',
      };
      result.latencies.totalMs = Date.now() - t0;
      return result;
    }
  }
  result.sessionIdHash = sessionIdHash(sid);
  result.latencies.sessionMs = Date.now() - tSession;
  const queryUrl = `${ondemand.chatBase}/sessions/${encodeURIComponent(sid)}/query`;

  const submit = async (text, fulfillmentPrompt) => {
    const body = {
      query: text,
      endpointId,
      responseMode: 'sync',
      pluginIds,
      modelConfigs: { fulfillmentPrompt },
    };
    // reasoningMode is documented for stream mode only (§3.1) — recorded in
    // the result, never sent on these sync turns.
    const res = await ondemand.fetch(queryUrl, {
      method: 'POST',
      body,
      signal,
    });
    const json = await res.json().catch(() => null);
    return {
      status: res.status,
      ok: res.ok,
      answer: json?.data?.answer ?? null,
      messageId: json?.data?.messageId ?? null,
    };
  };

  // 2. Decision turn.
  const tDecision = Date.now();
  const decisionInput = {
    query,
    now: nowIso,
    spatialContext,
    catalogue,
    instructions: `Return {"decisions":[...]} with at most ${maxDecisions} entries.`,
  };
  const decisionTurn = await submit(
    JSON.stringify(decisionInput),
    decisionSystemPrompt(maxDecisions),
  );
  result.latencies.decisionMs = Date.now() - tDecision;
  if (!decisionTurn.ok) {
    result.error = {
      stage: 'decision',
      status: decisionTurn.status,
      message: 'decision query failed',
    };
    result.latencies.totalMs = Date.now() - t0;
    return result;
  }
  const rawDecision = extractJson(decisionTurn.answer);
  const decision = validateDecision(rawDecision, catalogue, { maxDecisions });
  result.decision = {
    httpStatus: decisionTurn.status,
    raw: rawDecision,
    answerChars:
      typeof decisionTurn.answer === 'string' ? decisionTurn.answer.length : 0,
    valid: decision.ok,
    errors: decision.errors,
    decisions: decision.decisions,
  };
  log(
    `decision valid=${decision.ok} decisions=${decision.decisions.map((d) => d.capabilityId).join(',') || '-'} errors=${decision.errors.length}`,
  );
  if (!decision.ok) {
    result.error = {
      stage: 'decision',
      status: 422,
      message: 'decision rejected',
      errors: decision.errors,
    };
    result.latencies.totalMs = Date.now() - t0;
    return result;
  }

  // 3. Execute ONLY what was decided.
  const tExec = Date.now();
  const toolResults = [];
  for (const d of decision.decisions) {
    const adapter = adapters?.[d.capabilityId];
    const started = Date.now();
    const entry = {
      capabilityId: d.capabilityId,
      params: d.params,
      status: null,
      count: null,
      ms: 0,
      error: null,
    };
    if (typeof adapter !== 'function') {
      entry.status = 501;
      entry.error = {
        code: 'adapter_missing',
        message: `no adapter registered for ${d.capabilityId}`,
      };
      toolResults.push({
        capabilityId: d.capabilityId,
        params: d.params,
        ok: false,
        status: 501,
        error: entry.error,
      });
    } else {
      let r;
      try {
        r = await adapter(d.params, { signal, now, fetchImpl });
      } catch (err) {
        r = {
          ok: false,
          status: 502,
          error: {
            code: 'adapter_error',
            message: err?.message || String(err),
          },
        };
      }
      entry.status = r?.status ?? (r?.ok ? 200 : 502);
      if (r?.ok) {
        entry.count = scalarize(r.data?.count);
        toolResults.push({
          capabilityId: d.capabilityId,
          params: d.params,
          ok: true,
          status: entry.status,
          data: r.data,
          provenance: r.provenance,
        });
      } else {
        entry.error = r?.error ?? {
          code: 'unknown',
          message: 'adapter failed',
        };
        toolResults.push({
          capabilityId: d.capabilityId,
          params: d.params,
          ok: false,
          status: entry.status,
          error: entry.error,
        });
      }
    }
    entry.ms = Date.now() - started;
    result.executed.push(entry);
    log(
      `executed ${d.capabilityId} status=${entry.status} count=${entry.count ?? '-'} ms=${entry.ms}`,
    );
  }
  result.latencies.executeMs = Date.now() - tExec;

  // 4. Tool-result turn into the SAME session.
  const tAnswer = Date.now();
  const answerInput = {
    query,
    now: nowIso,
    spatialContext,
    toolResults: toolResults.map((tr) => truncateToolResult(tr)),
    executed: result.executed.map((e) => e.capabilityId),
  };
  const answerTurn = await submit(
    JSON.stringify(answerInput),
    answerSystemPrompt(),
  );
  result.latencies.answerMs = Date.now() - tAnswer;
  if (!answerTurn.ok) {
    result.error = {
      stage: 'answer',
      status: answerTurn.status,
      message: 'answer query failed',
    };
    result.latencies.totalMs = Date.now() - t0;
    return result;
  }
  // 5. Validate the StructuredResponse.
  const structured = extractJson(answerTurn.answer);
  result.structuredResponse = structured;
  result.answerHttpStatus = answerTurn.status;
  result.validation = structured
    ? validateStructuredResponse(structured, ACTION_ALLOW_LIST)
    : { ok: false, errors: ['answer is not a JSON object'] };
  result.ok = result.validation.ok;
  result.latencies.totalMs = Date.now() - t0;
  return result;
}

/** MapAction names the answer turn may use (subset of the 28 known names). */
export const ACTION_ALLOW_LIST = Object.freeze([
  'fly_to_location',
  'set_layer_visibility',
  'annotate_map',
  'analyst_query',
  'frame_overhead',
  'track_entity',
]);

const MAX_ITEMS_PER_RESULT = 25;
const ITEM_LIST_KEYS = [
  'events',
  'items',
  'detections',
  'states',
  'aircraft',
  'vehicles',
  'stations',
  'routes',
  'cameras',
  'features',
  'passes',
  'launches',
  'results',
  'elements',
  'objects',
  'positions',
];

/** Keep the prompt bounded: cap every item list inside a tool result. */
export function truncateToolResult(tr, maxItems = MAX_ITEMS_PER_RESULT) {
  if (!tr.ok || !tr.data || typeof tr.data !== 'object') return tr;
  const data = { ...tr.data };
  for (const key of Object.keys(data)) {
    if (
      Array.isArray(data[key]) &&
      (ITEM_LIST_KEYS.includes(key) || data[key].length > maxItems)
    ) {
      if (data[key].length > maxItems) {
        data[`${key}_truncated_to`] = maxItems;
        data[key] = data[key].slice(0, maxItems);
      }
    }
  }
  return { ...tr, data };
}
