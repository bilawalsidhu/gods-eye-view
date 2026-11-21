/**
 * Which library entries a viewer has added and switched on, and how that
 * travels in a share link.
 *
 * Library selections never use the core layer-token ledger. They persist in
 * this browser under `gev:library:v1` and travel as `lib=<t>.<t>` with the
 * two-character tokens from `ledger.json`. Tokens are permanent: a removed
 * entry keeps its row so published links never change meaning.
 */
import { LIBRARY_ID_PATTERN } from './manifest.js';

export const LIBRARY_STORAGE_KEY = 'gev:library:v1';
export const LIBRARY_SHARE_PARAM = 'lib';
export const LIBRARY_TOKEN_PATTERN = /^[0-9a-z]{2}$/;
/** The most entries one library (and one share link) holds. */
export const MAX_SELECTED = 64;
const MAX_PARAM_CHARS = 3 * MAX_SELECTED;

/**
 * Validate the ledger: unique ids, unique two-character tokens, in order.
 * @param {Array<[string, string]>} rows
 * @returns {{ ok: boolean, errors: string[], tokenById: Map<string,string>, idByToken: Map<string,string> }}
 */
export function readLibraryLedger(rows) {
  const errors = [];
  const tokenById = new Map();
  const idByToken = new Map();
  for (const [index, row] of (rows || []).entries()) {
    const [id, token] = Array.isArray(row) ? row : [];
    if (!LIBRARY_ID_PATTERN.test(id ?? ''))
      errors.push(`row ${index}: invalid id`);
    else if (!LIBRARY_TOKEN_PATTERN.test(token ?? ''))
      errors.push(`row ${index}: token must be two base-36 characters`);
    else if (tokenById.has(id)) errors.push(`row ${index}: duplicate id ${id}`);
    else if (idByToken.has(token))
      errors.push(`row ${index}: duplicate token ${token}`);
    else {
      tokenById.set(id, token);
      idByToken.set(token, id);
    }
  }
  return { ok: errors.length === 0, errors, tokenById, idByToken };
}

/**
 * The next free token after the ledger's highest one ('00', '01', … 'zz').
 * @param {Array<[string, string]>} rows
 * @returns {string|null}
 */
export function nextLibraryToken(rows) {
  const used = (rows || []).map(([, token]) => Number.parseInt(token, 36));
  const next = used.length ? Math.max(...used) + 1 : 0;
  if (next >= 36 * 36) return null;
  return next.toString(36).padStart(2, '0');
}

function cleanIds(ids, allowed) {
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || !LIBRARY_ID_PATTERN.test(id)) continue;
    if (allowed && !allowed.has(id)) continue;
    if (!result.includes(id)) result.push(id);
    if (result.length === MAX_SELECTED) break;
  }
  return result;
}

/**
 * Normalize a stored or decoded selection. `on` is always a subset of
 * `added`.
 * @param {unknown} raw
 * @param {Set<string>} [allowed] Known entry ids.
 * @returns {{ added: string[], on: string[] }}
 */
export function normalizeLibrarySelection(raw, allowed) {
  const added = cleanIds(raw?.added, allowed);
  const on = cleanIds(raw?.on, allowed).filter((id) => added.includes(id));
  return { added, on };
}

/** Read this browser's selection; an unreadable store reads as empty. */
export function readStoredLibrarySelection(storage, allowed) {
  try {
    const text = storage?.getItem?.(LIBRARY_STORAGE_KEY);
    return normalizeLibrarySelection(text ? JSON.parse(text) : null, allowed);
  } catch {
    return { added: [], on: [] };
  }
}

/** Write this browser's selection; a refused write is not an error. */
export function writeStoredLibrarySelection(storage, selection) {
  try {
    storage?.setItem?.(
      LIBRARY_STORAGE_KEY,
      JSON.stringify(normalizeLibrarySelection(selection)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode the switched-on entries as `lib=`; removes the param when none.
 * @param {URLSearchParams} params
 * @param {string[]} onIds
 * @param {Map<string,string>} tokenById
 */
export function encodeLibraryParam(params, onIds, tokenById) {
  const tokens = cleanIds(onIds)
    .map((id) => tokenById.get(id))
    .filter(Boolean);
  if (tokens.length) params.set(LIBRARY_SHARE_PARAM, tokens.join('.'));
  else params.delete(LIBRARY_SHARE_PARAM);
}

/**
 * Decode `lib=`. Unknown tokens are skipped, not fatal: a link made on a
 * newer build still restores the entries this build knows.
 * @param {URLSearchParams} params
 * @param {Map<string,string>} idByToken
 * @returns {string[]|null} Entry ids, or null when the link has no `lib`.
 */
export function decodeLibraryParam(params, idByToken) {
  const value = params?.get?.(LIBRARY_SHARE_PARAM);
  if (value === null || value === undefined) return null;
  if (value.length > MAX_PARAM_CHARS) return [];
  return cleanIds(
    value
      .split('.')
      .filter((token) => LIBRARY_TOKEN_PATTERN.test(token))
      .map((token) => idByToken.get(token)),
  );
}
