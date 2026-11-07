import { getLocale } from '../i18n/index.js';

const segmenters = new Map();
const segmenter = (locale) => {
  if (!segmenters.has(locale))
    segmenters.set(
      locale,
      new Intl.Segmenter(locale, { granularity: 'sentence' }),
    );
  return segmenters.get(locale);
};

/** The final sentence of a transcript, split by the active locale's rules. */
export function lastSentence(text, locale = getLocale()) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  let parts;
  try {
    parts = [...segmenter(locale).segment(clean)].map((part) =>
      part.segment.trim(),
    );
  } catch {
    parts = clean.split(/(?<=[.!?。！？])\s+/);
  }
  return parts.filter(Boolean).at(-1) ?? clean;
}

/**
 * Keep the minimized voice bar's preview: the last spoken sentence from the
 * user and from the assistant. Typed chat turns belong to the chat panel.
 * Once either side has spoken, the root marks the exchange so the empty
 * preview's "Try saying" hints step aside until the next session.
 */
export function bindVoiceMiniPreview({ ui, session }) {
  let assistant = '';
  let response = null;
  const sentences = { user: '', assistant: '' };
  const show = (role, text) => {
    sentences[role] = lastSentence(text);
    ui.update('mini', { [role]: sentences[role] });
    const spoken = Boolean(sentences.user || sentences.assistant);
    if (ui.state.root.voiceExchange !== spoken)
      ui.update('root', { voiceExchange: spoken });
  };
  const clear = () => {
    assistant = '';
    response = null;
    show('user', '');
    show('assistant', '');
  };
  clear();
  return session.subscribe((event) => {
    // Any new session starts empty, even one whose start is still reported
    // as typed chat while voice takes over.
    if (event.type === 'state' && event.state === 'connecting') clear();
    if (session.adapter?.getStartOptions?.().textOnly) return;
    if (event.type !== 'transcript' || !event.text) return;
    if (event.role === 'user') show('user', event.text);
    if (event.role !== 'assistant') return;
    const id = event.responseId || null;
    // Deltas accumulate per response; a final transcript replaces them.
    assistant = event.final
      ? event.text
      : `${id === response ? assistant : ''}${event.text}`;
    response = id;
    show('assistant', assistant);
  });
}
