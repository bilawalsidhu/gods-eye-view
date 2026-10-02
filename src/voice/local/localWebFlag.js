export const LOCAL_WEB_VOICE = 'local-web';

/** Whether the page asked for the in-browser voice tier (?voice=local-web). */
export function localWebVoiceRequested(search = globalThis.location?.search) {
  try {
    return new URLSearchParams(search || '').get('voice') === LOCAL_WEB_VOICE;
  } catch {
    return false;
  }
}
