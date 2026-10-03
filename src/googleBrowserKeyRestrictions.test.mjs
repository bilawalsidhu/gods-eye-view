// The browser-exposed Google key cannot carry an HTTP referrer restriction as
// shipped (#363).
//
// SECURITY.md and .env.example both used to say "restrict the browser Google
// key (HTTP referrer + API restriction)". Following that advice breaks place
// search: the browser calls the Geocoding WEB SERVICE endpoint
// (`maps.googleapis.com/maps/api/geocode/json`) directly, and Google rejects
// referrer-restricted keys on every web service endpoint —
//
//   { "status": "REQUEST_DENIED",
//     "error_message": "API keys with referer restrictions cannot be used with this API." }
//
// Referrer restrictions apply to the Maps JavaScript API and client SDKs, not
// to web services. Photorealistic 3D Tiles are fetched client-side and would
// honour one, which is what made the guidance look right; geocoding is the
// endpoint that cannot.
//
// A doc sentence is the whole fix here, so nothing in the test suite would
// notice it drifting back. These pins cover both directions: the guidance has
// to keep saying API-scope-only, and the code it is describing has to keep
// being browser-direct web-service calls (if geocoding moves behind a server
// proxy, the restriction warning should be revisited — see #363 option 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const GEOCODE_WEB_SERVICE = /maps\.googleapis\.com\/maps\/api\/geocode\/json/;

/**
 * Whether `text` instructs the reader to apply an HTTP referrer restriction.
 *
 * Keyed on the literal "HTTP referrer" phrase the original guidance used, and
 * exempting negated sentences — the correction itself has to name the thing it
 * corrects ("once no browser code calls a web service with this key,
 * referrer-restrict it as this document originally said"), so a bare search for
 * the phrase would forbid the fix as well as the bug.
 */
function instructsReferrerRestriction(text) {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  return sentences.some(
    (sentence) =>
      /http referrers?/i.test(sentence) &&
      /\brestrict\w*/i.test(sentence) &&
      !/\b(?:cannot|can't|do not|don't|never|not)\b/i.test(sentence),
  );
}

test('the browser key reaches the Geocoding web service from the browser', () => {
  // The premise of the warning: if this ever stops holding, geocoding moved
  // server-side and the restriction guidance can be relaxed (or deleted).
  for (const file of ['src/search/defaults.js', 'src/search/http.js']) {
    assert.match(
      read(file),
      GEOCODE_WEB_SERVICE,
      `${file} must still call the Geocoding web service endpoint directly`,
    );
  }

  // Both call sites resolve the key from the browser-visible injector, so the
  // key in those requests is the client-exposed one, not a server key.
  assert.match(
    read('src/search/defaults.js'),
    /url\.searchParams\.set\('key', key\)/,
    'the forward geocoder must send the resolved browser key',
  );
  assert.match(
    read('src/search/http.js'),
    /\.\.\.\(key \? \{ key \} : \{\}\)/,
    'the reverse geocoder must send the resolved browser key when present',
  );
});

test('SECURITY.md does not tell operators to referrer-restrict the browser key', () => {
  const security = read('SECURITY.md');

  assert.ok(
    !instructsReferrerRestriction(security),
    'SECURITY.md must not instruct an HTTP referrer restriction on the browser Google key (#363)',
  );

  // The failure mode has to be named, or the correction reads as a policy
  // preference and the next edit re-adds "HTTP referrer".
  assert.match(
    security,
    /cannot be applied to this key as shipped/i,
    'SECURITY.md must state the referrer restriction cannot be applied as shipped',
  );
  assert.match(
    security,
    /API keys with referer restrictions cannot be used with this API/,
    'SECURITY.md must quote the verbatim Google error so it is recognisable in the console',
  );
});

