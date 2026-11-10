/**
 * @module planespottersPhoto
 * @description Reads a Planespotters photo answer into the one credited
 * thumbnail every surface shows. Planespotters lets the thumbnail be hotlinked
 * on the condition that the photographer is credited next to it and the image
 * links back to the photo's page, so a photo without a photographer, or whose
 * image or page is not on Planespotters' own hosts, is "no photo": nothing
 * arbitrary is ever shown or linked.
 *
 * Accepts the upstream answer (`GET https://api.planespotters.net/pub/photos/hex/{hex}`,
 * `{photos: [...]}`), the cached server shape
 * (`{found, thumbnail_large?, thumbnail: {src, width, height}, photographer,
 * link}`), and an
 * already-read photo (`{found, src, width, height, photographer, link}`).
 * Pure: no fetch, no DOM.
 */

/** The image host: Planespotters' thumbnail CDN and its subdomains. */
const IMAGE_HOST = 'plnspttrs.net';
/** The only page host a photo may link to. */
const PAGE_HOST = 'www.planespotters.net';

const NO_PHOTO = Object.freeze({ found: false });

const isObject = (value) => Boolean(value) && typeof value === 'object';

/** The parsed `https:` URL, or null for anything else or with userinfo/port. */
function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    return null;
  return url;
}

function imageSrc(value) {
  const url = httpsUrl(value);
  return url &&
    (url.hostname === IMAGE_HOST || url.hostname.endsWith(`.${IMAGE_HOST}`))
    ? url.href
    : null;
}

function pageLink(value) {
  const url = httpsUrl(value);
  return url && url.hostname === PAGE_HOST ? url.href : null;
}

function dimension(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0
    ? Math.round(number)
    : null;
}

/** One candidate `{src, width, height, photographer, link}`, checked. */
function checked({ src, width, height, photographer, link }) {
  const credit = typeof photographer === 'string' ? photographer.trim() : '';
  const image = imageSrc(src);
  const page = pageLink(link);
  if (!credit || !image || !page) return null;
  return {
    found: true,
    src: image,
    width: dimension(width),
    height: dimension(height),
    photographer: credit,
    link: page,
  };
}

/** The upstream photo's candidates, large thumbnail first. */
function upstreamCandidates(photo) {
  if (!photo || typeof photo !== 'object') return [];
  return [photo.thumbnail_large, photo.thumbnail]
    .filter((thumb) => thumb && typeof thumb === 'object')
    .map((thumb) => ({
      src: thumb.src,
      width: thumb.size?.width,
      height: thumb.size?.height,
      photographer: photo.photographer,
      link: photo.link,
    }));
}

/**
 * Read a Planespotters answer into the first photo that passes the checks.
 * @param {*} payload Upstream, cached-server, or already-read photo.
 * @returns {{found: true, src: string, width: ?number, height: ?number,
 *   photographer: string, link: string} | {found: false}}
 */
export function parsePlanespottersPhoto(payload) {
  if (!payload || typeof payload !== 'object') return NO_PHOTO;
  let candidates;
  if (Array.isArray(payload.photos)) {
    candidates = payload.photos.flatMap(upstreamCandidates);
  } else if (payload.found !== true) {
    return NO_PHOTO;
  } else if (isObject(payload.thumbnail) || isObject(payload.thumbnail_large)) {
    // Large first, as for the upstream answer; each must pass the checks.
    candidates = [payload.thumbnail_large, payload.thumbnail]
      .filter(isObject)
      .map((thumb) => ({
        ...thumb,
        photographer: payload.photographer,
        link: payload.link,
      }));
  } else {
    candidates = [payload];
  }
  for (const candidate of candidates) {
    const photo = checked(candidate);
    if (photo) return photo;
  }
  return NO_PHOTO;
}
