import { PAGE_DWELL_MS } from './policy.js';

/**
 * Normalize one sign record from `/api/signs`. Re-validates server output so a
 * malformed payload cannot become an entity at a bogus position.
 *
 * @param {object} raw
 * @returns {?object}
 */
export function normalizeSignRecord(raw) {
  const id = String(raw?.id || '').trim();
  if (!id) return null;
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;

  const pages = (Array.isArray(raw?.views) ? raw.views : [])
    .map((view) => ({
      textLines: (Array.isArray(view?.textLines) ? view.textLines : [])
        .map((line) => String(line ?? '').trim())
        .filter(Boolean),
      justification: String(view?.justification || 'CENTER').toUpperCase(),
      imageUrl: typeof view?.imageUrl === 'string' ? view.imageUrl : '',
      category: String(view?.category || '').trim(),
    }))
    .filter((page) => page.textLines.length || page.imageUrl);
  if (!pages.length) return null;

  // typeof, not Number(): Number(null) is 0, which is finite and would turn
  // "bearing unknown" into a confident due-north facing.
  const heading =
    typeof raw?.headingDeg === 'number' ? raw.headingDeg : Number.NaN;
  return {
    id,
    name: String(raw?.name || id),
    route: String(raw?.route || ''),
    mileMarker: Number.isFinite(Number(raw?.mileMarker))
      ? Number(raw.mileMarker)
      : null,
    lat,
    lon,
    headingDeg: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null,
    displayType: String(raw?.displayType || ''),
    // Carried through so a mixed-agency layer attributes each sign to the
    // agency that published it, rather than to the layer as a whole.
    provider: String(raw?.provider || ''),
    license: String(raw?.license || ''),
    pages,
  };
}

/**
 * Which page a board is showing at a given moment. A single-page sign pins to
 * page 0 rather than running the modulo, so it is not redrawn on every tick.
 *
 * @param {{pages:Array}} record
 * @param {number} nowMs
 * @param {number} [dwellMs]
 * @returns {number} Page index.
 */
export function currentPageIndex(record, nowMs, dwellMs = PAGE_DWELL_MS) {
  const count = record?.pages?.length || 0;
  if (count <= 1) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(dwellMs) || dwellMs <= 0) {
    return 0;
  }
  return Math.floor(nowMs / dwellMs) % count;
}

/**
 * One-line summary for the tracked/label readout.
 *
 * @param {object} record
 * @returns {string}
 */
export function signSummary(record) {
  const parts = [record?.route, record?.displayType].filter(Boolean);
  if (Number.isFinite(record?.mileMarker)) {
    parts.splice(1, 0, `MM ${record.mileMarker}`);
  }
  return parts.join(' · ');
}

/** Flatten a sign's pages into readable lines for the label model.
 *
 * @param {object} record
 * @returns {string[]}
 */
export function signMessageLines(record) {
  const pages = Array.isArray(record?.pages) ? record.pages : [];
  return pages.flatMap((page, index) =>
    page.textLines.length
      ? pages.length > 1
        ? [`(${index + 1}/${pages.length})`, ...page.textLines]
        : page.textLines
      : [`(${index + 1}/${pages.length}) [image]`],
  );
}
