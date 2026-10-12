import { DEFAULT_VOICE_TIER, resolveVoiceModel } from './voiceCost.js';
import { t } from '../i18n/index.js';

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
    async requestToken({
      tier = DEFAULT_VOICE_TIER,
      authMode = 'api-key',
      signal,
    } = {}) {
      signal = scoped(signal);
      signal.throwIfAborted();
      const separator = tokenEndpoint.includes('?') ? '&' : '?';
      const query = new URLSearchParams({
        tier: resolveVoiceModel(tier).tier,
      });
      if (authMode === 'oauth') query.set('auth', 'oauth');
      const url = `${tokenEndpoint}${separator}${query}`;
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
          reason || t('voice.backend.tokenFailed', { status: response.status }),
        );
      }
      const token =
        data?.value || data?.client_secret?.value || data?.client_secret;
      if (typeof token !== 'string' || !token)
        throw new Error(t('voice.backend.tokenNoSecret'));
      const expiresAt = data?.expires_at ?? data?.client_secret?.expires_at;
      if (
        expiresAt != null &&
        (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now())
      )
        throw new Error(t('voice.backend.secretExpired'));
      return {
        token,
        model:
          response.headers?.get?.('X-GEV-Voice-Model') ||
          data?.session?.model ||
          null,
        tier: response.headers?.get?.('X-GEV-Voice-Tier') || null,
        transcribeModel:
          response.headers?.get?.('X-GEV-Voice-Transcribe-Model') || null,
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
        throw new Error(t('voice.backend.secretExpired'));
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
        throw new Error(
          t('voice.backend.sdpFailed', { status: response.status }),
        );
      }
      const answer = await response.text();
      signal.throwIfAborted();
      return answer;
    },
  });
}
