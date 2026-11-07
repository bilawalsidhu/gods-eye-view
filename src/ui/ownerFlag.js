/**
 * The owner mark beside a satellite's name: the owner country's flag (an SVG
 * from flag-icons — Windows draws no flag emoji), or a short text badge for
 * an organisation without one (ESA, EUMETSAT, "Multinational"). Each flag is
 * its own lazily fetched asset; only the shown one ever loads.
 */

/**
 * Flag URL loaders by path; empty under node:test, which has no glob. The
 * glob is eager so the bundle carries only the URL strings: a lazy glob would
 * emit a JS stub chunk per flag (~270), two requests for each flag shown.
 * The SVG itself is still fetched only when an <img> shows it.
 */
let FLAG_LOADERS = {};
try {
  const urls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
    query: '?url&no-inline',
    import: 'default',
    eager: true,
    // flag-icons lives in node_modules, which globs skip by default.
    exhaustive: true,
  });
  FLAG_LOADERS = Object.fromEntries(
    Object.entries(urls).map(([path, url]) => [path, () => url]),
  );
} catch {
  /* Not under Vite. */
}

const FLAG_PATH = (code) =>
  `/node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`;

/** An ISO 3166-1 alpha-2 code, upper case, or null. */
function isoCode(value) {
  const code = String(value ?? '').trim();
  return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null;
}

/**
 * A region's name in the locale, from the browser's own table.
 * @param {string} code ISO 3166-1 alpha-2.
 * @param {string} locale BCP 47 tag.
 * @returns {string|null}
 */
export function regionName(code, locale) {
  try {
    const name = new Intl.DisplayNames([locale || 'en'], {
      type: 'region',
    }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * How to mark a satellite's owner.
 * @param {{countryCode: string|null, label: string|null}|null|undefined} owner
 * @param {{locale?: string, loaders?: object}} [options]
 * @returns {{kind: 'flag', code: string, label: string}
 *   | {kind: 'badge', label: string, title: string}
 *   | null} A flag (with the country's localized name as its label), a text
 *   badge for an owner with no flag to show, or nothing when unknown.
 */
export function ownerMark(
  owner,
  { locale = 'en', loaders = FLAG_LOADERS } = {},
) {
  const code = isoCode(owner?.countryCode);
  const label = String(owner?.label ?? '').trim();
  if (code) {
    const name = regionName(code, locale) || label || code;
    if (loaders[FLAG_PATH(code)]) return { kind: 'flag', code, label: name };
    return { kind: 'badge', label: label || code, title: name };
  }
  return label ? { kind: 'badge', label, title: label } : null;
}

/**
 * What the readout shows for an owner once its flag has loaded or failed: the
 * flag, or a badge (the country code when the flag would not load, so the
 * owner never disappears), or nothing for an unknown owner.
 * @param {ReturnType<typeof ownerMark>} mark
 * @param {{url?: string|null, failed?: boolean}} [flag] The flag's load state.
 * @returns {{kind: 'flag', url: string, label: string}
 *   | {kind: 'badge', label: string, title: string} | null}
 */
export function shownOwnerMark(mark, { url = null, failed = false } = {}) {
  if (!mark) return null;
  if (mark.kind === 'badge') return mark;
  if (failed) {
    return { kind: 'badge', label: mark.code.toUpperCase(), title: mark.label };
  }
  return url ? { kind: 'flag', url, label: mark.label } : null;
}

/**
 * Fetch a flag's URL.
 * @param {string} code ISO 3166-1 alpha-2.
 * @returns {Promise<string|null>}
 */
export async function loadFlagUrl(code, loaders = FLAG_LOADERS) {
  const load = loaders[FLAG_PATH(String(code))];
  if (!load) return null;
  try {
    return (await load()) || null;
  } catch {
    return null;
  }
}
