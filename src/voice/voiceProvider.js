export const VOICE_PROVIDER_STORAGE_KEY = 'godsEyeView.voice.provider';
export const VOICE_PROVIDERS = Object.freeze(['openai', 'gemini']);
const LABELS = Object.freeze({ openai: 'OPENAI', gemini: 'GEMINI' });

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** The remembered voice provider; OpenAI unless this browser chose Gemini. */
export function readVoiceProvider(store = storage()) {
  try {
    const value = store?.getItem(VOICE_PROVIDER_STORAGE_KEY);
    return VOICE_PROVIDERS.includes(value) ? value : 'openai';
  } catch {
    return 'openai';
  }
}

export function writeVoiceProvider(value, store = storage()) {
  if (!VOICE_PROVIDERS.includes(value)) return;
  try {
    store?.setItem(VOICE_PROVIDER_STORAGE_KEY, value);
  } catch {
    /* Private windows may refuse storage; the switch still applies now. */
  }
}

export function nextVoiceProvider(current) {
  return current === 'gemini' ? 'openai' : 'gemini';
}

/** Show the active provider on the control and rebuild voice on a switch. */
export function bindVoiceProviderToggle({
  root,
  provider,
  onSwitch,
  store = storage(),
}) {
  const button = root?.querySelector?.('#gev-voice-provider');
  if (!button) return;
  const next = nextVoiceProvider(provider);
  button.hidden = false;
  button.textContent = LABELS[provider];
  button.dataset.provider = provider;
  button.setAttribute(
    'aria-label',
    `Voice provider ${LABELS[provider]} — activate to switch to ${LABELS[next]}`,
  );
  button.title = `Voice provider: ${LABELS[provider]} — click to switch to ${LABELS[next]}`;
  button.addEventListener('click', () => {
    writeVoiceProvider(next, store);
    onSwitch(next);
  });
}
