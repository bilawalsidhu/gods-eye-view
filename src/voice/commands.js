import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createNvidiaSession } from './nvidiaSession.js';

/** Probe the server once and cache the result. */
let nvidiaStatusCache = null;
async function isNvidiaConfigured() {
  if (nvidiaStatusCache !== null) return nvidiaStatusCache;
  try {
    const res = await fetch('/api/nvidia/status');
    const data = await res.json();
    nvidiaStatusCache = Boolean(data?.configured);
  } catch {
    nvidiaStatusCache = false;
  }
  return nvidiaStatusCache;
}

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  const defaultAdapterFactory = (hooks) => {
    // If caller explicitly picked nvidia, use it directly
    if (options?.provider === 'nvidia') {
      return createNvidiaSession(hooks);
    }

    // Build wrapper that tries OpenAI first, then falls back to NVIDIA
    const realtimeSession = createRealtimeSession(hooks);
    const originalStart = realtimeSession.start;

    realtimeSession.start = async (settings) => {
      // Check NVIDIA status first so we can skip OpenAI entirely if only NVIDIA is configured
      const nvidiaReady = await isNvidiaConfigured();

      // If there's no OPENAI_API_KEY, the realtime token endpoint will 503.
      // Skip straight to NVIDIA if it's available.
      try {
        const tokenCheck = await fetch('/api/realtime/token');
        if (!tokenCheck.ok && nvidiaReady) {
          // OpenAI not configured — go directly to NVIDIA
          const nvidia = createNvidiaSession(hooks);
          // Replace adapter methods on the wrapper so sessionCommands stays connected
          Object.assign(realtimeSession, nvidia);
          realtimeSession.capabilities = nvidia.capabilities;
          return nvidia.start(settings);
        }
      } catch {
        if (nvidiaReady) {
          const nvidia = createNvidiaSession(hooks);
          Object.assign(realtimeSession, nvidia);
          realtimeSession.capabilities = nvidia.capabilities;
          return nvidia.start(settings);
        }
      }

      // OpenAI looks available — try it
      try {
        return await originalStart(settings);
      } catch (err) {
        // OpenAI failed at runtime — fall back to NVIDIA
        if (nvidiaReady) {
          const nvidia = createNvidiaSession(hooks);
          Object.assign(realtimeSession, nvidia);
          realtimeSession.capabilities = nvidia.capabilities;
          return nvidia.start(settings);
        }
        throw err;
      }
    };
    return realtimeSession;
  };

  return bindVoiceCommands({
    createSession: options?.createSession || defaultAdapterFactory,
    ...options,
  });
}
