/** What the file import's parsing and drawing parts share: its error, its limits, its deadline and feature names. */
import { msg } from '../i18n/marker.js';

/** Most entities one file may create before it is refused. */
export const MAX_IMPORT_ENTITIES = 20_000;
/** Longest plain-text name kept from a file's features. */
const MAX_IMPORT_NAME_LENGTH = 120;

/**
 * An error whose message is meant for the person who chose the file. The
 * message stays English; `template` and `values`, when given, let the UI show
 * it in the active language. Numbers stay numbers in `values`: the UI formats
 * them in that language's numerals.
 */
export class GeoImportError extends Error {
  constructor(message, template = message, values = {}) {
    super(message);
    this.name = 'GeoImportError';
    this.template = template;
    this.values = values;
  }
}

/** A feature name as short plain text (no control characters), or undefined. */
export function importFeatureName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_IMPORT_NAME_LENGTH
    ? `${text.slice(0, MAX_IMPORT_NAME_LENGTH - 1)}…`
    : text;
}

/** `promise`, or a refusal when the import is aborted or takes over a minute. */
export async function boundedImport(promise, signal) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () =>
            reject(new GeoImportError(msg('That file took too long to read.'))),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
