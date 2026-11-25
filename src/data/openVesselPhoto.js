/**
 * @module openVesselPhoto
 * @description Reads an Open Vessel Photos answer into the one photo every
 * surface shows. Open Vessel Photos (https://openvesselphotos.org) serves a
 * free, keyless JSON and image API by MMSI. Every photo keeps the open licence
 * its author chose (CC BY, CC BY-SA, CC0 or public domain), so it is shown
 * with its credit and licence and links back to the vessel's page. A photo
 * whose image is not on Open Vessel Photos' own host, or whose answer names
 * no licence, is "no photo": nothing arbitrary is ever shown or linked.
 *
 * Accepts the upstream answer (`GET https://openvesselphotos.org/v1/mmsi/{mmsi}`,
 * `{mmsi, photos: [...]}`) and an already-read photo
 * (`{found, src, width, height, photographer, licence, link}`).
 * Pure: no fetch, no DOM.
 */

/** The only host a photo may come from or link to. */
const HOST = 'openvesselphotos.org';
/** The API's per-vessel answer. */
const API = `https://${HOST}/v1/mmsi/`;
/** The image width asked for: sharp in the panel on a 2× screen, ~60 KB. */
const IMAGE_SIZE = '800';

const NO_PHOTO = Object.freeze({ found: false });

/** A vessel's MMSI: nine digits. */
export const MMSI = /^\d{9}$/;

/** The API answer for one MMSI. */
export function openVesselPhotosUrl(mmsi) {
  return API + mmsi;
}

/** The vessel's page on Open Vessel Photos. */
function vesselPage(mmsi) {
  return `https://${HOST}/vessels/mmsi/${mmsi}`;
}

/** The parsed `https:` URL on the Open Vessel Photos host, or null. */
function ownUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.hostname === HOST
    ? url
    : null;
}

function dimension(value) {
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0
    ? Math.round(number)
    : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** One upstream photo of the vessel `mmsi`, checked. */
function checkedUpstream(photo, mmsi) {
  if (!photo || typeof photo !== 'object') return null;
  const image = ownUrl(photo.urls?.mmsi);
  const licence = text(photo.licenceName) || text(photo.licence);
  if (!image || !licence) return null;
  image.search = '';
  image.hash = '';
  image.searchParams.set('size', IMAGE_SIZE);
  // The answer gives the full image's size; the 800 px one keeps its shape.
  const width = dimension(photo.width);
  const height = dimension(photo.height);
  const scale =
    width && width > Number(IMAGE_SIZE) ? Number(IMAGE_SIZE) / width : 1;
  return {
    found: true,
    src: image.href,
    width: width ? Math.round(width * scale) : null,
    height: height ? Math.round(height * scale) : null,
    photographer: text(photo.credit),
    licence,
    link: vesselPage(mmsi),
  };
}

/** An already-read photo, checked again. */
function checkedRead(photo) {
  const image = ownUrl(photo.src);
  const page = ownUrl(photo.link);
  const licence = text(photo.licence);
  if (!image || !page || !licence) return null;
  return {
    found: true,
    src: image.href,
    width: dimension(photo.width),
    height: dimension(photo.height),
    photographer: text(photo.photographer),
    licence,
    link: page.href,
  };
}

/**
 * Read an Open Vessel Photos answer into the first photo that passes the
 * checks.
 * @param {*} payload Upstream answer or already-read photo.
 * @param {?string} [requestedMmsi] The MMSI asked for; an upstream answer
 *   naming another is no photo.
 * @returns {{found: true, src: string, width: ?number, height: ?number,
 *   photographer: string, licence: string, link: string} | {found: false}}
 */
export function parseOpenVesselPhoto(payload, requestedMmsi = null) {
  if (!payload || typeof payload !== 'object') return NO_PHOTO;
  if (Array.isArray(payload.photos)) {
    const mmsi = String(payload.mmsi ?? '');
    if (!MMSI.test(mmsi)) return NO_PHOTO;
    // An answer about another vessel is no photo of this one.
    if (requestedMmsi != null && mmsi !== String(requestedMmsi))
      return NO_PHOTO;
    for (const photo of payload.photos) {
      const checked = checkedUpstream(photo, mmsi);
      if (checked) return checked;
    }
    return NO_PHOTO;
  }
  if (payload.found !== true) return NO_PHOTO;
  return checkedRead(payload) || NO_PHOTO;
}
