/**
 * Which environment variables are credentials, and how .env.example separates them.
 *
 * Secrets live in `.env.local`; non-secret settings live in `.env`. Both files are
 * gitignored and both are read by Vite's dotenv ladder (`.env.local` wins when a
 * name is in both). This module is the ONE list of secret names and the ONE
 * parser for the template's two fenced sections — the template, the setup
 * doctor, the Provider Settings panel and their tests hold to it, so a new
 * credential cannot land in the settings file by accident.
 *
 * Pure: no Node built-ins, so the browser bundle, the server and the scripts can
 * all import it (scripts/check-import-directions.mjs). File I/O for
 * `npm run env:init` lives in scripts/env-init.mjs.
 */

/** File that holds every credential (owner-only). */
export const SECRETS_FILE = '.env.local';

/** File that holds non-secret settings. */
export const SETTINGS_FILE = '.env';

/**
 * Every environment variable that holds a credential. Optional ones are still
 * secrets once set.
 */
export const SECRET_ENV_NAMES = Object.freeze([
  // Offered by Provider Settings (KEY_SETUP_KEYS in src/keySetupCore.mjs).
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'MAPILLARY_CLIENT_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'LL2_API_TOKEN',
  // Optional, set by hand.
  'ONTARIO_511_API_KEY',
  'OTTAWA_CAMERA_CERTIFICATE',
  'GITHUB_TOKEN',
  'TFL_APP_KEY',
  'LIVEUAMAP_API_KEY',
  'WORLDNEWSAPI_KEY',
]);

const SECRET_NAMES = new Set(SECRET_ENV_NAMES);

/**
 * @param {string} name Environment variable name.
 * @returns {boolean} true when the variable holds a credential.
 */
export function isSecretEnvName(name) {
  return SECRET_NAMES.has(String(name));
}

/** Fence lines in .env.example. A fence line STARTS with its marker. */
export const ENV_TEMPLATE_FENCES = Object.freeze({
  secrets: Object.freeze({
    open: '# >>> GEV-SECRETS',
    close: '# <<< GEV-SECRETS',
  }),
  settings: Object.freeze({
    open: '# >>> GEV-SETTINGS',
    close: '# <<< GEV-SETTINGS',
  }),
});

const ASSIGNMENT = /^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

/**
 * Names assigned in dotenv text, active or commented out (`# NAME=`), in order
 * of first appearance.
 * @param {string} text Dotenv text.
 * @returns {string[]}
 */
