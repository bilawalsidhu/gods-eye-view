/**
 * ProjectionSource: the transport seam of the world-model layer.
 *
 * The layer depends only on this contract. Required:
 *
 *   getRevisions({ head, limit, signal }) -> Promise<{ head, revisions: Revision[] }>
 *       the head's completed revision chain, newest first, exactly as served
 *   getProjection({ revisionId | head, query, projectionSpec, signal }) -> Promise<Projection>
 *       neutral-v1 JSON for ONE demand; the query and spec travel with every call
 *
 * Optional, feature-detected by the layer (an absent method hides the
 * feature; it never fails the layer):
 *
 *   getHeads({ signal })                          -> Promise<{ [head]: revisionId }>
 *   getProvenance({ ref, follow, depth, signal })  -> Promise<ProvenanceReport>
 *   getStatus({ head, signal })                    -> Promise<Status>   (facts, never a verdict)
 *   getRevision({ revisionId, signal })            -> Promise<Revision> (its bindings and their descriptors, GEN-299)
 *   select({ revisionId | head, query, signal })   -> Promise<Selection>
 *       `POST /select` with values: products the projection does not draw
 *       (a sample series has no position), read by a layer adapter as numbers
 *
 * How the request reaches the world model is the host's business: the
 * standalone Gods Eye shell wires an HTTP source at a local development
 * proxy; the Dataforge client supplies its own transport (Dataforge Serve v2
 * forwarding the caller's token/context). This module knows nothing about
 * Vite, proxies, or Dataforge. `createHttpProjectionSource` is ONE
 * implementation over the world-model REST shape; an in-memory fixture source
 * that satisfies `assertProjectionSource` is just as valid.
 */
import { HEAD } from './view.js';

export const PROJECTION_SOURCE_ERROR_CODES = Object.freeze([
  'unreachable',
  'unauthorized',
  'head-missing',
  'http',
  'malformed',
]);

export class ProjectionSourceError extends Error {
  /**
   * @param {string} code One of PROJECTION_SOURCE_ERROR_CODES.
   * @param {string} message Human-readable, safe to show in the layer row.
   * @param {{status?: number, cause?: unknown}} [details]
   */
  constructor(code, message, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectionSourceError';
    this.code = PROJECTION_SOURCE_ERROR_CODES.includes(code) ? code : 'http';
    this.status = Number.isFinite(status) ? status : null;
  }
}

/** Require the ProjectionSource shape before a layer accepts a source. */
export function assertProjectionSource(source) {
  if (
    typeof source?.getRevisions !== 'function' ||
    typeof source?.getProjection !== 'function'
  ) {
    throw new TypeError(
      'World model layer requires a ProjectionSource with getRevisions() and getProjection()',
    );
  }
  return source;
}

/** Which optional methods a source offers; the layer hides what is absent. */
export function sourceFeatures(source) {
  return Object.freeze({
    heads: typeof source?.getHeads === 'function',
    provenance: typeof source?.getProvenance === 'function',
    status: typeof source?.getStatus === 'function',
    select: typeof source?.select === 'function',
    revision: typeof source?.getRevision === 'function',
  });
}

/**
 * `type_id@sha256:<hex>` for a projected item's `semantic_ref.product_ref`
 * (the path segment `GET /provenance/{ref}` takes). Empty when the ref is
 * incomplete: nothing is guessed.
 * @param {{type_id?: string, content_id?: string}|null|undefined} ref
 */
export function refString(ref) {
  const typeId = typeof ref?.type_id === 'string' ? ref.type_id : '';
  const contentId = typeof ref?.content_id === 'string' ? ref.content_id : '';
  return typeId && contentId ? `${typeId}@${contentId}` : '';
}

const PROJECTION_ARRAYS = Object.freeze([
  'points',
  'lines',
  'polygons',
  'field_samples',
  'annotations',
  'assumptions',
  'omissions',
]);

/**
 * Validate a neutral-v1 projection payload structurally (never semantically:
 * the adapter decides what it can draw). Returns the payload unchanged.
 */
export function validateProjection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProjectionSourceError('malformed', 'Projection is not an object');
  }
  if (typeof payload.revision_id !== 'string' || !payload.revision_id) {
    throw new ProjectionSourceError(
      'malformed',
      'Projection is missing revision_id',
    );
  }
  for (const key of PROJECTION_ARRAYS) {
    if (!Array.isArray(payload[key])) {
      throw new ProjectionSourceError(
        'malformed',
        `Projection is missing the ${key} array`,
      );
    }
  }
  return payload;
}

/** Validate `GET /revisions` structurally: `{ head, revisions: [{ id, parent_id, created_at, bindings }] }`. */
export function validateRevisions(payload, head) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.revisions)
  ) {
    throw new ProjectionSourceError(
      'malformed',
      'Revisions response is missing the revisions array',
    );
  }
  for (const revision of payload.revisions) {
    if (typeof revision?.id !== 'string' || !revision.id) {
      throw new ProjectionSourceError(
        'malformed',
        'A revision in the chain has no id',
      );
    }
  }
  return {
    head: typeof payload.head === 'string' ? payload.head : head,
    revisions: payload.revisions,
  };
}

function messageFromBody(payload, fallback) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message)
      return payload.message;
    if (typeof payload.error === 'string' && payload.error)
      return payload.error;
  }
  return fallback;
}

