import { normalizePhotonFeature, photonSearchUrl } from '../keylessGeocoder.js';
import { parseCoordinateQuery } from './coordinateParser.js';
import {
  requestWithDeadline,
  waitForSignal,
} from '../sources/requestDeadline.js';

const MAX_QUERY_CHARS = 200;
const CJK =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Han, Hangul or Kana text, whose place names are often two characters. */
export const isCjk = (text) => CJK.test(String(text || ''));
/** The fewest characters a place name is looked up from. */
export const minPlaceChars = (text) => (isCjk(text) ? 2 : 3);

/**
 * Text that may hold something private, which is never looked up, offered
 * as a place or sent anywhere:
 *   - an "@" with something right on both sides (an email or a handle);
 *   - seven digits or more (in any script, full-width too) with nothing but
 *     spaces, punctuation, symbols or format characters between them
 *     (phone, card, SSN and account numbers, and their starts);
 *   - a phone number written with dots ("415.555.0100");
 *   - two letters, two digits and ten letters or digits more (an IBAN's
 *     shape), spaces allowed;
 *   - "password", "passcode", "passwd", "ssn", "pw", "pwd" or "bearer" with
 *     anything after it, "token", "secret", "api key" or "key" with ":" or
 *     "=" after it, "api key", "access token" or "secret key" with a word of
 *     six characters or more after it, the word for "password" in the
 *     interface's languages with anything after it, or "pin" (also "pin
 *     code", "pin number", "pin is") with a digit after it;
 *   - a word starting "sk_", "sk-", "rk_", "pk_live", "ghp_" or a Slack token's "xoxb-" and the like (any
 *     case), or "AIza", "eyJ" or "AKIA";
 *   - a word that may be a password or key (see mayBeSecret).
 * The text is read after NFKC, so full-width letters and "＠" count too.
 * Text that parses as coordinates or a grid reference is a spot, not a
 * secret.
 */
export function mayBePrivate(text) {
  return privacyReason(text) !== null;
}

/**
 * Whether the only thing private-looking in a line is a long run of digits,
 * as an address's house number and postcode can be ("Москва, ул. Тверская,
 * д. 13, 125009"): such a line may be searched as a place when the user
 * picks that on purpose. Never for an email, handle, password, key, code,
 * IBAN or anything else.
 * @param {string} text
 */
export function onlyNumbersLookPrivate(text) {
  // Read as privacyReason reads it: "⁴¹¹¹", "①②", "ｃａｒｄ" and words split by
  // zero-width spaces count as the digits and words they fold to.
  const line = foldLine(text);
  const groups = line.match(/\d+/g) || [];
  return (
    privacyReason(text) === 'number' &&
    /\p{L}{2,}/u.test(line) &&
    // Address-sized: no group over six digits, nine digits at most in all
    // (a house number and a postcode), and no word that says what a number
    // is ("card 4111 …", "phone +1 415 …", "token 12345678").
    groups.every((group) => group.length <= 6) &&
    groups.join('').length <= 9 &&
    !NUMBER_CONTEXT.test(line)
  );
}

/**
 * Words that say a number is an account, a card, a phone or a secret, in the
 * interface's languages where they differ ("Karte", "Telefon", "tarjeta").
 */
const NUMBER_CONTEXT =
  /(?<!\p{L})(?:code|key|token|secret|pass\p{L}*|login|user\p{L}*|seed|card|carte|karte|kreditkarte|tarjeta|cartão|carta|kort|карта|visa|mastercard|amex|exp|expiry|acct|account|konto|cuenta|conta|conto|routing|sort|swift|bic|iban|phone|tel|tél|tele?fon\p{L}*|t[ée]l[ée]phone|tel[ée]fono|telefone|телефон\p{L}*|mobile?|handy|cell|call|fax|whatsapp|licen[cs]e|plate|id|ssn|bsn|nin|medicare|social|tax|vat|passport|pass|bank|cvv|cvc|pin|otp|number|nummer|n[úu]mero|номер|dob|born|geboren)(?!\p{L})/iu;

/**
 * The line as the privacy checks read it: compatibility forms folded,
 * format characters dropped, curly apostrophes straightened and every
 * decimal digit of any script made a "0".
 * @param {string} text
 */
function foldLine(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/(?![0-9])\p{Nd}/gu, '0');
}

/**
 * Why a line may be private: 'number' when only a long run of digits makes
 * it so, 'other' for anything else, or null.
 * @param {string} text
 * @returns {?('number'|'other')}
 */
