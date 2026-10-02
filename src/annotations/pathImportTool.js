/**
 * Path import and board export: the DOM half.
 *
 * DISPLAY ▸ Draw ▸ Import puts a person's own GPX, KML or GeoJSON file on the
 * whiteboard, and Export saves what is on the board as GeoJSON. Every imported
 * feature goes through the SAME `annotationEngine.annotate()` Draw and the
 * voice agent use (`manual: true`, geometry supplied), so an imported track is
 * a whiteboard mark like any other: it renders draped, de-dups, shows up in
 * `.list()`, and clears with the board.
 *
 * What this adds on top is the FILE as a unit. Each import is remembered with
 * the specs it produced and the mark ids the engine gave back, so one file can
 * be hidden, shown again, or removed without touching anything else on the
 * board:
 *
 * - Hide removes the file's marks from the engine and keeps its specs; Show
 *   annotates them again. The engine has no per-mark visibility and does not
 *   need one for this.
 * - Only marks this file actually CREATED are tracked. If a feature duplicates
 *   a mark already on the board the engine returns the existing mark, and
 *   removing the file must not take away something the person drew by hand.
 * - The board can be cleared from elsewhere (Draw's Clear, the voice agent's
 *   `clear_annotations`). The file list is reconciled against the engine
 *   before it is acted on, so it never offers to hide marks that are gone.
 *
 * Nothing is uploaded: the file is read in the page with `File.text()` and
 * parsed by `pathImport.js`. No Cesium here; the pure half is `pathImport.js`
 * and `pathExport.js`.
 */
import {
  MAX_IMPORT_CHARS,
  PathImportError,
  featuresToSpecs,
  importSummary,
  readPathFile,
} from './pathImport.js';
import { annotationsToGeoJson, exportFileName } from './pathExport.js';

/** Files remembered at once. Each can hold up to 60 marks of the board's 120. */
export const MAX_IMPORTED_FILES = 12;
/**
 * Refused before reading, by byte size. UTF-8 spends at most three bytes per
 * UTF-16 code unit, so a file past this cannot be under the character ceiling
 * `readPathFile` enforces, and there is no reason to pull it into memory to
 * find that out.
 */
const MAX_IMPORT_BYTES = MAX_IMPORT_CHARS * 3;
const COLORS = ['primary', 'amber', 'cyan', 'green', 'red'];

/**
 * Wire the Import / Export controls. Returns a handle with a `destroy()` the
 * application lifetime owns, plus the console/test seam
 * (`window.__gevPathImport`).
 * @param {{
 *   annotations: {annotate: Function, remove: Function, list: Function},
 *   saveFile?: (name: string, text: string) => void,
 * }} deps `saveFile` replaces the browser download in tests.
 * @returns {{destroy: Function}|null}
 */
