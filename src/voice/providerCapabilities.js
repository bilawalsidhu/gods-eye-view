export const VOICE_PROVIDER_GUIDANCE =
  'I can’t switch voice providers directly. Hover over the Voice panel and use the provider dropdown.';
export const HOST_VOICE_PROVIDER_GUIDANCE =
  'I can’t switch voice providers directly. Provider selection is managed by this app.';

/** Host construction decides which controls exist; tool text cannot add one. */
export function voiceProviderGuidance({ providerDropdown = false } = {}) {
  return providerDropdown === true
    ? VOICE_PROVIDER_GUIDANCE
    : HOST_VOICE_PROVIDER_GUIDANCE;
}

export const VOICE_PROVIDERS = Object.freeze({
  openai: Object.freeze({ label: 'OpenAI' }),
  gemini: Object.freeze({ label: 'Gemini' }),
});

/** Optional providers require an explicit host opt-in and an available factory. */
export function supportedVoiceProviders(
  requested = ['openai'],
  factories = {},
) {
  if (!Array.isArray(requested))
    throw new TypeError('supportedProviders must be an array');
  const selected = [...new Set(requested)].filter(
    (name) =>
      Object.hasOwn(VOICE_PROVIDERS, name) &&
      typeof factories[name] === 'function',
  );
  if (!selected.length)
    throw new Error('No supported voice provider is configured');
  return Object.freeze(selected);
}
