function buildSetting() {
  try {
    // Replaced at build time (build/vite.js); undefined outside Vite.
    return import.meta.env.GEV_NATURAL_VOICE;
  } catch {
    return undefined;
  }
}

/**
 * Whether this build offers natural (Kokoro) voice. GEV_NATURAL_VOICE=off
 * (or 0, false, no) removes it; replies then use the browser's on-device
 * voices or text.
 */
export function naturalVoiceAvailable(value = buildSetting()) {
  return !/^(off|0|false|no)$/i.test(String(value ?? '').trim());
}