// Review feedback on #868: dropping the referrer advice is only correct if the
// replacement does not read as though API scoping fixes the security problem.
// Google's guidance says web-service keys are not expected to be publicly
// exposed, so the document has to say plainly what the weaker restriction
// leaves behind. Without these the next edit can quietly turn the workaround
// back into a recommendation.
test('SECURITY.md is explicit that API scoping alone is not a safe configuration', () => {
  const security = read('SECURITY.md');

  assert.match(
    security,
    /workaround, not a fix/i,
    'SECURITY.md must frame API-only scoping as a temporary workaround',
  );
  assert.match(
    security,
    /copy it and use it against the Geocoding API/i,
    'SECURITY.md must say the exposed key can be lifted and spent by anyone who loads the page',
  );
  assert.match(
    security,
    /quotas and budget alerts bound damage, they do not restrict access/i,
    'SECURITY.md must say quotas cap spend rather than restricting who may call the API',
  );
  assert.match(
    security,
    /prefer the server-side geocoding proxy \(#693\)|client-side Maps JavaScript API geocoding surface/i,
    'SECURITY.md must point hosted deployments at the server proxy or Maps JS geocoding (#693)',
  );
  assert.match(
    security,
    /#693/,
    'SECURITY.md must reference #693, the change that makes a referrer restriction possible again',
  );
});

test('.env.example does not tell operators to referrer-restrict the browser key', () => {
  const example = read('.env.example');
  assert.ok(
    !instructsReferrerRestriction(example),
    '.env.example must not instruct an HTTP referrer restriction on the browser Google key (#363)',
  );

  // The key entry is what an operator reads while filling in the file, so the
  // warning has to sit on that entry — not only in SECURITY.md. Comment markers
  // are stripped so a wrapped line still matches.
  const googleKeyEntry = example
    .slice(0, example.indexOf('\nGOOGLE_MAPS_API_KEY='))
    .replace(/^#\s?/gm, '')
    .replace(/\s+/g, ' ');

  // Same three points as SECURITY.md: this is temporary, the key is liftable,
  // and quota alerts are a cap rather than a restriction. The entry is the one
  // place an operator is guaranteed to read while configuring the key.
  assert.match(
    googleKeyEntry,
    /TEMPORARY WORKAROUND, not a secure configuration/i,
    'the GOOGLE_MAPS_API_KEY entry must label the state a temporary workaround',
  );
  assert.match(
    googleKeyEntry,
    /copy the key and use it against\s+the Geocoding API/i,
    'the GOOGLE_MAPS_API_KEY entry must warn the key can be copied and spent',
  );
  assert.match(
    googleKeyEntry,
    /only cap the damage — they do not\s+restrict who can spend it/i,
    'the GOOGLE_MAPS_API_KEY entry must say quotas cap damage, not restrict access',
  );
  assert.match(
    googleKeyEntry,
    /prefer the server-side\s+geocoding proxy \(#693\)/i,
    'the GOOGLE_MAPS_API_KEY entry must point hosted deployments at #693',
  );
});

test('the dual-stack IPv6 caveat is documented for the IP-restricted server key', () => {
  // An IPv4-only restriction on an IPv6-egressing host fails with
  // API_KEY_IP_ADDRESS_BLOCKED, which reads like a broken key (#363).
  for (const file of ['SECURITY.md', '.env.example']) {
    const text = read(file);
    assert.match(
      text,
      /API_KEY_IP_ADDRESS_BLOCKED|IPv4 AND IPv6|IPv4 and IPv6|IPv4 and the IPv6/i,
      `${file} must document the dual-stack IP caveat for GOOGLE_MAPS_SERVER_API_KEY`,
    );
  }
});

test('the server key stays IP-restricted, never referrer-restricted', () => {
  // Unchanged by #363 and worth pinning: the server key never leaves the
  // server, so a referrer restriction on it would be the same mistake.
  const security = read('SECURITY.md');
  assert.match(
    security,
    /the server key IP-restricted \(never a referrer, since it never leaves your server\)/,
    'SECURITY.md must keep documenting the server key as IP-restricted',
  );
});
