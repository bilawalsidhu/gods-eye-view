import { DEFAULT_VOICE_TIER, resolveVoiceModel } from './voiceCost.js';

/** Realtime-compatible token and SDP requests, independent of microphone/UI ownership. */
export function createRealtimeBackend({
  tokenEndpoint = '/api/realtime/token',
  callsEndpoint = 'https://api.openai.com/v1/realtime/calls',
  tokenTransport = (...args) => fetch(...args),
  connectionTransport = (...args) => fetch(...args),
  timeoutMs = 30_000,
  signal: lifetime,
} = {}) {
  const scoped = (signal) =>
    AbortSignal.any(
      [lifetime, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
    );
  return Object.freeze({
    protocol: 'openai-realtime',
    async requestToken({ tier = DEFAULT_VOICE_TIER, signal } = {}) {
      // Vercel Functions cannot mint an OpenAI Realtime ephemeral secret the
      // way this deployment intends to run (server/serverless/app.js answers
      // /api/realtime/token with 501 in serverless mode); short-circuit here
      // instead of round-tripping to learn that. See
      // docs/SERVERLESS_LIMITATIONS.md.
      if (import.meta.env?.VITE_SERVERLESS_MODE === 'true') {
        throw new Error(
          'Voice control (OpenAI Realtime) is unavailable in the serverless deployment',
        );
      }
      signal = scoped(signal);
      signal.throwIfAborted();
      const separator = tokenEndpoint.includes('?') ? '&' : '?';
      const url = `${tokenEndpoint}${separator}tier=${encodeURIComponent(resolveVoiceModel(tier).tier)}`;
      const response = await tokenTransport(url, {
        signal,
        cache: 'no-store',
        redirect: 'error',
      });
      signal.throwIfAborted();
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (!response.ok) {
        const reason =
          typeof data?.error === 'string' ? data.error : data?.error?.message;
        throw new Error(
          reason || `Realtime token failed: HTTP ${response.status}`,
        );
      }
      const token =
        data?.value || data?.client_secret?.value || data?.client_secret;
      if (typeof token !== 'string' || !token)
        throw new Error(
          'Realtime token response did not include a client secret',
        );
      const expiresAt = data?.expires_at ?? data?.client_secret?.expires_at;
      if (
        expiresAt != null &&
        (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now())
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      return {
        token,
        model:
          response.headers?.get?.('X-GEV-Voice-Model') ||
          data?.session?.model ||
          null,
        tier: response.headers?.get?.('X-GEV-Voice-Tier') || null,
        expiresAt,
      };
    },
    async negotiate({ offerSdp, credential, signal }) {
      signal = scoped(signal);
      signal.throwIfAborted();
      if (
        credential.expiresAt != null &&
        credential.expiresAt * 1000 <= Date.now()
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      const response = await connectionTransport(callsEndpoint, {
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
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`Realtime SDP failed: HTTP ${response.status}`);
      }
      const answer = await response.text();
      signal.throwIfAborted();
      return answer;
    },
  });
}
