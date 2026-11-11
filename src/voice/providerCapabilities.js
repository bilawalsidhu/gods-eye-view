export const VOICE_PROVIDERS = Object.freeze({
  openai: Object.freeze({ label: 'OpenAI' }), // i18n-ignore: provider product name
  gemini: Object.freeze({ label: 'Gemini' }), // i18n-ignore: provider product name
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
