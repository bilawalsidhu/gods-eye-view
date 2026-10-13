import { resolveVoiceModel } from '../../voice/voiceCost.js';
import { assertKeyedHttps } from '../governors.js';

/**
 * Keyed on-device voice: API-key-only OpenAI Realtime token minting plus
 * the ephemeral SDP negotiation, in the `realtimeBackend`
 * `{ requestToken, negotiate }` shape the voice session already speaks.
 *
 * Mobile voice is API-key-only by binding (b): the OAuth paths stay
 * desktop-only and are untouched here — this backend reads exactly one
 * vault key (`OPENAI_API_KEY`) and POSTs `client_secrets` directly with it.
 * Any token failure (missing key, refused upstream, expired secret)
 * rejects with an honest `VOICE UNAVAILABLE` error; the mic-acquisition
 * helper (`requestVoiceSession`) mints the token FIRST so a dead token can
 * never cost a microphone prompt.
 *
 * Late responses are discarded: the caller signal is checked after every
 * await, because CapacitorHttp cannot cancel in flight.
 *
 * @module mobile/adapters/voiceDirect
 */

/** OpenAI Realtime ephemeral-secret mint endpoint (direct, no proxy). */
export const OPENAI_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';

/** OpenAI Realtime WebRTC calls endpoint (ephemeral SDP exchange). */
export const OPENAI_REALTIME_CALLS_URL =
  'https://api.openai.com/v1/realtime/calls';

/** Honest failure surface: the mic stays off and the UI shows this. */
export const VOICE_UNAVAILABLE_CODE = 'VOICE_UNAVAILABLE';

/**
 * Build the honest voice failure. Messages never carry the key, the token,
 * or upstream wording — just the state the UI must show.
 * @param {string} reason Short sanitized reason (no secrets, no ids).
 * @returns {Error} Error with `code: 'VOICE_UNAVAILABLE'`.
 */
export function voiceUnavailableError(reason) {
  return Object.assign(
    new Error(`VOICE UNAVAILABLE${reason ? `: ${reason}` : ''}`),
    { code: VOICE_UNAVAILABLE_CODE },
  );
}

/**
 * Create the on-device API-key voice backend.
 * @param {{ getKey?: Function, fetchImpl?: Function, tokenUrl?: string, callsUrl?: string }} options Vault reader, transport, and endpoint overrides.
 * @returns {{ requestToken: Function, negotiate: Function }} `realtimeBackend`-compatible backend.
 */
export function createVoiceBackend({
  getKey = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  tokenUrl = OPENAI_CLIENT_SECRETS_URL,
  callsUrl = OPENAI_REALTIME_CALLS_URL,
} = {}) {
  return {
    /**
     * Mint an ephemeral Realtime secret directly with the vault key.
     * @param {{ tier?: string, signal?: AbortSignal }} options Voice tier + caller signal.
     * @returns {Promise<{ token: string, model: string|null, tier: string|null, expiresAt: number|null }>} Ephemeral credential.
     */
    async requestToken({ tier, signal } = {}) {
      signal?.throwIfAborted();
      let key = null;
      try {
        key = typeof getKey === 'function' ? await getKey() : null;
      } catch {
        key = null;
      }
      signal?.throwIfAborted();
      if (typeof key !== 'string' || !key) {
        throw voiceUnavailableError('no API key on this device');
      }
      assertKeyedHttps(tokenUrl);
      const model = resolveVoiceModel(tier);
      let response;
      try {
        response = await fetchImpl(tokenUrl, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            session: { type: 'realtime', model: model.id },
          }),
        });
      } catch {
        signal?.throwIfAborted();
        throw voiceUnavailableError('token request failed');
      }
      signal?.throwIfAborted();
      const data = await response.json().catch(() => null);
      signal?.throwIfAborted();
      if (!response.ok) {
        throw voiceUnavailableError(`token HTTP ${response.status}`);
      }
      const token =
        data?.value || data?.client_secret?.value || data?.client_secret;
      if (typeof token !== 'string' || !token) {
        throw voiceUnavailableError('token response held no secret');
      }
      const expiresAt = data?.expires_at ?? data?.client_secret?.expires_at;
      if (
        expiresAt != null &&
        (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now())
      ) {
        throw voiceUnavailableError('secret already expired');
      }
      return {
        token,
        model: model.id,
        tier: model.tier,
        expiresAt: expiresAt ?? null,
      };
    },
    /**
     * Exchange the SDP offer for an answer with the ephemeral credential
     * (mirrors `realtimeBackend.negotiate` — no vault key involved).
     * @param {{ offerSdp: string, credential: { token: string, expiresAt?: number|null }, signal?: AbortSignal }} options Offer, ephemeral credential, caller signal.
     * @returns {Promise<string>} SDP answer text.
     */
    async negotiate({ offerSdp, credential, signal } = {}) {
      signal?.throwIfAborted();
      if (!offerSdp || !credential?.token) {
        throw voiceUnavailableError('offer and credential are required');
      }
      if (
        credential.expiresAt != null &&
        credential.expiresAt * 1000 <= Date.now()
      ) {
        throw voiceUnavailableError('secret already expired');
      }
      assertKeyedHttps(callsUrl);
      let response;
      try {
        response = await fetchImpl(callsUrl, {
          method: 'POST',
          body: offerSdp,
          signal,
          redirect: 'error',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${credential.token}`,
            'Content-Type': 'application/sdp',
          },
        });
      } catch {
        signal?.throwIfAborted();
        throw voiceUnavailableError('SDP exchange failed');
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw voiceUnavailableError(`SDP HTTP ${response.status}`);
      }
      const answer = await response.text();
      signal?.throwIfAborted();
      return answer;
    },
  };
}

/**
 * Acquire a voice session with the mic gated behind a live token: the
 * ephemeral secret is minted first, and `acquireMic` runs only after it
 * resolves — so a token failure surfaces VOICE UNAVAILABLE with the
 * microphone never acquired.
 * @param {{ backend: { requestToken: Function }, tier?: string, signal?: AbortSignal, acquireMic: Function }} options Backend, tier, signal, and the mic-acquisition hook.
 * @returns {Promise<{ credential: object, stream: * }>} Credential plus the acquired media stream.
 */
export async function requestVoiceSession({
  backend,
  tier,
  signal,
  acquireMic,
} = {}) {
  if (!backend || typeof backend.requestToken !== 'function') {
    throw new TypeError('requestVoiceSession needs a voice backend');
  }
  if (typeof acquireMic !== 'function') {
    throw new TypeError('requestVoiceSession needs an acquireMic hook');
  }
  const credential = await backend.requestToken({ tier, signal });
  signal?.throwIfAborted();
  const stream = await acquireMic({ signal });
  signal?.throwIfAborted();
  return { credential, stream };
}
