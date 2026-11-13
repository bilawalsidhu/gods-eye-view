import { MMSI, parseOpenVesselPhoto } from '../../data/openVesselPhoto.js';

/** A failed lookup is asked again after this long; a miss is final. */
const PHOTO_RETRY_MS = 5 * 60 * 1000;
/** Lookups remembered per session, oldest dropped first. */
const PHOTO_CACHE_LIMIT = 500;

/**
 * The selected vessel's photo, looked up once per MMSI when it is selected.
 * The answer is read with `parseOpenVesselPhoto` whatever shape the source
 * returns, so only a checked photo is ever kept. A source without
 * `getEnrichment` has no photos.
 */
export function createPhotos({ vesselState }) {
  /** MMSI → photo, `null` for a final miss, or `{failedAtMs}`/`{pending}`. */
  const answers = new Map();

  function remember(mmsi, answer) {
    answers.delete(mmsi);
    answers.set(mmsi, answer);
    if (answers.size > PHOTO_CACHE_LIMIT)
      answers.delete(answers.keys().next().value);
  }

  /** Ask for the record's photo unless it is known, asked or cooling down. */
  function requestVesselPhoto(record, now = Date.now()) {
    const mmsi = String(record?.mmsi || '');
    const source = vesselState._source;
    if (!MMSI.test(mmsi) || typeof source?.getEnrichment !== 'function') return;
    const known = answers.get(mmsi);
    if (known !== undefined) {
      if (known?.pending || known === null || known.found) return;
      if (now - known.failedAtMs < PHOTO_RETRY_MS) return;
    }
    remember(mmsi, { pending: true });
    Promise.resolve()
      .then(() => source.getEnrichment({ kind: 'photo', id: mmsi }))
      .then(
        (answer) => {
          const photo = parseOpenVesselPhoto(answer);
          remember(mmsi, photo.found ? photo : null);
        },
        () => remember(mmsi, { failedAtMs: Date.now() }),
      );
  }

  /** The vessel's checked photo, or null. */
  function vesselPhoto(record) {
    const answer = answers.get(String(record?.mmsi || ''));
    if (!answer?.found) return null;
    const { src, width, height, photographer, licence, link } = answer;
    return { src, width, height, photographer, licence, link };
  }

  return { requestVesselPhoto, vesselPhoto };
}
