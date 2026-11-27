import { normalizeDisplayText } from '../data/displayText.js';
import { t } from '../i18n/index.js';

/**
 * Feed text (a callsign, a vessel's name) as the model reads it: one line,
 * control characters replaced by spaces, and the bidi and zero-width format
 * characters that could reorder or hide what it says dropped.
 */
const itemText = (value, maxLength) =>
  normalizeDisplayText(
    String(value ?? '').replace(
      /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      '',
    ),
    maxLength,
  );

/**
 * Draft-only attachments, held on the voice control presenter. Providers
 * receive text only when the person sends.
 */
export function bindChatAttachments({ ui, dataManager, onChange, setStatus }) {
  const items = new Map();
  const queued = new Map();
  let reading = false;
  let locked = false;
  let disposed = false;
  const publish = (patch = {}) =>
    ui.update('chat', {
      attachments: [...items].map(([key, item]) => ({ key, name: item.name })),
      locked,
      ...patch,
    });
  function close() {
    ui.update('chat', { attachMenuOpen: false });
  }
  function add(key, item) {
    if (!items.has(key) && items.size >= 4)
      throw new Error(t('You can attach up to four items.'));
    const others = [...items].filter(([id]) => id !== key);
    if (
      others.reduce(
        (total, [, value]) => total + JSON.stringify(value).length,
        0,
      ) +
        JSON.stringify(item).length >
      10000
    )
      throw new Error(
        t('Attachments are too large together. Use smaller files.'),
      );
    items.set(key, item);
    publish();
    onChange();
  }
  function attachItem(item, { focus = true } = {}) {
    try {
      add(`item:${item.key}`, {
        kind: 'map-item',
        name:
          itemText(item.name, 120) ||
          itemText(item.itemKind, 60) ||
          t('Unknown'),
        itemKind: itemText(item.itemKind, 60),
        layer: itemText(item.layer, 80),
        ...(typeof item.resolveLocation === 'function'
          ? { resolveLocation: item.resolveLocation }
          : {}),
      });
      close();
      if (focus) void ui.focus(['chatInput']);
    } catch (error) {
      setStatus(error.message);
    }
  }
  const offs = [
    ui.on('chat-attach-toggle', () => {
      if (locked) return;
      const open = !ui.state.chat.attachMenuOpen;
      publish({
        attachMenuOpen: open,
        layers: [...(dataManager?.layers || [])].map(([id, entry]) => ({
          value: id,
          label: entry.module.name || id,
        })),
      });
      if (open) void ui.focus(['chatLayer']);
    }),
    ui.on('chat-layer', (id) => {
      if (locked || !id) return;
      const entry = dataManager?.layers?.get(id);
      if (!entry) return;
      try {
        add(`layer:${id}`, {
          kind: 'map-layer',
          id,
          name: entry.module.name || id,
        });
        close();
        void ui.focus(['chatInput']);
      } catch (error) {
        setStatus(error.message);
      }
    }),
    // The card's Ask icon: the picked item, attached to the draft so the
    // person asks their own question about it. Nothing is sent yet.
    ui.on('chat-item', (item) => {
      if (!item?.key) return;
      if (locked) queued.set(item.key, item);
      else attachItem(item);
    }),
    // Escape closes the menu and returns to its Attach button.
    ui.on('chat-attach-keydown', (event) => {
      if (event.key !== 'Escape' || !ui.state.chat.attachMenuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      ui.element('chatPanel')?.querySelector?.('#gev-chat-attach')?.focus?.();
    }),
    ui.on('chat-file-button', () => {
      if (!locked) ui.element('chatFile')?.click();
    }),
    ui.on('chat-files', async (fileInput) => {
      if (reading || locked) return;
      const files = [...(fileInput?.files || [])];
      reading = true;
      onChange();
      try {
        for (const file of files) {
          if (!/\.(txt|md|csv|json|geojson)$/i.test(file.name))
            throw new Error(
              t('Choose a TXT, Markdown, CSV, JSON or GeoJSON file.'),
            );
          if (file.size > 10000)
            throw new Error(t('Each file must be 10 KB or smaller.'));
          const bytes = await file.arrayBuffer();
          if (disposed) return;
          let content = '';
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            // Not UTF-8: the decoder's own message is not the person's words.
          }
          if (!content.trim() || /[\u0000-\u0008\u000e-\u001f]/.test(content))
            throw new Error(t('Choose a non-empty UTF-8 text file.'));
          add(`file:${file.name}`, { kind: 'file', name: file.name, content });
        }
        close();
        void ui.focus(['chatInput']);
      } catch (error) {
        if (!disposed) setStatus(error.message);
      } finally {
        reading = false;
        if (!disposed) {
          if (fileInput) fileInput.value = '';
          onChange();
        }
      }
    }),
    ui.on('chat-attachment-remove', (key) => {
      if (locked || !items.delete(key)) return;
      publish();
      onChange();
    }),
  ];
  return {
    setLocked(value) {
      if (locked === Boolean(value)) return;
      locked = Boolean(value);
      publish(locked ? { attachMenuOpen: false } : {});
      if (!locked) {
        const waiting = [...queued.values()];
        queued.clear();
        for (const item of waiting) attachItem(item, { focus: false });
      }
    },
    get hasDraftAttachments() {
      return reading || items.size > 0 || queued.size > 0;
    },
    get reading() {
      return reading;
    },
    close,
    snapshot({ resolveLocations = false } = {}) {
      const result = [...items.values()].map(({ resolveLocation, ...item }) => {
        if (item.kind === 'map-layer')
          return {
            ...item,
            enabled: Boolean(dataManager?.isEnabled?.(item.id)),
          };
        if (resolveLocations && resolveLocation) {
          try {
            const fresh = resolveLocation();
            if (fresh)
              return {
                ...item,
                ...fresh,
                name: itemText(fresh.name, 120) || item.name,
              };
          } catch {
            // Keep the named attachment if its current position is unavailable.
          }
        }
        return item;
      });
      for (const [index, item] of result.entries()) {
        if (
          item.kind === 'map-item' &&
          result.some(
            (other) =>
              other !== item &&
              other.kind === item.kind &&
              other.layer === item.layer &&
              other.itemKind === item.itemKind &&
              other.name === item.name,
          )
        )
          item.attachmentNumber = index + 1;
      }
      return result;
    },
    clear() {
      items.clear();
      publish({ attachMenuOpen: false });
    },
    destroy() {
      disposed = true;
      queued.clear();
      for (const off of offs) off();
    },
  };
}
