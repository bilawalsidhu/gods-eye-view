import { assertSameOriginPath, fetchBffJson } from './http.js';
import { normalizeEphemeralToken } from './ephemeralToken.js';

export const FOUNDRY_BFF_CONTRACTS = Object.freeze({
  realtimeClientSecret: Object.freeze({
    method: 'POST',
    path: '/api/azure/foundry/realtime/client-secret',
    request: '{ deployment?, voice?, instructions?, modalities? }',
    response: '{ clientSecret: { value, expiresAt }, endpoint, deployment?, model? }',
  }),
  hudSummary: Object.freeze({
    method: 'POST',
    path: '/api/azure/foundry/hud-summary',
    request: '{ prompt, context?, maxCharacters? }',
    response: '{ configured: boolean, summary: string|null, code?: string|null, error?: null }',
  }),
});

/**
 * @typedef {{
 *   value:string,
 *   expiresAt:number,
 *   endpoint:string,
 *   deployment:string|null,
 *   model:string|null
 * }} FoundryRealtimeClientSecret
 * @typedef {{
 *   configured:boolean,
 *   summary:string|null,
 *   code?:string|null,
 *   error?:null
 * }} FoundryHudSummaryResponse
 */

function foundryEndpoint(value) {
  const url = new URL(String(value ?? ''));
  if (url.protocol !== 'https:') throw new TypeError('Microsoft Foundry endpoint must use HTTPS');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

/**
 * Obtain a session-scoped secret from the same-origin BFF. Persistent Azure
 * credentials and API keys never enter this module or the browser response.
 * @returns {Promise<FoundryRealtimeClientSecret>}
 */
export async function getFoundryRealtimeClientSecret({
  deployment,
  voice,
  instructions,
  modalities,
  signal,
  fetchImpl = globalThis.fetch,
  endpoint = FOUNDRY_BFF_CONTRACTS.realtimeClientSecret.path,
} = {}) {
  assertSameOriginPath(endpoint);
  const data = await fetchBffJson(endpoint, {
    fetchImpl,
    method: 'POST',
    cache: 'no-store',
    signal,
    body: {
      ...(deployment ? { deployment } : {}),
      ...(voice ? { voice } : {}),
      ...(instructions ? { instructions } : {}),
      ...(modalities ? { modalities } : {}),
    },
  });
  const token = normalizeEphemeralToken(data);
  const serviceEndpoint = data.endpoint ?? data.webrtcEndpoint ?? data.session?.endpoint;
  if (!serviceEndpoint) throw new TypeError('Realtime secret response did not include endpoint');
  return Object.freeze({
    value: token.value,
    expiresAt: token.expiresAt,
    endpoint: foundryEndpoint(serviceEndpoint).origin
      + foundryEndpoint(serviceEndpoint).pathname,
    deployment: data.deployment ?? data.session?.deployment ?? null,
    model: data.model ?? data.session?.model ?? null,
  });
}

/**
 * Build the Azure OpenAI/Foundry GA WebRTC calls URL.
 */
export function buildFoundryRealtimeSdpEndpoint(endpoint, {
  apiVersion,
  deployment,
} = {}) {
  const url = foundryEndpoint(endpoint);
  if (!url.pathname.endsWith('/openai/v1/realtime/calls')) {
    url.pathname = `${url.pathname}/openai/v1/realtime/calls`.replace(/\/{2,}/g, '/');
  }
  if (apiVersion) url.searchParams.set('api-version', apiVersion);
  if (deployment) url.searchParams.set('deployment', deployment);
  return url.href;
}

/**
 * Create the request accepted by fetch(). Only a short-lived client secret is
 * allowed; callers should discard it with the RTCPeerConnection.
 */
export function buildFoundryRealtimeSdpRequest({
  endpoint,
  clientSecret,
  sdp,
  apiVersion,
  deployment,
  signal,
}) {
  const value = typeof clientSecret === 'string' ? clientSecret : clientSecret?.value;
  if (!String(value ?? '').trim()) throw new TypeError('An ephemeral realtime client secret is required');
  if (!String(sdp ?? '').trim()) throw new TypeError('A WebRTC SDP offer is required');
  return {
    url: buildFoundryRealtimeSdpEndpoint(endpoint, { apiVersion, deployment }),
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(value).trim()}`,
        'Content-Type': 'application/sdp',
      },
      body: sdp,
      ...(signal ? { signal } : {}),
    },
  };
}

export class FoundryHudSummaryClient {
  constructor({
    fetchImpl = globalThis.fetch,
    endpoint = FOUNDRY_BFF_CONTRACTS.hudSummary.path,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.endpoint = assertSameOriginPath(endpoint);
  }

  /**
   * @param {{prompt:string, context?:object, maxCharacters?:number, signal?:AbortSignal}} request
   * @returns {Promise<FoundryHudSummaryResponse>}
   */
  async summarize({ prompt, context, maxCharacters, signal }) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new TypeError('prompt is required');
    const data = await fetchBffJson(this.endpoint, {
      fetchImpl: this.fetchImpl,
      method: 'POST',
      signal,
      body: {
        prompt: text,
        ...(context === undefined ? {} : { context }),
        ...(maxCharacters === undefined ? {} : { maxCharacters }),
      },
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('HUD summary BFF response must be an object');
    }
    if (data.summary != null && typeof data.summary !== 'string') {
      throw new TypeError('HUD summary must be a string or null');
    }
    return data;
  }
}
