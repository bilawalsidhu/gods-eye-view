// src/data/atcStreamPreference.js
// The one place a viewer's own ATC audio source is kept.
//
// The issue this serves (#715) is explicit that no LiveATC stream URLs are
// shipped: LiveATC asks third parties to consult them before linking directly
// to streams, so the app links to their PAGE and lets a viewer paste a URL
// they already have the right to use — their own receiver, a local SDR, a
// public relay they run. That URL is the viewer's, so it never leaves their
// browser: it is not sent anywhere, not put in a share link, and not read by
// anything but the audio element.
//
// Two rules the validation exists for:
//
//   1. HTTPS ONLY. The app is served over https, so an http:// stream is
//      blocked as mixed content by the browser with no error the viewer can
//      act on — it simply never plays. Refusing it at paste time turns a
//      silent failure into a sentence. `blob:`, `data:` and `javascript:` are
//      refused for the obvious reason.
//   2. STORAGE CAN THROW ON ACCESS. Under some privacy settings reading the
//      `window.localStorage` PROPERTY itself raises SecurityError, before any
//      getItem call — the same trap `src/layers/cctv/model.js` guards. Every
//      path here tolerates storage being absent, broken, or full, and the
//      feature works without it; the URL is simply forgotten between visits.

const STORAGE_KEY = 'gev.atc.streamUrl';

/** Longest URL accepted. Real stream URLs are far shorter; this is a guard
 * against a paste of something that is not a URL at all. */
const MAX_URL_LENGTH = 2048;

/**
 * `window.localStorage` when it is safely reachable, else null.
 *
 * NB: the property ACCESS itself throws SecurityError when site data is
 * blocked, so the try must wrap the access and not just the call.
 * @returns {Storage|null} Usable storage, or null.
 */
function safeStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Check a pasted stream URL without storing it.
 * @param {string} candidate - What the viewer typed or pasted.
 * @returns {{ok: true, url: string}|{ok: false, error: string}} The normalised
 *   URL, or a sentence explaining the refusal that a panel can show verbatim.
 */
export function validateStreamUrl(candidate) {
  const text = String(candidate ?? '').trim();
  if (!text) return { ok: false, error: 'Enter a stream URL.' };
  if (text.length > MAX_URL_LENGTH) {
    return { ok: false, error: 'That does not look like a stream URL.' };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol === 'http:') {
    // Worth its own message: this is the one a viewer will actually hit, by
    // pasting a working http stream and being unable to see why it is silent.
    return {
      ok: false,
      error:
        'Only https:// streams can play here — a browser blocks http:// audio ' +
        'on an https page, silently.',
    };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// stream URLs are accepted.' };
  }
  if (!parsed.hostname) return { ok: false, error: 'That URL has no host.' };
  return { ok: true, url: parsed.toString() };
}

/**
 * Read the stored stream URL.
 *
 * Re-validated on the way out: what is in storage was written by an older
 * version of this code, or by hand, and neither is a reason to trust it.
 * @returns {string|null} The stored URL, or null when absent or no longer valid.
 */
export function readStreamUrl() {
  const storage = safeStorage();
  if (!storage) return null;
  let stored = null;
  try {
    stored = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  const check = validateStreamUrl(stored);
  return check.ok ? check.url : null;
}

/**
 * Store a stream URL, or clear it.
 * @param {string|null} candidate - The URL, or null/'' to forget it.
 * @returns {{ok: true, url: string|null}|{ok: false, error: string}} What was
 *   stored, or why it was refused. A storage failure is NOT a refusal: the URL
 *   is still valid and the caller can use it for this session, so `ok` stays
 *   true and only persistence is lost.
 */
export function writeStreamUrl(candidate) {
  const storage = safeStorage();
  if (candidate === null || String(candidate ?? '').trim() === '') {
    try {
      storage?.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clean up if storage is unavailable */
    }
    return { ok: true, url: null };
  }
  const check = validateStreamUrl(candidate);
  if (!check.ok) return check;
  try {
    storage?.setItem(STORAGE_KEY, check.url);
  } catch {
    // Quota, private mode, blocked site data. The URL is good; it just will
    // not survive a reload, and that is not worth refusing the paste over.
  }
  return { ok: true, url: check.url };
}

export const ATC_STREAM_STORAGE_KEY = STORAGE_KEY;