function searchOf(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '')
      search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * HTTP implementation over the world-model REST shape
 * (`GET {baseUrl}/revisions`, `POST {baseUrl}/project`, and the optional
 * `GET /heads`, `GET /provenance/{ref}`, `GET /status`).
 *
 * @param {object} options
 * @param {string} options.baseUrl Origin and/or prefix the host chose:
 *   a prefix behind the host's own proxy, a Serve v2 route, or a
 *   direct backplane URL. Never hard-coded here.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => (object|Promise<object>)} [options.headers] Awaited per
 *   request so a host can attach `Authorization` / caller context.
 * @param {string} [options.head] Default head name (world/main).
 */
export function createHttpProjectionSource({
  baseUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  headers = async () => ({}),
  head = HEAD,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new TypeError('createHttpProjectionSource requires a baseUrl');
  }
  const root = baseUrl.trim().replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, signal } = {}) {
    signal?.throwIfAborted();
    const extraHeaders = (await headers()) || {};
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ProjectionSourceError(
        'unreachable',
        `World model unreachable at ${root}: ${error?.message || error}`,
        { cause: error },
      );
    }
    signal?.throwIfAborted();
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (response.ok) {
        throw new ProjectionSourceError(
          'malformed',
          `World model returned non-JSON for ${path}`,
          { status: response.status, cause: error },
        );
      }
    }
    signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      throw new ProjectionSourceError(
        'unauthorized',
        messageFromBody(
          payload,
          `World model refused the request (${response.status})`,
        ),
        { status: response.status },
      );
    }
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      throw new ProjectionSourceError(
        'unreachable',
        messageFromBody(
          payload,
          `World model unreachable (${response.status})`,
        ),
        { status: response.status },
      );
    }
    if (!response.ok) {
      // The backplane answers 404 for an unset head on the head-scoped reads.
      const code =
        response.status === 404 && /^\/(revisions|heads|status)/.test(path)
          ? 'head-missing'
          : 'http';
      throw new ProjectionSourceError(
        code,
        messageFromBody(
          payload,
          `World model HTTP ${response.status} for ${path}`,
        ),
        { status: response.status },
      );
    }
    return payload;
  }

  return Object.freeze({
    async getRevisions({ head: name = head, limit = 20, signal } = {}) {
      const payload = await request(
        `/revisions${searchOf({ head: name, limit })}`,
        { signal },
      );
      const chain = validateRevisions(payload, name);
      if (!chain.revisions.length) {
        throw new ProjectionSourceError(
          'head-missing',
          `Head ${name} is not set; run \`worldmodel noaa replay\` and \`worldmodel opensky replay\``,
        );
      }
      return chain;
    },
    async getProjection({
      revisionId,
      head: name,
      query = {},
      projectionSpec = {},
      signal,
    } = {}) {
      const byId = typeof revisionId === 'string' && revisionId;
      if (!byId && (typeof name !== 'string' || !name)) {
        throw new TypeError('getProjection requires a revisionId or a head');
      }
      const payload = await request('/project', {
        method: 'POST',
        body: {
          ...(byId ? { revision_id: revisionId } : { head: name }),
          query,
          projection_spec: projectionSpec,
        },
        signal,
      });
      const projection = validateProjection(payload);
      if (byId && projection.revision_id !== revisionId) {
        throw new ProjectionSourceError(
          'malformed',
          `Projection revision ${projection.revision_id} does not match the requested ${revisionId}`,
        );
      }
      return projection;
    },
    async getHeads({ signal } = {}) {
      const heads = await request('/heads', { signal });
      if (!heads || typeof heads !== 'object' || Array.isArray(heads)) {
        throw new ProjectionSourceError(
          'malformed',
          'Heads response is not an object',
        );
      }
      return heads;
    },
    async getProvenance({ ref, follow = 'source', depth = 8, signal } = {}) {
      const text = typeof ref === 'string' ? ref : refString(ref);
      if (!text) throw new TypeError('getProvenance requires a product ref');
      return request(
        `/provenance/${encodeURIComponent(text)}${searchOf({ follow, depth })}`,
        { signal },
      );
    },
    async getRevision({ revisionId, signal } = {}) {
      if (typeof revisionId !== 'string' || !revisionId)
        throw new TypeError('getRevision requires a revisionId');
      const payload = await request(
        `/revisions/${encodeURIComponent(revisionId)}`,
        {
          signal,
        },
      );
      if (payload?.id !== revisionId) {
        throw new ProjectionSourceError(
          'malformed',
          `Revision ${payload?.id} does not match the requested ${revisionId}`,
        );
      }
      return payload;
    },
    async getStatus({ head: name = head, signal } = {}) {
      return request(`/status${searchOf({ head: name })}`, { signal });
    },
    async select({ revisionId, head: name, query = {}, signal } = {}) {
      const byId = typeof revisionId === 'string' && revisionId;
      if (!byId && (typeof name !== 'string' || !name)) {
        throw new TypeError('select requires a revisionId or a head');
      }
      const payload = await request('/select', {
        method: 'POST',
        body: {
          ...(byId ? { revision_id: revisionId } : { head: name }),
          query,
          include_values: true,
        },
        signal,
      });
      if (!Array.isArray(payload?.products)) {
        throw new ProjectionSourceError(
          'malformed',
          'Selection is missing the products array',
        );
      }
      return payload;
    },
    describe() {
      return { transport: 'http', baseUrl: root, head };
    },
  });
}
