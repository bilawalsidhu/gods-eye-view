// S2 Underground GhostMaps catalog: which KMZ in the public repository is the
// current edition of each product. Pure and portable (the server builds the
// catalog, tests pin the rules); no i18n, no DOM, no Cesium.

export const GHOSTMAPS_REPO = Object.freeze({
  owner: 's2underground',
  name: 'GhostMaps',
  branch: 'main',
  url: 'https://github.com/s2underground/GhostMaps',
});

/** Largest KMZ the proxy downloads; matches the browser's import ceiling. */
export const GHOSTMAPS_MAX_FILE_BYTES = 50 * 1024 * 1024;

const ARCGIS = 'ArcGIS Data for ATAK (KMZs)/';
const INCIDENTS = 'Incident Response Products for ATAK (KMZs and Documents)/';

/**
 * Curated products, in panel order. Each names a series of dated uploads; the
 * newest edition wins. Patterns match whole repository paths, so a renamed
 * folder fails closed (the product drops out) instead of matching elsewhere.
 */
export const GHOSTMAPS_PRODUCTS = Object.freeze([
  Object.freeze({
    id: 'cip',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Common Intelligence Picture',
    defaultOn: true,
    pattern: new RegExp(
      `^${escape(ARCGIS)}Common Intelligence Picture/Master Database/[^/]+\\.kmz$`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'kinetic-30d',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Kinetic Activity (30 days)',
    defaultOn: true,
    pattern: new RegExp(
      `^${escape(ARCGIS)}Common Intelligence Picture/30-Day Pulls/Kinetic[^/]*\\.kmz$`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'border-crisis',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Border Crisis Map',
    defaultOn: false,
    pattern: new RegExp(
      `^${escape(ARCGIS)}Border Crisis Map/S2Underground_Border_Crisis_Map[^/]*\\.kmz$`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'iran-cip',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Iran Common Intelligence Picture',
    defaultOn: false,
    pattern: new RegExp(
      `^${escape(INCIDENTS)}Iran[^/]*/Iran Common Intelligence Picture/[^/]+\\.kmz$`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'iran-kinetic',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Iran Kinetic Events',
    defaultOn: false,
    pattern: new RegExp(
      `^${escape(INCIDENTS)}Iran[^/]*/Iran Kinetic Events/[^/]+\\.kmz$`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'yemen-flot',
    // i18n-ignore: catalog data; the panel shows its own translated label
    title: 'Yemen FLOT',
    defaultOn: false,
    pattern: new RegExp(
      `^${escape(INCIDENTS)}Yemen[^/]*/Yemen FLOT[^/]*\\.kmz$`,
      'i',
    ),
  }),
]);

/** The newest incident product outside the curated series and the archive. */
export const GHOSTMAPS_LATEST_DROP = Object.freeze({
  id: 'latest-drop',
  // i18n-ignore: catalog data; the panel shows its own translated label
  title: 'Latest incident drop',
  defaultOn: false,
});

const LATEST_DROP_EXCLUDED =
  /\/(?:0_Archive|Basedata|Reference Material)(?:\/|$)/i;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DATE_IN_NAME =
  /(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[ _-]?(\d{1,2})(?:st|nd|rd|th)?[ ,_-]+(20\d\d)/i;
const EDITION_IN_NAME = /(?:[ _-]export)?[ _-]v?(\d{1,3})$/i;

/**
 * The date and edition written into an S2 file name, e.g.
 * `..._October_16_2026_Export_1.kmz` → 2026-10-16, edition 1. Undated names
 * report `dateMs: null` and sort below every dated edition.
 * @param {string} fileName
 * @returns {{dateMs: ?number, edition: number}}
 */
export function parseGhostMapsEdition(fileName) {
  const stem = String(fileName || '').replace(/\.km[lz]$/i, '');
  const match = DATE_IN_NAME.exec(stem);
  let dateMs = null;
  if (match) {
    const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
    const day = Number(match[2]);
    const year = Number(match[3]);
    const at = Date.UTC(year, month, day);
    // Date.UTC rolls 31 Sep into 1 Oct; only an exact calendar date counts.
    if (month >= 0 && new Date(at).getUTCDate() === day) dateMs = at;
  }
  const tail = match ? stem.slice(match.index + match[0].length) : stem;
  const edition = Number(EDITION_IN_NAME.exec(tail)?.[1] ?? 0);
  return { dateMs, edition };
}

function newer(a, b) {
  if (!b) return true;
  const ad = a.dateMs ?? -Infinity;
  const bd = b.dateMs ?? -Infinity;
  if (ad !== bd) return ad > bd;
  if (a.edition !== b.edition) return a.edition > b.edition;
  return a.path > b.path;
}

/** `S2Underground_Border_Crisis_Map_June_02_2026_v1.kmz` → readable words. */
export function ghostMapsFileTitle(fileName) {
  return String(fileName || '')
    .replace(/\.km[lz]$/i, '')
    .replace(/^S2Underground_/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the product catalog from a recursive git tree listing.
 * @param {Array<{path: string, type: string, sha: string, size?: number}>} tree
 * @returns {Array<{id: string, title: string, defaultOn: boolean,
 *   path: string, fileName: string, fileTitle: string, version: string,
 *   size: number, dateMs: ?number, edition: number}>}
 */
export function buildGhostMapsCatalog(tree) {
  const best = new Map();
  let drop = null;
  for (const entry of Array.isArray(tree) ? tree : []) {
    if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue;
    if (!/\.kmz$/i.test(entry.path)) continue;
    if (!/^[0-9a-f]{40}$/.test(entry.sha || '')) continue;
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size <= 0 || size > GHOSTMAPS_MAX_FILE_BYTES)
      continue;
    const fileName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const candidate = {
      path: entry.path,
      fileName,
      version: entry.sha,
      size,
      ...parseGhostMapsEdition(fileName),
    };
    const product = GHOSTMAPS_PRODUCTS.find(({ pattern }) =>
      pattern.test(entry.path),
    );
    if (product) {
      if (newer(candidate, best.get(product.id)))
        best.set(product.id, candidate);
    } else if (
      entry.path.startsWith(INCIDENTS) &&
      !LATEST_DROP_EXCLUDED.test(`/${entry.path}`) &&
      candidate.dateMs != null &&
      newer(candidate, drop)
    ) {
      drop = candidate;
    }
  }
  const rows = [];
  for (const product of [...GHOSTMAPS_PRODUCTS, GHOSTMAPS_LATEST_DROP]) {
    const file =
      product === GHOSTMAPS_LATEST_DROP ? drop : best.get(product.id);
    if (!file) continue;
    rows.push({
      id: product.id,
      title: product.title,
      defaultOn: product.defaultOn,
      ...file,
      fileTitle: ghostMapsFileTitle(file.fileName),
    });
  }
  return rows;
}

/**
 * Raw download URL pinned to a commit, so a CDN can never hand back an older
 * edition for a newer catalog.
 * @param {string} commit 40-hex commit sha.
 * @param {string} path Repository path.
 */
export function ghostMapsRawUrl(commit, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${GHOSTMAPS_REPO.owner}/${GHOSTMAPS_REPO.name}/${commit}/${encoded}`;
}

/**
 * The branch head from a git smart-HTTP ref advertisement
 * (`/info/refs?service=git-upload-pack`), or null.
 * @param {string} text
 * @param {string} [branch]
 * @returns {?string}
 */
export function parseGitRefAdvertisement(text, branch = GHOSTMAPS_REPO.branch) {
  const ref = `refs/heads/${branch}`;
  for (const line of String(text || '').split('\n')) {
    // pkt-line: 4 hex length digits, then "<sha> <ref>" (the first ref line
    // also carries a NUL and the capability list).
    const match = /^[0-9a-f]{4}([0-9a-f]{40}) ([^\0\s]+)/.exec(line);
    if (match && match[2] === ref) return match[1];
  }
  return null;
}
