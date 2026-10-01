const STORAGE_KEY = 'gev.voice.provider';

export function readVoiceProvider(storage) {
  try {
    return (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY) ===
      'gemini'
      ? 'gemini'
      : 'openai';
  } catch {
    return 'openai';
  }
}

/** Keep one public controller identity while replacing each provider's lifetime. */
export function createProviderCommands(options, { bind, factories, storage }) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  let provider = readVoiceProvider(storage);
  let current;
  let disposed = Boolean(options.signal?.aborted);
  let pendingProvider = null;
  const stored = () => {
    try {
      return storage ?? globalThis.localStorage;
    } catch {
      return null;
    }
  };
  const stop = (settings = {}) => {
    if (settings.removeUi) {
      disposed = true;
      options.signal?.removeEventListener('abort', destroy);
    }
    current?.session.stop(settings);
  };
  const destroy = () => stop({ removeUi: true });
  const selectProvider = (next) => {
    if (disposed || !Object.hasOwn(factories, next) || next === provider)
      return false;
    pendingProvider = null;
    const voiceSettingsOpen = current?.ui?.voiceSettingsPanel?.hidden === false;
    current.session.destroy();
    provider = next;
    try {
      stored()?.setItem(STORAGE_KEY, provider);
    } catch {
      /* Storage is optional. */
    }
    mount({ voiceSettingsOpen });
    globalThis.document?.getElementById('gev-voice-provider')?.focus();
    return true;
  };
  const requestProviderChange = (next) => {
    const previousProvider = provider;
    if (disposed || !Object.hasOwn(factories, next))
      return {
        ok: false,
        changed: false,
        pending: false,
        previousProvider,
        error: `Unknown voice provider: ${next || 'missing'}`,
      };
    if (next === provider) {
      pendingProvider = null;
      return {
        ok: true,
        changed: false,
        pending: false,
        previousProvider,
      };
    }
    if (current?.session?.isActive()) {
      pendingProvider = next;
      return {
        ok: true,
        changed: true,
        pending: true,
        previousProvider,
      };
    }
    return {
      ok: true,
      changed: selectProvider(next),
      pending: false,
      previousProvider,
    };
  };
  const handleSessionEvent = (event) => {
    if (!pendingProvider) return;
    if (
      event?.type === 'completion' ||
      (event?.type === 'state' && ['idle', 'error'].includes(event.state))
    ) {
      const next = pendingProvider;
      pendingProvider = null;
      selectProvider(next);
    }
  };
  const api = {
    // The shared action surface is independent of an active voice connection.
    runner: options.runner,
    get provider() {
      return provider;
    },
    get session() {
      return current?.session;
    },
    get status() {
      return current?.status ?? current?.session.state ?? 'idle';
    },
    get state() {
      return current?.session.state ?? 'idle';
    },
    get disposed() {
      return disposed;
    },
    start: (settings) => !disposed && current.session.start(settings),
    stop,
    destroy,
    isActive: () => !disposed && current.session.isActive(),
    sendTextCommand: (text) => !disposed && current.session.sendText(text),
    sendText: (text) => !disposed && current.session.sendText(text),
    notifyMapEvent: (event) => !disposed && current.session.sendMapEvent(event),
    setVoiceSettingsOpen: (open) =>
      !disposed && current?.setVoiceSettingsOpen?.(open),
    setVoiceInactivityMinutes: (minutes) =>
      !disposed && current?.setVoiceInactivityMinutes?.(minutes),
    getVoiceInactivityMinutes: () =>
      !disposed ? current?.getVoiceInactivityMinutes?.() : undefined,
    setProvider: selectProvider,
    requestProviderChange,
  };
  // Existing diagnostic and controller accessors continue to reflect the active provider.
  const facade = new Proxy(api, {
    get(target, name, receiver) {
      if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
      const value = current?.[name];
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  function mount({ voiceSettingsOpen = false } = {}) {
    current = bind({
      ...options,
      resetExisting: false,
      provider,
      onProviderChange: selectProvider,
      onSessionEvent: handleSessionEvent,
      storage: stored(),
      voiceSettingsOpen,
      createSession: factories[provider],
    });
    window.__gevVoiceCommands = facade;
  }
  mount();
  options.signal?.addEventListener('abort', destroy, { once: true });
  if (disposed) destroy();
  return facade;
}
