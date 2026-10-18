/**
 * The language a voice session speaks: the interface language, when it is a
 * shipped locale other than English. Both the server (session instructions,
 * caption language) and the client (tool follow-up instructions, which
 * replace the session's for that response) read it from here, so the two
 * cannot drift.
 */

import { DEFAULT_LOCALE, LOCALES } from '../i18n/locale.js';

/**
 * A shipped non-English locale code, or null: English, an unshipped code or
 * any other value. Total, like resolveVoiceModel: a hostile ?lang= resolves
 * to null and the session simply stays English.
 * @param {unknown} code
 * @returns {string|null}
 */
export function resolveVoiceLanguage(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toLowerCase();
  return normalized !== DEFAULT_LOCALE && LOCALES.includes(normalized)
    ? normalized
    : null;
}

/** The language's English name ("Japanese"), or '' when Intl cannot name it. */
function englishName(code) {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? name : '';
  } catch {
    return '';
  }
}

/**
 * The instruction that makes the model speak the interface language, or ''
 * for an English (or unresolved) session. Tool results stay English data;
 * the model voices them in the session language without changing facts.
 * @param {unknown} code
 * @returns {string}
 */
export function voiceLanguageInstruction(code) {
  const language = resolveVoiceLanguage(code);
  const name = language && englishName(language);
  if (!name) return '';
  return `LANGUAGE: the interface is in ${name}. Speak ${name}, unless the user speaks another language; then answer in theirs. Say lines and other tool result text are English data: say them in ${name} without adding, dropping or changing facts, and keep numbers, units, callsigns, airport codes and other codes exactly as returned. Tool names and arguments stay as defined.`;
}
