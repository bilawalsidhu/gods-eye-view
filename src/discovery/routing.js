import { searchDiscovery, validateDiscoveryPack } from './model.js';
const SHAPES = new Set(['empty', 'exact-id', 'text']);
const ROUTES = new Set([
  'exact-id',
  'local-cache',
  'text-index',
  'web-nearby',
  'abstain',
]);
const normalize = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
/** Local lookup optimization plus optional metadata-only observations; no provider auto-act. */
export function createDiscoveryLookup(
  pack,
  {
    clock = () => performance.now(),
    maxCacheEntries = 64,
    maxObservations = 200,
  } = {},
) {
  if (
    !Number.isInteger(maxCacheEntries) ||
    maxCacheEntries < 1 ||
    maxCacheEntries > 256 ||
    !Number.isInteger(maxObservations) ||
    maxObservations < 1 ||
    maxObservations > 500
  )
    throw new TypeError('Invalid lookup limits.');
  let catalog,
    index,
    exact,
    cache = new Map(),
    observations = [],
    sequence = 0,
    catalogVersion = 0;
  function setPack(value) {
    catalog = freeze(validateDiscoveryPack(value));
    index = catalog.cards.map((card) => ({
      card,
      text: normalize(
        [
          card.id,
          ...Object.values(card.labels),
          ...Object.values(card.descriptions),
          ...card.aliases,
        ].join(' '),
      ),
    }));
    exact = new Map(catalog.cards.map((card) => [card.id, card]));
    cache.clear();
    catalogVersion++;
  }
  setPack(pack);
  function lookup(scope = {}, { observe = false, allowWeb = false } = {}) {
    const started = clock();
    const options = {
      query: String(scope.query ?? '').slice(0, 200),
      body: scope.body ?? 'earth',
      kind: scope.kind ?? 'all',
      center: scope.center ?? null,
      radiusKm: scope.radiusKm ?? 10000,
      limit: scope.limit ?? 30,
    };
    // Reuse the reference validator without scanning any records.
    searchDiscovery([], options);
    const query = normalize(options.query),
      shape = !query
        ? 'empty'
        : /^q[1-9]\d*$/.test(query)
          ? 'exact-id'
          : 'text';
    const key = JSON.stringify({ ...options, query });
    let rows, route;
    if (cache.has(key)) {
      rows = cache.get(key);
      cache.delete(key);
      cache.set(key, rows);
      route = 'local-cache';
    } else {
      if (shape === 'exact-id') {
        const card = exact.get(query.toUpperCase());
        rows = card ? searchDiscovery([card], { ...options, query: '' }) : [];
        route = 'exact-id';
      } else {
        const terms = query.split(/\s+/).filter(Boolean);
        const candidates = index
          .filter((item) => terms.every((term) => item.text.includes(term)))
          .map((item) => item.card);
        rows = searchDiscovery(candidates, { ...options, query: '' });
        route = 'text-index';
      }
      rows = freeze(rows);
      cache.set(key, rows);
      if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
    }
    const verified = rows.length
      ? rows.every(
          ({ card }) =>
            card.body === options.body &&
            exact.has(card.id) &&
            card.provenance.source === 'Wikidata',
        )
      : null;
    const trace = {
      sequence: ++sequence,
      catalogVersion,
      queryShape: shape,
      body: options.body,
      hasProximity: Boolean(options.center),
      resultCount: rows.length,
      ambiguous: rows.length > 1 && shape !== 'empty',
      route,
      elapsedMs: Math.max(0, clock() - started),
      apiCalls: 0,
      modelCalls: 0,
      verifiedSourceShape: verified,
      allowWeb: Boolean(allowWeb),
      mode: 'observation',
      permitsAutoAct: false,
    };
    if (observe) {
      observations.push(freeze(trace));
      if (observations.length > maxObservations) observations.shift();
    }
    return { rows, trace };
  }
  return {
    lookup,
    setPack,
    clearObservations() {
      observations = [];
    },
    getObservations: () => observations.map((row) => ({ ...row })),
    exportObservations() {
      return {
        format: 'gods-eye-view/discovery-routing-observations',
        version: 1,
        policy: 'local-discovery/1',
        dataOrigin: 'observed_lookup_metadata',
        note: 'No raw search text, coordinates, study answers or private case fields. Source-shape verification is not entity-match accuracy.',
        observations: observations.map((row) => ({ ...row })),
      };
    },
    getCatalog: () => catalog,
  };
}
/** Closed typed features: even an injected observer never receives private free text. */
export function routingFeatures(trace) {
  if (
    !SHAPES.has(trace?.queryShape) ||
    !['earth', 'moon', 'mars'].includes(trace.body) ||
    !Number.isInteger(trace.resultCount) ||
    trace.resultCount < 0 ||
    trace.resultCount > 100 ||
    !ROUTES.has(trace.route)
  )
    throw new TypeError('Invalid observation.');
  return {
    body: trace.body,
    query_shape: trace.queryShape,
    has_proximity: Boolean(trace.hasProximity),
    result_count: trace.resultCount,
    ambiguous: Boolean(trace.ambiguous),
    baseline_route: trace.route,
    cache_available: trace.route === 'local-cache',
    source_shape_verified:
      trace.verifiedSourceShape === null
        ? null
        : Boolean(trace.verifiedSourceShape),
    web_explicitly_allowed: Boolean(trace.allowWeb),
    locality: 'local',
    baseline_model_calls: 0,
  };
}
export function proposeDiscoveryRoute(features) {
  if (features.result_count > 0)
    return {
      route: features.baseline_route,
      rationale: 'Reuse a source-linked local result.',
      permitsAutoAct: false,
    };
  if (
    features.body !== 'earth' ||
    !features.web_explicitly_allowed ||
    !features.has_proximity
  )
    return {
      route: 'abstain',
      rationale: 'No local result and no applicable authorized web source.',
      permitsAutoAct: false,
    };
  return {
    route: 'web-nearby',
    rationale:
      'A geographic web lookup may be requested explicitly; this proposal does not run it.',
    permitsAutoAct: false,
  };
}
function validateFeatures(features) {
  if (
    !['earth', 'moon', 'mars'].includes(features?.body) ||
    !SHAPES.has(features.query_shape) ||
    !Number.isInteger(features.result_count) ||
    features.result_count < 0 ||
    features.result_count > 100 ||
    !ROUTES.has(features.baseline_route) ||
    ![
      'has_proximity',
      'ambiguous',
      'cache_available',
      'web_explicitly_allowed',
    ].every((key) => typeof features[key] === 'boolean') ||
    (features.source_shape_verified !== null &&
      typeof features.source_shape_verified !== 'boolean')
  )
    throw new TypeError('Invalid routing features.');
}
/** Shared Jev/Laya/OpenJev choice envelope; construction performs no inference or I/O. */
export function systemOneEnvelope(features, { model, kind = 'openjev' } = {}) {
  validateFeatures(features);
  if (
    !['jev', 'laya', 'openjev'].includes(kind) ||
    typeof model !== 'string' ||
    !model.trim() ||
    /latest|auto/i.test(model)
  )
    throw new TypeError('Explicit provider and model identity required.');
  const state = {
    body: features.body,
    query_shape: features.query_shape,
    result_count: features.result_count,
    ambiguous: features.ambiguous,
    cache_available: features.cache_available,
    has_proximity: features.has_proximity,
    baseline_route: features.baseline_route,
    source_shape_verified: features.source_shape_verified,
    web_explicitly_allowed: features.web_explicitly_allowed,
    locality: 'local',
  };
  const questions = {
    route: {
      type: 'choice',
      instructions:
        'Recommend a mechanism only. Reuse local source-linked results. Never run a web query or invent an entity. Abstain if requirements are not supported.',
      criteria: {
        'exact-id': 'Exact source identifier lookup',
        'local-cache': 'Reuse local result cache',
        'text-index': 'Read-only local text/spatial index',
        'web-nearby':
          'Optional explicit Earth geographic request, never automatic',
        abstain: 'No sufficiently supported route',
      },
    },
  };
  return { model, state: JSON.stringify(state), questions };
}
/** Optional injected transport, bounded and off by default. Results are always shadow-only. */
export function createSystemOneShadowAdapter({
  kind,
  model,
  revision,
  transport = null,
  enabled = false,
  transportLocality = 'local',
  dataOrigin = 'fixture',
  maxCalls = 1,
  timeoutMs = 500,
} = {}) {
  if (
    !['jev', 'laya', 'openjev'].includes(kind) ||
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 128 ||
    /latest|auto/i.test(model) ||
    !['fixture', 'observed_lookup_metadata'].includes(dataOrigin) ||
    typeof revision !== 'string' ||
    !revision.trim() ||
    revision.length > 128 ||
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 20 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    throw new TypeError('Pinned adapter identity and bounds required.');
  let calls = 0;
  return {
    async observe(trace, { signal } = {}) {
      const features = routingFeatures(trace),
        request = systemOneEnvelope(features, { kind, model });
      const base = {
        kind,
        model,
        revision,
        revisionOrigin: 'caller-declared',
        dataOrigin,
        mode: 'shadow',
        permitsAutoAct: false,
        confidenceCalibrated: false,
        billedCostUSD: null,
      };
      if (!enabled || typeof transport !== 'function')
        return { ...base, status: 'disabled', calls };
      if (transportLocality !== 'local')
        return { ...base, status: 'locality-refused', calls };
      if (calls >= maxCalls)
        return { ...base, status: 'budget-exhausted', calls };
      signal?.throwIfAborted();
      calls++;
      const abort = new AbortController();
      const combined = AbortSignal.any([signal, abort.signal].filter(Boolean));
      let timer, onAbort;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error('Timeout'));
          }, timeoutMs);
        });
        const response = await Promise.race([
          transport(request, { signal: combined }),
          timeout,
          new Promise((_, reject) => {
            onAbort = () => reject(new Error('Cancelled'));
            combined.addEventListener('abort', onAbort, { once: true });
            if (combined.aborted) onAbort();
          }),
        ]);
        combined.throwIfAborted();
        const answer = response?.answers?.route,
          probs = answer?.probabilities;
        if (
          answer?.type !== 'choice' ||
          !ROUTES.has(answer.choice) ||
          !probs ||
          typeof probs !== 'object' ||
          Object.keys(probs).length !== 5 ||
          ![...ROUTES].every(
            (route) =>
              typeof probs[route] === 'number' &&
              Number.isFinite(probs[route]) &&
              probs[route] >= 0 &&
              probs[route] <= 1,
          ) ||
          Math.abs(
            Object.values(probs).reduce((sum, value) => sum + value, 0) - 1,
          ) > 0.001
        )
          throw new Error('Malformed answer');
        if (probs[answer.choice] < Math.max(...Object.values(probs)))
          throw new Error('Choice does not match distribution');
        const confidence = answer.confidence ?? null;
        if (
          confidence !== null &&
          (typeof confidence !== 'number' ||
            !Number.isFinite(confidence) ||
            confidence < 0 ||
            confidence > 1)
        )
          throw new Error('Malformed confidence');
        const compatible =
          (answer.choice === 'abstain' ||
            answer.choice === 'web-nearby' ||
            features.result_count > 0) &&
          (answer.choice !== 'web-nearby' ||
            (features.body === 'earth' &&
              features.web_explicitly_allowed &&
              features.has_proximity)) &&
          (answer.choice !== 'local-cache' || features.cache_available) &&
          (answer.choice !== 'exact-id' || features.query_shape === 'exact-id');
        return {
          ...base,
          status: !compatible
            ? 'requirements-refused'
            : response.model !== model
              ? 'identity-mismatch'
              : 'observed',
          route: answer.choice,
          probabilities: { ...probs },
          confidence,
          providerModel:
            typeof response.model === 'string' ? response.model : null,
          modelIdentityObserved: response.model === model,
          observedRevision:
            typeof response.model_revision === 'string'
              ? response.model_revision
              : null,
          identityMatchReported:
            response.model === model && response.model_revision === revision,
          immutableIdentityVerified: false,
          calls,
          usage:
            response.usage && typeof response.usage === 'object'
              ? {
                  input_tokens:
                    Number.isInteger(response.usage.input_tokens) &&
                    response.usage.input_tokens >= 0
                      ? response.usage.input_tokens
                      : null,
                  output_tokens:
                    Number.isInteger(response.usage.output_tokens) &&
                    response.usage.output_tokens >= 0
                      ? response.usage.output_tokens
                      : null,
                }
              : null,
        };
      } catch {
        signal?.throwIfAborted();
        return {
          ...base,
          status: abort.signal.aborted ? 'timeout' : 'malformed-or-unavailable',
          calls,
        };
      } finally {
        clearTimeout(timer);
        if (onAbort) combined.removeEventListener('abort', onAbort);
      }
    },
  };
}