export function initPathImportTool({ annotations, saveFile = downloadText }) {
  const importButton = document.getElementById('draw-import');
  const exportButton = document.getElementById('draw-export');
  const fileInput = document.getElementById('draw-import-input');
  const colorSelect = document.getElementById('draw-color-select');
  const clearButton = document.getElementById('draw-clear');
  const row = document.getElementById('draw-import-row');
  const status = document.getElementById('draw-import-status');
  const list = document.getElementById('draw-import-list');
  if (!annotations || !importButton || !fileInput) return null;

  let destroyed = false;
  let sequence = 0;
  // Bumped by teardown, so an import still reading or annotating when the tool
  // is destroyed cannot write its outcome into a list that no longer exists.
  let generation = 0;
  /** @type {Array<{id: number, fileName: string, summary: string, specs: object[], ids: string[], hidden: boolean}>} */
  const files = [];
  const domListeners = [];
  const listen = (target, type, listener, options) => {
    if (!target) return;
    target.addEventListener(type, listener, options);
    domListeners.push([target, type, listener, options]);
  };

  const setStatus = (text) => {
    if (status) status.textContent = text || '';
    syncRow();
  };
  function syncRow() {
    row?.classList.toggle(
      'visible',
      files.length > 0 || Boolean(status?.textContent),
    );
  }

  // ---- the file list ---------------------------------------------------
  function render() {
    if (!list) return;
    list.replaceChildren(
      ...files.map((file) => {
        const item = document.createElement('li');
        item.className = 'draw-import-item';
        item.classList.toggle('is-hidden', file.hidden);
        item.dataset.fileId = String(file.id);

        const name = document.createElement('span');
        name.className = 'draw-import-name';
        name.textContent = file.fileName;
        name.title = file.summary;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pp-mode-btn draw-file-btn';
        toggle.dataset.action = 'toggle';
        toggle.textContent = file.hidden ? 'Show' : 'Hide';
        toggle.setAttribute('aria-pressed', String(file.hidden));
        toggle.setAttribute(
          'aria-label',
          `${file.hidden ? 'Show' : 'Hide'} ${file.fileName}`,
        );

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'pp-mode-btn draw-file-btn';
        remove.dataset.action = 'remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${file.fileName}`);

        item.append(name, toggle, remove);
        return item;
      }),
    );
    syncRow();
  }

  /**
   * Drop files whose marks were cleared from somewhere else. A hidden file has
   * no marks on the board by design and is kept.
   * @returns {boolean} whether anything was dropped
   */
  function reconcile() {
    const live = new Set((annotations.list?.() || []).map((anno) => anno.id));
    let dropped = false;
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const file = files[i];
      if (file.hidden) continue;
      file.ids = file.ids.filter((id) => live.has(id));
      if (!file.ids.length) {
        files.splice(i, 1);
        dropped = true;
      }
    }
    if (dropped) render();
    return dropped;
  }

  /** Put a file's specs on the board; record only the marks it created. */
  async function place(file) {
    const result = await annotations.annotate(file.specs, {
      persist: true,
      flyTo: false,
    });
    const created = [];
    let duplicates = 0;
    let failed = 0;
    for (const entry of result?.results || []) {
      if (!entry?.ok) failed += 1;
      else if (entry.duplicate) duplicates += 1;
      else if (entry.id) created.push(entry.id);
    }
    file.ids = created;
    return { created: created.length, duplicates, failed };
  }

  // ---- import ----------------------------------------------------------
  async function importOne(source, attempt) {
    const fileName = String(source?.name || 'file');
    if (files.length >= MAX_IMPORTED_FILES)
      throw new PathImportError(
        'too-many-files',
        `${MAX_IMPORTED_FILES} files are already imported. Remove one first.`,
      );
    if (Number(source?.size) > MAX_IMPORT_BYTES)
      throw new PathImportError(
        'too-large',
        `${fileName} is too large to import.`,
      );
    const text = await source.text();
    const read = readPathFile({ name: fileName, text });
    const color = COLORS.includes(colorSelect?.value)
      ? colorSelect.value
      : 'primary';
    const file = {
      id: (sequence += 1),
      fileName,
      summary: importSummary(read),
      specs: featuresToSpecs(read.features, { color }),
      ids: [],
      hidden: false,
    };
    const placed = await place(file);
    // Cleared or torn down while this was in flight: the list was emptied on
    // purpose, and a late entry must not reappear in it.
    if (destroyed || attempt !== generation) return null;
    let message = file.summary;
    if (placed.duplicates)
      message += ` · ${placed.duplicates} already on the board`;
    if (placed.failed)
      message += ` · ${placed.failed} not placed (the board is full)`;
    if (!placed.created) {
      // Nothing of this file's own is on the board, so there is nothing for a
      // list entry to hide or remove.
      return placed.duplicates && !placed.failed
        ? `${fileName} is already on the board.`
        : `Could not place ${fileName}: the board is full. Clear some marks first.`;
    }
    files.push(file);
    return message;
  }

  /**
   * Import every file in order. One file's refusal does not stop the next.
   * @param {Iterable<{name: string, size?: number, text: Function}>} sources
   * @returns {Promise<string[]>} One status line per file.
   */
  async function importFiles(sources) {
    if (destroyed) return [];
    const attempt = generation;
    reconcile();
    const messages = [];
    for (const source of Array.from(sources || [])) {
      let message;
      try {
        message = await importOne(source, attempt);
      } catch (error) {
        message =
          error instanceof PathImportError
            ? `${source?.name || 'File'}: ${error.message}`
            : `Could not read ${source?.name || 'the file'}.`;
      }
      if (destroyed || attempt !== generation) return messages;
      messages.push(message);
      render();
      setStatus(messages.join(' '));
    }
    return messages;
  }

  // ---- per-file actions --------------------------------------------------
  const fileById = (id) => files.find((file) => file.id === Number(id)) || null;

  async function setHidden(id, hidden) {
    reconcile();
    const file = fileById(id);
    if (destroyed || !file || file.hidden === Boolean(hidden)) return false;
    const attempt = generation;
    if (hidden) {
      annotations.remove(file.ids);
      file.ids = [];
      file.hidden = true;
      render();
      setStatus(`${file.fileName} hidden.`);
      return true;
    }
    file.hidden = false;
    const placed = await place(file);
    if (destroyed || attempt !== generation) return false;
    if (!placed.created) {
      file.hidden = true;
      render();
      setStatus(
        `Could not show ${file.fileName}: the board is full. Clear some marks first.`,
      );
      return false;
    }
    render();
    setStatus(`${file.fileName} shown.`);
    return true;
  }

  function removeFile(id) {
    reconcile();
    const index = files.findIndex((file) => file.id === Number(id));
    if (destroyed || index < 0) return false;
    const [file] = files.splice(index, 1);
    if (file.ids.length) annotations.remove(file.ids);
    render();
    setStatus(`${file.fileName} removed.`);
    return true;
  }

  // ---- export ----------------------------------------------------------
  function exportBoard() {
    if (destroyed) return null;
    const { geojson, exported, skipped } = annotationsToGeoJson(
      annotations.list?.() || [],
    );
    if (!exported) {
      setStatus('Nothing on the board to export.');
      return null;
    }
    const name = exportFileName();
    try {
      saveFile(name, `${JSON.stringify(geojson, null, 2)}\n`);
    } catch {
      setStatus('Could not save the export.');
      return null;
    }
    setStatus(
      `Exported ${exported} mark${exported === 1 ? '' : 's'} to ${name}${
        skipped ? ` · ${skipped} skipped (arrows and labels)` : ''
      }`,
    );
    return { name, exported, skipped };
  }

  // ---- wiring ------------------------------------------------------------
  listen(importButton, 'click', () => fileInput.click());
  listen(fileInput, 'change', () => {
    const chosen = Array.from(fileInput.files || []);
    // Reset first, so choosing the same file again fires `change` again.
    fileInput.value = '';
    if (chosen.length) void importFiles(chosen);
  });
  listen(exportButton, 'click', exportBoard);
  listen(list, 'click', (event) => {
    const button = event.target?.closest?.('button[data-action]');
    const item = button?.closest?.('.draw-import-item');
    if (!button || !item) return;
    const id = item.dataset.fileId;
    if (button.dataset.action === 'remove') removeFile(id);
    else void setHidden(id, !fileById(id)?.hidden);
  });
  // Draw's Clear wipes the board, and "clear" means the files too: a hidden
  // file that came back on Show after a Clear would be a mark the person had
  // just removed.
  listen(clearButton, 'click', () => {
    if (!files.length) return;
    generation += 1;
    files.length = 0;
    render();
    setStatus('');
  });
  // Marks can also be cleared by voice. Catch up as soon as the person comes
  // back to the list, before a stale entry can be acted on.
  listen(list, 'pointerenter', reconcile);
  listen(list, 'focusin', reconcile);

  const api = {
    importFiles,
    /** Test seam: import from text without a File. */
    importText(name, text) {
      return importFiles([{ name, size: text.length, text: async () => text }]);
    },
    setHidden,
    removeFile,
    exportBoard,
    reconcile,
    /** The remembered files, newest last — a copy, safe to inspect. */
    get files() {
      return files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        summary: file.summary,
        hidden: file.hidden,
        marks: file.ids.length,
      }));
    },
    /** What this tool currently holds — for teardown and leak assertions. */
    diagnostics() {
      return {
        destroyed,
        files: files.length,
        domListeners: domListeners.length,
      };
    },
    destroy() {
      if (destroyed) return;
      generation += 1;
      destroyed = true;
      for (const [target, type, listener, options] of domListeners.splice(0))
        target.removeEventListener(type, listener, options);
      // The marks stay with the engine, which the application disposes after
      // this tool; only the list this tool drew is taken down.
      files.length = 0;
      list?.replaceChildren();
      if (status) status.textContent = '';
      row?.classList.remove('visible');
      if (window.__gevPathImport === api) delete window.__gevPathImport;
    },
  };
  window.__gevPathImport = api;
  return api;
}

/** Hand a text file to the browser's download flow. */
function downloadText(name, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/geo+json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a later tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
