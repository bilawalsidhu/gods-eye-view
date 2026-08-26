/**
 * useVoiceCommands — hook exposing the OpenAI voice controller from React.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVC(): any { return ((window as any).__gevVoiceCommands) ?? null; }

export function useVoiceCommands() {
  return { voiceCommands: getVC() };
}