function privacyReason(text) {
  // Full-width forms ("４１１１", "＠", "ｐａｓｓｗｏｒｄ") and digits of any
  // script ("٤١١١", "४१११") read as their plain forms first, as the place
  // service and GEV would receive them.
  // Format characters (zero-width spaces and joiners) are dropped, so
  // "pass\u200bword" reads as "password", and curly apostrophes made
  // straight ("parola d’ordine").
  // Only how many digits there are matters below, not their values.
  const input = String(text || '');
  const line = foldLine(input);
  // An email address or a handle: "@" with something right on both sides.
  // Spaced, it joins a village to its other name ("Nanjampeta @
  // Chandambylu").
  // Also while it is typed ("john.smith@") or spaced ("john @ gmail.com").
  if (
    /[^\s@]@[^\s@]|(?:^|\s)@[a-z0-9_]{2,}(?![\p{L}\p{N}])|[^\s@]@(?:\s|$)|\S\s+@\s+[\p{L}\p{N}-]{2,}\.\p{L}{2,}/iu.test(
      line,
    )
  )
    return 'other';
  // Coordinates and grid references are a spot, not a number to keep: only
  // text the place search itself reads as coordinates, as typed ("١٢٣٤,
  // ٥٦٧٨" folded would read as a spot, but is not one).
  if (parseCoordinateQuery(input)) return null;
  // Seven digits or more with only spaces, dashes or other marks between
  // them (any dash, ".", "_", ",", ":", "|", zero-width spaces): a phone number
  // or its start ("+1 415 555"), a card or its start ("4111 1111"), an SSN
  // ("123 45 6789", "123-45-6789", "123456789"), an account number. Dots
  // ("4111.1111.1111.1111", "123–45–6789"); coordinates were let through
  // above.
  // A street address's house number and postcode ("Hauptstrasse 12 10115
  // Berlin", "Calle Mayor 10, 28013 Madrid", "Av Paulista 1578 01310-200")
  // are read apart first.
  // So are postcodes written the way they are: a US ZIP+4 after a word
  // ("DC 20500-0003"), a Brazilian CEP ("01310-200") and a Japanese one
  // after "〒" or before the address ("〒100-0001", "100-0001 東京都").
  // "#" (a street number's sign, "Calle 100 # 19-61") splits digits too.
  // A word that says what the number is ("card 4111 111111", "call 0207
  // 946095") keeps the digits together: no address is read out of them.
  const named = NUMBER_CONTEXT.test(line);
  const digits = (
    named
      ? line
      : line
          .replace(
            // A street word before ("030 12345" is a phone number).
            /(?<=\p{L}\.?\s)\d{1,4}[a-z]?,?\s+\d{5}(?:-\d{3})?(?=\s+\p{L}|$)/giu,
            ' ',
          )
          // Other postcodes after a street's house number and before the city (a
          // four-digit one after a comma, so "is 555 0100 thanks" stays a number):
          // "Nowy Świat 10, 00-950 Warszawa", "Drottninggatan 53, 111 21
          // Stockholm", "Mariahilfer Straße 120, 1070 Wien", "Rua Augusta 274,
          // 1100-053 Lisboa", "Tverskaya 13 125009 Moscow".
          .replace(
            /(?<=\p{L}\.?\s)\d{1,4}[a-z]?(?:,\s*\d{4}(?:-\d{3})?|,?\s+(?:\d{2}-\d{3}|\d{3} \d{2}|\d{6}))(?=\s+\p{L})/giu,
            ' x ',
          )
          // ZIP+4 after a state's two letters ("DC 20500-0003"), not after
          // any word ("Alice 12345-6789").
          .replace(/(?<=(?:^|\s)\p{L}{2},?\s)\d{5}-\d{4}\b/gu, ' x ')
          .replace(/\b\d{5}-\d{3}\b/g, ' x ')
          .replace(
            /〒\s?\d{3}-\d{4}|\b\d{3}-\d{4}(?=\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
            ' x ',
          )
          .replace(/#/g, ' x ')
  ).replace(/[^\p{L}\p{N}]/gu, '');
  const longNumber =
    /\d{7,}/.test(digits) ||
    // A phone number written with dots ("415.555.0100").
    /\b\d{3}\.\d{3}\.\d{4}\b/.test(line);
  // An IBAN.
  if (/\b[a-z]{2}\d{2}(?:\s?[a-z0-9]){10,}/i.test(line)) return 'other';
  if (
    /\b(?:password|passcode|passwd|ssn|pw|pwd|bearer)\b\s*[:=#]?\s*\S/i.test(
      line,
    ) ||
    // The word for "password" in the interface's languages.
    // A whole word only: "Sachsenhausen" holds "senha" but is a place.
    /(?<!\p{L})(?:contraseña|passwort|kennwort|mot de passe|senha|parola d'ordine|lösenord|пароль|пароля|密码|密碼|パスワード|비밀번호|סיסמה|كلمة (?:السر|المرور))(?!\p{L})\s*[:=#]?\s*\S/iu.test(
      line,
    ) ||
    /\b(?:api[ _-]?key|access[ _-]?token|secret[ _-]?key|auth[ _-]?token|client[ _-]?secret)(?:\s*[:=]\s*|\s+)\S{4,}/i.test(
      line,
    ) ||
    /\b(?:token|secret|api[ _-]?key|key|pass)\s*[:=]\s*\S/i.test(line) ||
    /\b(?:my secret is|passphrase|mnemonic|seed phrase|recovery phrase)\b\s*[:=]?\s*\S/i.test(
      line,
    ) ||
    // An email spelled out to slip past a filter: "john at example dot com".
    /\b\S+\s+at\s+\S+\s+dot\s+(?:com|net|org|edu|gov|io|co)\b/i.test(line) ||
    /\b(?:pin|otp|2fa|mfa|cvv|cvc|(?:door|access|gate|alarm|entry|security|verification|one-time|auth|login) code|card ending(?: in)?)(?:\s+(?:code|number|is|no\.?))*\s*[:=#]?\s*\d/i.test(
      line,
    ) ||
    // A code of letters too, after a label that can only be a code
    // ("OTP: ABCDEF", "verification code ABCDEF", "PIN: A7B2"); "Pin Oak"
    // has no colon and stays a place.
    /\b(?:pin|otp|2fa|mfa|cvv|cvc)\s*[:=#]\s*[a-z0-9]/i.test(line) ||
    codeAfterLabel(line)
  )
    return 'other';
  if (
    line
      .split(/\s+/)
      // A key in quotes or brackets ("\"sk-…\"") and a postcode before a
      // comma ("SW1A2AA,") are read without them.
      .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .some(
        (token) =>
          /^(?:sk[-_]|rk_|pk_live|ghp_|xox[abposr]-)/i.test(token) ||
          /^(?:AIza|eyJ|AKIA)/.test(token) ||
          mayBeSecret(token),
      )
  )
    return 'other';
  return longNumber ? 'number' : null;
}

/**
 * A code of letters after a label that can only be a code, without a colon
 * ("verification code ABCDEF", "otp 7GH2K"): written in capitals or holding
 * a digit, so "Gate Code Lane" stays a street.
 */
function codeAfterLabel(line) {
  const match =
    /\b(?:otp|2fa|mfa|(?:door|access|gate|alarm|entry|security|verification|one-time|auth|login) code)(?:\s+is)?\s*[:=#]?\s*([a-z0-9]{4,})\b/i.exec(
      line,
    );
  if (!match) return false;
  const value = match[1];
  return /\d/.test(value) || value === value.toUpperCase();
}

/**
 * A word that may be a password or key, with letters and digits mixed
 * within one run: eight characters or more, four letters or more with a digit ("hunter22",
 * "letmein1"), or letters, digits and a symbol together ("Tr0ub4dor&3").
 * Callsigns (UAL2110, BAW15K, N123AB) and postcodes are shorter or have
 * fewer letters.
 */
function mayBeSecret(token) {
  // Letters and digits must mix within one run ("hunter22", "w0rd"): a
  // number beside a word ("Yanino-1", "2-chōme", "656/G.B.", "Route-66")
  // is a name.
  // Latin letters only: CJK addresses are written without spaces
  // ("東京都港区六本木6丁目", "北京市朝阳区建国路88号").
  // A UK postcode written without its space ("EC1A1BB", "BT487NN").
  if (/^[a-z]{1,2}\d[a-z\d]?\d[a-z]{2}$/i.test(token)) return false;
  const mixed = token
    .split(/[^\p{L}\p{N}]+/u)
    .some((run) => /\p{Script=Latin}/u.test(run) && /\d/.test(run));
  if (!mixed) return false;
  const letters = (token.match(/\p{L}/gu) || []).length;
  const digits = (token.match(/\d/g) || []).length;
  if (!letters || !digits) return false;
  if (token.length >= 8) return true;
  if (token.length >= 6 && /[^\p{L}\p{N}'.,\-/]/u.test(token)) return true;
  return token.length >= 6 && letters >= 4;
}
const MIN_GAP_MS = 500;
const TIMEOUT_MS = 6000;
const PAUSE_AFTER_REFUSAL_MS = 60_000;
const CACHE_LIMIT = 200;

/**
 * The spacing, the pause and the cache, shared by every suggester in the tab:
 * a search box that is put up again starts from where the last one left off.
 */
const shared = { nextRequestAt: 0, pausedUntil: 0, cache: new Map() };

/** Forget the shared spacing, pause and cache (tests). */
export function resetPlaceSuggestions() {
  shared.nextRequestAt = 0;
  shared.pausedUntil = 0;
  shared.cache.clear();
}

/** List Photon candidates while typing. The submitted search owns navigation. */
export function createPlaceSuggester({
  endpoint,
  fetchImpl = (...args) => globalThis.fetch(...args),
  limit = 4,
} = {}) {
  const enabled = endpoint === undefined || Boolean(endpoint);
  const { cache } = shared;

  return {
    enabled,
    async suggest(query, { signal } = {}) {
      signal?.throwIfAborted();
      const text = String(query ?? '')
        .trim()
        .slice(0, MAX_QUERY_CHARS);
      if (!enabled || text.length < minPlaceChars(text) || mayBePrivate(text))
        return [];
      const language = (globalThis.document?.documentElement?.lang || 'en')
        .slice(0, 2)
        .toLowerCase();
      const key = `${endpoint ?? ''}|${limit}|${language}|${text.toLowerCase()}`;
      if (cache.has(key)) return cache.get(key);

      // Concurrent callers recheck the gap after waking before sending.
      while (shared.nextRequestAt > Date.now()) {
        let timer;
        const pause = new Promise((resolve) => {
          timer = setTimeout(resolve, shared.nextRequestAt - Date.now());
        });
        try {
          await waitForSignal(pause, signal);
        } finally {
          clearTimeout(timer);
        }
      }
      signal?.throwIfAborted();
      // The same text asked again while this one waited is answered now.
      if (cache.has(key)) return cache.get(key);
      if (Date.now() < shared.pausedUntil) return [];
      const url = new URL(photonSearchUrl(text, { endpoint, limit }));
      if (['en', 'de', 'fr', 'it'].includes(language))
        url.searchParams.set('lang', language);

      shared.nextRequestAt = Date.now() + MIN_GAP_MS;
      let features;
      try {
        features = await requestWithDeadline(
          async (requestSignal) => {
            const response = await fetchImpl(url, { signal: requestSignal });
            requestSignal.throwIfAborted();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return data?.features;
          },
          { signal, timeoutMs: TIMEOUT_MS },
        );
      } catch (error) {
        signal?.throwIfAborted();
        // A refusal, a timeout or a failed request (a refusal sent without
        // CORS headers arrives as one) all hold suggestions off a while.
        void error;
        shared.pausedUntil = Date.now() + PAUSE_AFTER_REFUSAL_MS;
        return [];
      }
      signal?.throwIfAborted();
      if (!Array.isArray(features)) return [];

      const seen = new Set();
      const places = [];
      for (const feature of features) {
        const normalized = normalizePhotonFeature(feature);
        if (!normalized) continue;
        const {
          city,
          state,
          country,
          countrycode: countryCode,
          osm_value: osmType,
          type,
          street,
          housenumber: houseNumber,
        } = feature.properties ?? {};
        // A house has no name of its own: its street and number are its
        // name, so two houses on one street stay two places.
        const address = street
          ? [houseNumber, street].filter(Boolean).join(' ')
          : '';
        const name = normalized.name || address || city || state || country;
        if (!name) continue;
        const detail = [...new Set([city, state, country])]
          .filter((part) => part && part !== name)
          .join(', ');
        const id = `${name}|${detail}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const { southwest, northeast } = normalized.viewport ?? {};
        places.push({
          name,
          detail,
          latitude: normalized.lat,
          longitude: normalized.lng,
          type: (osmType === 'administrative' ? type : osmType || type) || '',
          state: state || null,
          country: country || null,
          countryCode: /^[a-z]{2}$/i.test(countryCode ?? '')
            ? countryCode.toUpperCase()
            : null,
          extent: southwest
            ? [southwest.lng, northeast.lat, northeast.lng, southwest.lat]
            : null,
        });
        if (places.length >= limit) break;
      }

      cache.set(key, places);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return places;
    },
  };
}

/**
 * The cities that lie in a region: inside its extent (`[west, north, east,
 * south]`, as Photon gives it) and, when the region names a country by its
 * ISO code, in that country. Without either there is nothing to tell a
 * region's cities from its neighbours', so none are listed.
 * @param {Array<{latitude: number, longitude: number, country?: string}>} cities
 *   Bundled cities, `country` an ISO 3166-1 code.
 * @param {{extent?: ?Array<number>, countryCode?: ?string}} region
 */
export function citiesInRegion(cities, { extent, countryCode } = {}) {
  const box = Array.isArray(extent) && extent.length === 4 ? extent : null;
  if (!box && !countryCode) return [];
  return cities.filter(
    (city) =>
      (!countryCode || city.country === countryCode) &&
      (!box || inExtent(box, city)),
  );
}

/**
 * Whether a place lies in an extent `[west, north, east, south]`. An extent
 * across the antimeridian (west east of east) runs from west round to east.
 * @param {Array<number>} extent
 * @param {{latitude: number, longitude: number}} place
 */
export function inExtent([west, north, east, south], place) {
  const lon = place.longitude;
  const inLongitude =
    west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return place.latitude <= north && place.latitude >= south && inLongitude;
}
