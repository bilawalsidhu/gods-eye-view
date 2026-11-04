import { t } from '../i18n/index.js';

/**
 * Chat suggestions and the one chat preference (quick commands), written to
 * the voice control presenter. Recent commands and autocomplete are always on;
 * command history is deliberately transient.
 */
export function bindChatPreferences({ ui, getDraft, setDraft }) {
  const key = 'gev.chat.preferences';
  let quick = true;
  let recent = [];
  let historyIndex = -1;
  let saved = '';
  const resetHistory = () => {
    historyIndex = -1;
    saved = '';
  };
  const quickCommands = () =>
    [
      'Fly to Tokyo',
      'Show live flights',
      'Reset to globe view',
      'Show earthquakes',
    ].map((text) => t(text));
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    if (typeof stored?.quick === 'boolean') quick = stored.quick;
  } catch {
    /* Storage is optional. */
  }
  function render() {
    const draft = getDraft();
    if (historyIndex >= 0 && draft !== recent[historyIndex]) resetHistory();
    const query = draft.trim().toLowerCase();
    const groups = [];
    if (query) {
      const candidates = [...recent, ...(quick ? quickCommands() : [])];
      groups.push({
        label: t('Suggestions'),
        items: [...new Set(candidates)]
          .filter(
            (text) =>
              text.toLowerCase().includes(query) &&
              text.toLowerCase() !== query,
          )
          .slice(0, 4),
      });
    } else {
      groups.push({ label: t('Recent'), items: recent.slice(0, 3) });
      if (quick)
        groups.push({
          label: t('Quick commands'),
          items: quickCommands().slice(0, 3),
        });
    }
    ui.update('chat', {
      quickChecked: quick,
      suggestions: groups.filter((group) => group.items.length),
    });
  }
  const offLocale = ui.on('locale', render);
  render();
  return {
    render,
    setQuick(value) {
      quick = Boolean(value);
      try {
        localStorage.setItem(key, JSON.stringify({ quick }));
      } catch {
        /* Storage is optional. */
      }
      render();
    },
    remember(text) {
      resetHistory();
      recent = [text, ...recent.filter((entry) => entry !== text)].slice(0, 8);
      render();
    },
    /**
     * Up and Down recall earlier messages from the start of the input, and
     * restore the unsent draft. Returns whether the key was used.
     * @param {KeyboardEvent} event
     */
    keydown(event) {
      const input = event.target;
      if (
        !['ArrowUp', 'ArrowDown'].includes(event.key) ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        input?.selectionStart !== input?.selectionEnd ||
        !recent.length
      )
        return false;
      const up = event.key === 'ArrowUp';
      // Keep history navigation at the start of recalled text. Moving the
      // caret into a message returns arrow keys to native textarea editing.
      if (input.selectionStart !== 0 || (!up && historyIndex < 0)) return false;
      event.preventDefault();
      if (up) {
        if (historyIndex < 0) saved = getDraft();
        historyIndex = Math.min(historyIndex + 1, recent.length - 1);
      } else historyIndex--;
      const next = historyIndex < 0 ? saved : recent[historyIndex];
      setDraft(next, { caret: historyIndex < 0 ? next.length : 0 });
      render();
      return true;
    },
    destroy: offLocale,
  };
}
