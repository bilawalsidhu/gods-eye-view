/**
 * Observable snapshot of the on-device voice provider: selected and loaded
 * models, load progress, device support and the last exchange. The session
 * adapter writes it; the voice tray renders it.
 */
export function createLocalVoiceStore(initial = {}) {
  let state = {
    phase: 'idle',
    llm: null,
    stt: null,
    tts: 'kokoro',
    loadedLlm: null,
    loadedStt: null,
    progress: {},
    support: null,
    message: null,
    microphone: 'unknown',
    storageNote: null,
    storageMessage: null,
    clearing: false,
    lastUser: null,
    lastReply: null,
    ...initial,
  };
  const listeners = new Set();
  return {
    getState: () => state,
    update(patch) {
      const next = { ...state, ...patch };
      if (Object.keys(patch).every((key) => Object.is(next[key], state[key])))
        return state;
      state = next;
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch {
          /* observers cannot break the provider */
        }
      }
      return state;
    },
    /** Records progress for one component (llm, stt or tts). */
    progress(key, event) {
      return this.update({
        progress: event
          ? { ...state.progress, [key]: event }
          : Object.fromEntries(
              Object.entries(state.progress).filter(([name]) => name !== key),
            ),
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
}
