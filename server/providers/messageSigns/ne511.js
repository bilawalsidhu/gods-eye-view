/**
 * Nebraska 511 (NDOT) — one agency pack for the message-sign layer.
 *
 * The browser cannot call this upstream directly: the POST answers
 * `Access-Control-Allow-Origin: *`, but its JSON content type forces a CORS
 * preflight, and the OPTIONS request is served by the SPA's S3 host as HTML
 * with no CORS headers. Hence the app-origin route.
 */
import { NE511_GRAPHQL_URL, NE511_BOUNDS } from '../cctv/constants.js';
import { toFiniteNumber } from '../cctv/normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';

/** Bounds one refresh so a stalled upstream cannot wedge the route. */
export const NE511_SIGNS_TIMEOUT_MS = 15 * 1000;
/** Sign face images live on the vendor's bucket, not on NDOT's image host. */
export const NE511_SIGN_IMAGE_ORIGIN =
  'https://crc-signs-s3.s3.us-west-2.amazonaws.com/';

/** Only signs actually posting a message are of interest. */
const DISPLAYING = 'DISPLAYING_MESSAGE';

export const NE511_SIGNS_QUERY = `query MapFeatures($input: MapFeaturesArgs!) {
  mapFeaturesQuery(input: $input) {
    mapFeatures {
      __typename
      uri
      title
      ... on Sign {
        bbox
        signStatus
        signDisplayType
        views {
          uri
          category
          ... on SignTextView {
            textJustification
            textLines
          }
          ... on SignComboView {
            imageUrl
            textJustification
            textLines
          }
          ... on SignImageView {
            imageUrl
          }
          ... on SignOverlayView {
            travelTimes
            imageUrl
            imageLayout
          }
          ... on SignOverlayTPIMView {
            textLines
            imageUrl
          }
        }
      }
    }
    error {
      message
      type
    }
  }
}`;

/**
 * Accept a sign-face image only on the vendor bucket the feed uses, so no
 * upstream field can point a client at an arbitrary host.
 *
 * @param {string} value
 * @returns {string} The URL, or '' when not accepted.
 */
export function normalizeSignImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith(NE511_SIGN_IMAGE_ORIGIN)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    if (!/\.(png|jpg|jpeg|gif)$/i.test(parsed.pathname)) return '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

/**
 * Travel bearing a sign addresses, from its title ("I-80: I-80 WB Mile 447.5").
 *
 * Unlike the camera titles, whose direction words are positional ("E of
 * Lincoln" is where a camera sits), these are real travel bearings.
 *
 * @param {string} title
 * @returns {number} Bearing in degrees, or NaN when the title carries none.
 */
export function signHeadingFromTitle(title) {
  const token = /\b(EB|WB|NB|SB)\b/.exec(String(title || ''))?.[1];
  // directionToHeading knows "WB" but not a bare "W".
  return token ? directionToHeading(token, true) : NaN;
}

/**
 * Route and mile marker a sign sits at. Titles read
 * "<route>: <route> <bearing> Mile <marker>", so the prefix is canonical.
 *
 * @param {string} title
 * @returns {{route:string, mileMarker:number}}
 */
export function parseSignLocation(title) {
  const text = String(title || '').trim();
  const route = text.includes(':')
    ? text.slice(0, text.indexOf(':')).trim()
    : '';
  const mile = /\bMile\s+([\d.]+)/i.exec(text)?.[1];
  return { route, mileMarker: toFiniteNumber(mile) };
}

/**
 * One page of a sign's rotating display. Text pages carry `textLines`, image
 * pages an `imageUrl`, combo pages both; pages with neither are dropped.
 *
 * @param {object} view
 * @returns {?{uri:string, category:string, textLines:string[], justification:string, imageUrl:string}}
 */
export function normalizeSignView(view) {
  const textLines = (Array.isArray(view?.textLines) ? view.textLines : [])
    .map((line) => String(line ?? '').trim())
    .filter(Boolean);
  const imageUrl = normalizeSignImageUrl(view?.imageUrl);
  if (!textLines.length && !imageUrl) return null;
  return {
    uri: String(view?.uri || '').trim(),
    category: String(view?.category || '').trim(),
    textLines,
    justification: String(view?.textJustification || 'CENTER')
      .trim()
      .toUpperCase(),
    imageUrl,
  };
}

/**
 * One `mapFeaturesQuery` Sign feature -> one normalized sign, or null.
 *
 * @param {object} feature
 * @returns {?object}
 */
export function normalizeSignFeature(feature) {
  if (feature?.__typename !== 'Sign') return null;
  if (String(feature?.signStatus || '') !== DISPLAYING) return null;
  // signId legitimately contains an asterisk (`necarsxsigns*307`) and
  // sometimes a trailing space, so it is kept verbatim.
  const rawId = /^electronic-sign\/(.+)$/.exec(
    String(feature?.uri || '').trim(),
  )?.[1];
  if (!rawId) return null;

  // A sign's bbox is a degenerate point.
  const bbox = Array.isArray(feature?.bbox) ? feature.bbox : [];
  const lon = toFiniteNumber(bbox[0]);
  const lat = toFiniteNumber(bbox[1]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 39.9 ||
    lat > 43.1 ||
    lon < -104.2 ||
    lon > -95.2
  ) {
    return null;
  }

  const views = (Array.isArray(feature?.views) ? feature.views : [])
    .map(normalizeSignView)
    .filter(Boolean);
  if (!views.length) return null;

  const title = String(feature?.title || '').trim();
  const { route, mileMarker } = parseSignLocation(title);
  const heading = signHeadingFromTitle(title);

  return {
    id: `ne511-sign-${rawId}`,
    name: title || `Nebraska 511 Sign ${rawId}`,
    route: route || 'Nebraska',
    mileMarker,
    lat,
    lon,
    headingDeg: Number.isFinite(heading) ? heading : null,
    // A travel bearing from the title is a real facing, not a prior.
    headingConfidence: Number.isFinite(heading) ? 'high' : 'none',
    displayType: String(feature?.signDisplayType || '').trim(),
    views,
    provider: 'Nebraska 511',
    license: 'Nebraska 511 - Nebraska Department of Transportation',
  };
}

/**
 * Fetch and normalize the active sign list. Fails soft: a refusal, a GraphQL
 * error, or a malformed body yields [].
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch]
 * @returns {Promise<Array<object>>}
 */
export async function loadNe511Signs({ fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(NE511_GRAPHQL_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-ne511-proxy/1.0',
      },
      body: JSON.stringify({
        query: NE511_SIGNS_QUERY,
        variables: {
          input: { ...NE511_BOUNDS, layerSlugs: ['electronicSigns'] },
        },
      }),
      signal: AbortSignal.timeout(NE511_SIGNS_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[NE511 Signs] upstream declined:', resp.status);
      return [];
    }
    const body = await resp.json();
    const query = body?.data?.mapFeaturesQuery;
    // GraphQL reports failure in the body with HTTP 200, two ways.
    const failure = body?.errors?.[0]?.message || query?.error?.message || '';
    if (failure) {
      console.warn('[NE511 Signs] query error:', failure);
      return [];
    }
    const features = Array.isArray(query?.mapFeatures) ? query.mapFeatures : [];
    const signs = features.map(normalizeSignFeature).filter(Boolean);
    return Array.from(new Map(signs.map((s) => [s.id, s])).values());
  } catch (error) {
    console.warn('[NE511 Signs]', error?.message || String(error));
    return [];
  }
}
