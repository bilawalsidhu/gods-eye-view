import { CCTV_MEDIA_MAX_BODY_BYTES } from './constants.js';

/** Digits allowed per Range position — bounds parse cost and absurd offsets. */
const RANGE_MAX_DIGITS = 16;

/**
 * Validate, canonicalize and bound a client `Range` header before the media
 * route forwards it to a third-party camera host.
 *
 * The route used to copy `req.headers.range` through verbatim. Two things
 * follow from that. A multi-range value makes the upstream answer
 * `multipart/byteranges`: when that body declares its length the relay's
 * ceiling still applies to it, but the parts inside are the upstream's to
 * choose and nothing here reads them, and a multipart body sent without a
 * declared length streams through uncapped like any other length-less body.
 * And a value the outbound request refuses to carry — anything with CR or LF
 * in it — made `fetch` throw, and the route recorded that error text, which
 * contains the client's own string, as the camera's health message.
 *
 * Bounding the Range bounds what is ASKED FOR, not what arrives: an upstream
 * that ignores the Range and answers with a length-less chunked body still
 * streams without a ceiling. That is how live feeds are served and is not
 * changed here. What is bounded is the request's lifetime: it is cancelled when
 * the viewer goes away, before the headers arrive as well as during the body.
 *
 * Anything that is not a single well-formed `bytes=` range is DROPPED and the
 * request proceeds with no Range, which is what RFC 7233 §3.1 prescribes for a
 * Range a server cannot understand: the client gets the whole body rather than
 * an error it did not ask for. Accepted forms are `bytes=<first>-<last>`,
 * `bytes=<first>-` and `bytes=-<suffix>`.
 *
 * Every accepted form is bounded to {@link CCTV_MEDIA_MAX_BODY_BYTES}, the same
 * ceiling the relay applies to a declared response body — including the
 * open-ended and suffix forms, which otherwise ask an upstream for a whole file
 * of unknown size. A player that wants more than one bound's worth asks for the
 * next range, which is ordinary partial-content behavior.
 *
 * @param {*} value - Raw `req.headers.range`.
 * @param {number} [maxBytes] - Ceiling for the requested span.
 * @returns {string} Canonical `bytes=...` value, or '' to send no Range.
 */
export function sanitizeCctvRangeHeader(
  value,
  maxBytes = CCTV_MEDIA_MAX_BODY_BYTES,
) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';

  // The unit is case-insensitive (RFC 7233 §2.1) and `bytes` is the only one
  // this proxy understands. A comma anywhere fails this pattern, which is how
  // multi-range is refused.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!match) return '';

  const [, firstText, lastText] = match;
  if (firstText.length > RANGE_MAX_DIGITS || lastText.length > RANGE_MAX_DIGITS)
    return '';
  // "bytes=-" carries neither position and is meaningless.
  if (!firstText && !lastText) return '';

  // Suffix form: the final N bytes. N === 0 is unsatisfiable by definition.
  if (!firstText) {
    const suffix = Number(lastText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return '';
    return `bytes=-${Math.min(suffix, maxBytes)}`;
  }

  const first = Number(firstText);
  if (!Number.isSafeInteger(first) || first < 0) return '';

  const ceiling = first + maxBytes - 1;
  if (!Number.isSafeInteger(ceiling)) return '';

  // Open-ended: everything from `first` on, bounded to one span.
  if (!lastText) return `bytes=${first}-${ceiling}`;

  const last = Number(lastText);
  if (!Number.isSafeInteger(last) || last < first) return '';
  return `bytes=${first}-${Math.min(last, ceiling)}`;
}
