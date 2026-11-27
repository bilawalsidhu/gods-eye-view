/** How many of the photos opened this session the layer remembers. */
export const PHOTO_HISTORY_CAP = 12;

/** A photo's id across sources: `<providerId>:<imageId>`. */
export function photoId(providerId, imageId) {
  return providerId && imageId ? `${providerId}:${imageId}` : '';
}

/**
 * Split a photo id into its source and image id (an image id may itself hold
 * a colon), or null.
 * @param {string} id
 * @returns {{providerId: string, imageId: string}|null}
 */
export function parsePhotoId(id) {
  const text = String(id ?? '');
  const at = text.indexOf(':');
  if (at <= 0 || at === text.length - 1) return null;
  return { providerId: text.slice(0, at), imageId: text.slice(at + 1) };
}

const NEAR_PREFIX = 'near:';

/**
 * The id of a point on a source's drawn line, for a Nearby row:
 * `near:<providerId>:<lat>,<lon>`, then `:<sequenceId>` when the line names
 * its sequence, so two sequences that meet at one point get two rows.
 * @param {string} providerId
 * @param {{lat: number, lon: number, sequenceId?: string}} point
 * @returns {string}
 */
export function nearPointId(providerId, { lat, lon, sequenceId }) {
  const at = `${NEAR_PREFIX}${providerId}:${lat.toFixed(6)},${lon.toFixed(6)}`;
  return sequenceId ? `${at}:${sequenceId}` : at;
}

/**
 * A line point's source, position and sequence from its id
 * ({@link nearPointId}), or null for any other id.
 * @param {string} id
 * @returns {{providerId: string, point: {lat: number, lon: number},
 *   sequenceId: string|null}|null}
 */
export function parseNearPointId(id) {
  const text = String(id ?? '');
  if (!text.startsWith(NEAR_PREFIX)) return null;
  const [providerId, place, ...sequence] = text
    .slice(NEAR_PREFIX.length)
    .split(':');
  if (!providerId || !place) return null;
  const [lat, lon] = place.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    providerId,
    point: { lat, lon },
    sequenceId: sequence.length ? sequence.join(':') : null,
  };
}

const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * The street-level photos opened this session, as records Context reads: the
 * open one's card, and the others under its Nearby. Each record is the
 * photo's last pose (where it was taken, which way it looked, when, by which
 * source). The oldest is forgotten past the cap.
 */
export function createPhotoHistory() {
  /** Oldest first. @type {Map<string, object>} */
  const photos = new Map();
  let revision = 0;
  let walkedId = null;

  /**
   * Remember the open photo, from `state.street`.
   * @returns {object|null} Its record, or null without a placed image.
   */
  function remember(street, { explicit = true } = {}) {
    const id = photoId(street?.providerId, street?.imageId);
    const lat = finite(street?.position?.lat);
    const lon = finite(street?.position?.lon);
    if (!street?.open || !id || lat === null || lon === null) return null;
    const record = Object.freeze({
      id,
      name: street.title || null,
      lat,
      lon,
      providerId: street.providerId,
      provider: street.providerName || null,
      imageId: String(street.imageId),
      headingDeg: finite(street.bearing),
      pano: street.isPano === true,
      capturedAt: finite(street.capturedAt),
      capturedAtSource: street.capturedAtSource ?? null,
      capturedAtPrecision:
        street.capturedAtPrecision === 'month' ? 'month' : 'day',
      creator: street.creator || null,
      via: street.via || null,
      license: street.license || null,
      still: street.still || photos.get(id)?.still || null,
      externalUrl: street.externalUrl || null,
    });
    // Keep the current walk step selectable without evicting opened photos
    // for every frame delivered by sequence playback.
    if (walkedId && walkedId !== id) {
      photos.delete(walkedId);
      walkedId = null;
    }
    if (explicit) walkedId = null;
    else if (!photos.has(id)) walkedId = id;
    revision++;
    photos.delete(id);
    photos.set(id, record);
    while (photos.size > PHOTO_HISTORY_CAP)
      photos.delete(photos.keys().next().value);
    return record;
  }

  /** Newest eligible photos first, `max` at most. */
  function list(max = PHOTO_HISTORY_CAP, eligible = () => true) {
    const count = Number.isFinite(max) && max > 0 ? max : PHOTO_HISTORY_CAP;
    return [...photos.values()].filter(eligible).reverse().slice(0, count);
  }

  const get = (id) => photos.get(String(id ?? '')) || null;

  return {
    remember,
    list,
    get,
    get revision() {
      return revision;
    },
    clear() {
      if (photos.size) revision++;
      photos.clear();
      walkedId = null;
    },
  };
}