export function envAssignmentNames(text) {
  const names = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(ASSIGNMENT);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Split .env.example into its parts by the fence lines.
 *
 * Throws when a fence is missing, appears twice, or the order is not
 * secrets-open, secrets-close, settings-open, settings-close — splitting in the
 * wrong place could send a credential to the settings file.
 *
 * @param {string} text Template text.
 * @returns {{header: string[], secrets: string[], settings: string[], trailer: string[]}}
 *   Lines; `secrets` and `settings` include their own fence lines.
 */
export function splitEnvTemplate(text) {
  const lines = String(text).split(/\r?\n/);
  const markers = [
    ENV_TEMPLATE_FENCES.secrets.open,
    ENV_TEMPLATE_FENCES.secrets.close,
    ENV_TEMPLATE_FENCES.settings.open,
    ENV_TEMPLATE_FENCES.settings.close,
  ];
  const at = markers.map((marker) => {
    const hits = [];
    lines.forEach((line, index) => {
      if (line.startsWith(marker)) hits.push(index);
    });
    if (hits.length !== 1) {
      throw new Error(
        `env template: expected exactly one "${marker}" line, found ${hits.length}`,
      );
    }
    return hits[0];
  });
  for (let i = 1; i < at.length; i += 1) {
    if (at[i] <= at[i - 1]) {
      throw new Error(`env template: "${markers[i]}" is out of order`);
    }
  }
  const [secretsOpen, secretsClose, settingsOpen, settingsClose] = at;
  return {
    header: lines.slice(0, secretsOpen),
    secrets: lines.slice(secretsOpen, secretsClose + 1),
    settings: lines.slice(settingsOpen, settingsClose + 1),
    trailer: lines.slice(settingsClose + 1),
  };
}

/**
 * Starting contents for the two files, cut from the template at its fences.
 * Each keeps its own fence lines, which say which file it is.
 * @param {string} templateText .env.example text.
 * @returns {{secrets: string, settings: string}} Text for SECRETS_FILE and SETTINGS_FILE.
 */
export function envFilesFromTemplate(templateText) {
  const { secrets, settings } = splitEnvTemplate(templateText);
  return {
    secrets: `${secrets.join('\n')}\n`,
    settings: `${settings.join('\n')}\n`,
  };
}

// `export NAME=` is accepted too: dotenv parsers and upsertDotenvValues allow it.
const ENTRY = /^(\s*)(#?)\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/;
const QUOTES = new Set(['"', "'", '`']);

/**
 * Assignment entries in dotenv text, including commented-out ones and quoted
 * values that span several lines (an active value only).
 * @param {string[]} lines Dotenv lines.
 * @returns {Array<{start: number, end: number, name: string, commented: boolean, value: string}>}
 */
function dotenvEntries(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(ENTRY);
    if (!match) continue;
    const commented = match[2] === '#';
    const raw = match[4].trim();
    let end = i;
    let value = raw;
    const quote = raw[0];
    if (!commented && QUOTES.has(quote) && raw.indexOf(quote, 1) === -1) {
      // A quoted value continues until a line containing the closing quote.
      while (end + 1 < lines.length) {
        end += 1;
        value += `\n${lines[end]}`;
        if (lines[end].includes(quote)) break;
      }
    }
    entries.push({ start: i, end, name: match[3], commented, value });
    i = end;
  }
  return entries;
}

/** A value without surrounding quotes or a trailing ` # comment`, for comparison. */
function comparableValue(value) {
  const text = String(value).trim();
  if (QUOTES.has(text[0])) {
    const close = text.indexOf(text[0], 1);
    if (close > 0) return text.slice(1, close);
  }
  // An unquoted `#` at the start or after whitespace begins a comment.
  return text.replace(/(^|\s+)#.*$/, '').trim();
}

const MOVED_HEADER = '# Moved from .env by `npm run env:init`.';
const CONFLICT_NOTE =
  '# env:init: .env held a different value; the line above stays live, the .env one is kept below as a comment.';

/**
 * Plan moving every key out of SETTINGS_FILE (.env) into SECRETS_FILE
 * (.env.local). Every known key name ends up in .env.local; .env keeps
 * settings only. A blank `NAME=` line is a placeholder — a known name waiting
 * for a value — in either file. The line with a value is the one kept:
 *
 * - a value in .env, a placeholder (or nothing) in .env.local → the whole .env
 *   line takes the placeholder's place (appended when there is none);
 * - no value in .env → the line leaves .env; it never replaces a value in
 *   .env.local, and is appended only when .env.local lacks the name entirely;
 * - the same value live in both → the .env line just leaves;
 * - a DIFFERENT value live in both → the .env.local value stays live (it is
 *   the one the app uses today) and the .env line moves beneath it as a
 *   comment, so no value is lost (named in `conflicts` for the operator);
 * - a commented `# NAME=value` in .env moves as it is, still commented.
 *
 * @param {string} envText Current .env text.
 * @param {string} [localText] Current .env.local text ('' if none).
 * @returns {{env: string, local: string, moved: string[], alreadyThere: string[],
 *   conflicts: string[], dropped: string[], changed: boolean, localChanged: boolean}}
 *   `env` and `local` are the new texts; `moved` names lines that carried a
 *   value, `dropped` blank placeholders taken out of .env. The name lists never
 *   carry values.
 */
export function planSecretMigration(envText, localText = '') {
  const envSource = String(envText);
  const localSource = String(localText);
  const eol = envSource.includes('\r\n') ? '\r\n' : '\n';
  const localEol = localSource.includes('\r\n') ? '\r\n' : eol;
  const lines = envSource.split(/\r?\n/);
  const localLines = localSource.length ? localSource.split(/\r?\n/) : [];
  // Per name in .env.local: the live entry (last active one with a value) and
  // the blank placeholders still free to take a value.
  const live = new Map();
  const slots = new Map();
  const mentioned = new Set();
  for (const entry of dotenvEntries(localLines)) {
    mentioned.add(entry.name);
    const value = comparableValue(entry.value);
    if (value === '') {
      if (!slots.has(entry.name)) slots.set(entry.name, []);
      slots.get(entry.name).push(entry);
    } else if (!entry.commented) {
      live.set(entry.name, { value, end: entry.end });
    }
  }
  const remove = new Set();
  const edits = [];
  const append = [];
  const moved = [];
  const alreadyThere = [];
  const conflicts = [];
  const dropped = [];
  const note = (list, name) => {
    if (!list.includes(name)) list.push(name);
  };
  const place = (name, span) => {
    const slot = slots.get(name)?.shift();
    if (slot)
      edits.push({
        at: slot.start,
        remove: slot.end - slot.start + 1,
        lines: span,
      });
    else append.push(...span);
  };
  // Dotenv uses the last assignment for a repeated name. Migrate the latest
  // nonblank value first so an earlier assignment cannot become active.
  // Keep each name's first-appearance order for the migration summary.
  const byName = new Map();
  for (const entry of dotenvEntries(lines)) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }
  for (const entry of [...byName.values()].flatMap((group) => group.reverse())) {
    if (!isSecretEnvName(entry.name)) continue;
    const span = lines.slice(entry.start, entry.end + 1);
    const value = comparableValue(entry.value);
    const current = live.get(entry.name);
    if (value === '') {
      if (!mentioned.has(entry.name)) append.push(...span);
      note(dropped, entry.name);
    } else if (!entry.commented && current?.value === value) {
      note(alreadyThere, entry.name);
    } else if (!entry.commented && current) {
      const kept = [
        CONFLICT_NOTE,
        ...span.map((line) => `# ${line.trimStart()}`),
      ];
      if (current.end >= 0)
        edits.push({ at: current.end + 1, remove: 0, lines: kept });
      else append.push(...kept);
      note(conflicts, entry.name);
    } else {
      place(entry.name, span);
      if (!entry.commented) live.set(entry.name, { value, end: -1 });
      note(moved, entry.name);
    }
    mentioned.add(entry.name);
    for (let i = entry.start; i <= entry.end; i += 1) remove.add(i);
  }
  const next = [...localLines];
  // Bottom up, so earlier positions stay valid; at one position the
  // replacement goes first and an insertion then lands above it.
  for (const edit of [...edits].sort(
    (a, b) => b.at - a.at || b.remove - a.remove,
  )) {
    next.splice(edit.at, edit.remove, ...edit.lines);
  }
  let local = next.join(localEol);
  if (append.length) {
    const block = [MOVED_HEADER, ...append].join(localEol);
    const body = local.replace(/(\r?\n)+$/, '');
    local = body
      ? `${body}${localEol}${localEol}${block}${localEol}`
      : `${block}${localEol}`;
  }
  return {
    env: lines.filter((_, index) => !remove.has(index)).join(eol),
    local,
    moved,
    alreadyThere,
    conflicts,
    dropped,
    changed: remove.size > 0,
    localChanged: edits.length > 0 || append.length > 0,
  };
}

/**
 * Delete every assignment of the given names — active or commented out, with
 * any multi-line quoted value — from dotenv text. Used when a key is saved to
 * or removed from SECRETS_FILE: no copy, and no `# NAME=value`, may stay
 * behind in SETTINGS_FILE.
 * @param {string} text Dotenv text.
 * @param {Iterable<string>} names Names to delete.
 * @returns {{text: string, removed: string[], changed: boolean}}
 */
export function removeEnvAssignments(text, names) {
  const wanted = new Set(names);
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const drop = new Set();
  const removed = [];
  for (const entry of dotenvEntries(lines)) {
    if (!wanted.has(entry.name)) continue;
    for (let i = entry.start; i <= entry.end; i += 1) drop.add(i);
    if (!removed.includes(entry.name)) removed.push(entry.name);
  }
  if (!drop.size) return { text: String(text), removed, changed: false };
  return {
    text: lines.filter((_, index) => !drop.has(index)).join(eol),
    removed,
    changed: true,
  };
}
