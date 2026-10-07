# Source-linked discovery library

**DISCOVER** opens a public knowledge library independent of Demon Forge's private
case vaults. Its bundled starter has 15 CC0 Wikidata cards: nine selected Earth
places, two aircraft families, and four Moon/Mars features or mission sites. This
is a small editorial sample, not a complete atlas or a global importance ranking.

## Quick cards and lookup

Search installed cards by source ID, English/French name, description or alias.
Choose Earth, Moon or Mars and a category. Each card has a short structured
description, coordinates when available, selected source facts, Wikipedia and
official-site links where supplied, retrieval date and source revision. No full
Wikipedia prose, image bytes or map tiles are bundled in this increment.

The local lookup makes no model or web call. **Use the observed Earth center**
filters installed cards by distance from the globe's center. Manual coordinates
also work, using each body's own radius. **Go to this place** uses the existing
exact-coordinate navigation action; it is available only on Earth. Moon/Mars
cards keep their source's coordinate body and longitude convention, and are never
flown to or drawn on the terrestrial globe. They now link to
[independent spherical planetary overviews](PLANETARY-OVERVIEWS.md).

**Selected vehicle type** reads only the current aircraft type from the existing
selection facade. A matching Airbus A320 or Boeing 737 family alias selects the
corresponding sourced family card. It does not identify a specific aircraft from
imagery, infer a registration/operator, or turn a nearby landmark into the observed
object. Other vehicle types currently return no matching card.

## Local learning journeys

The learning panel offers three editorial routes: six monument cards, four
Moon/Mars sites and two aircraft families. Previous/Next selects the corresponding
installed card and its own body; Earth camera movement still requires the card's
explicit navigation button. Missing cards are labelled rather than retrieved or
invented automatically.

Each step offers a small deterministic source-reading quiz based on a recorded
height, coordinate body or primary source. Questions explicitly refer to the
installed snapshot; the source link names its archived revision. Aircraft-family
steps do not use a representative dimension as an identification of a live
vehicle. These are learning exercises, not a validated mastery assessment or
evidence that an AI model learned anything.

Last answers are stored separately under `gods-eye-view.discovery.learning.v1`
when browser storage is available. Revision and question changes invalidate the
corresponding saved answer. This local study state is not included in public pack
export and never enters geographic web requests. Reset local study progress
removes it. The journeys and quizzes work on the installed offline discovery page;
reading the complete external source revision still requires network access.

## Optional geographic web lookup

Local lookup uses exact source IDs, normalized text indexing and a bounded session
cache. Optional routing observations record counts and lookup times without raw
searches, coordinates or study answers. Recommendations never execute actions;
provider contracts remain disabled. See [routing and measurement](DISCOVERY-ROUTING.md).

Web lookup is off by default. Explicitly allow it, enter Earth coordinates and
request nearby cards. At most ten Wikipedia geographic results within 10 km are
resolved to Wikidata IDs in two bounded public requests. Entity metadata supplies
CC0 labels/descriptions and links; no Wikipedia article text is copied. Human
entities are excluded. Case titles, private notes, approvals, passphrases and live
contact identifiers never enter this source adapter.

Nearby results are suggestions associated with source IDs, not automatic visual
identity matches. Successful results join the local public library. Provider
failures retain the previous library. No broad named-person search, web crawling,
paid model call or System One provider is enabled by this implementation.

## Offline use

Open `/discovery.html` from the built local app (`npm run build`, then
`npm run preview`) and click **Install offline library**. The dedicated page
omits Cesium and map providers. Its service worker caches only that public page
and its local compiled JS/CSS assets: at most 32 assets and 5 MiB. It controls the
discovery page, not the globe, and never caches private APIs or external map tiles.
Installing again refreshes the cached shell. Browser storage and a secure browser
context are required; localhost/loopback is the normal local deployment.

After installation, reopen the same origin's `/discovery.html` without networking
to search/read installed cards. External Wikipedia/official links still require
network access. Offline cards, full offline articles, planetary maps and offline
3D terrain are separate capabilities. Clearing site data removes the installed
shell and locally saved public library.

Import/export public JSON packs with SHA-256 integrity checks. Import is capped at
2 MiB and 500 cards and validates schema, body coordinates and HTTPS source links.
The checksum detects changed content; it is not an author signature or independent
verification of source claims. Private case backup formats are refused. Public
packs use a separate `gods-eye-view.discovery.public.v1` storage key; they are not
encrypted and must contain only public data. Reset restores the bundled sample.

## Data and maintenance

Labels, short descriptions and selected claims are structured Wikidata data under
CC0. English/French article links do not imply redistribution of Wikipedia text
or media under CC0. The starter pins each entity revision and snapshot date.
`scripts/build-discovery-pack.mjs` regenerates it from a local `wbgetentities`
response and the explicit selection list; it starts no network requests itself.
Retain body metadata, revisions and licensing when adding cards.

The browser build helper's `discoveryPage` option is off by default. Standalone
composition enables the second HTML entry; the MCP panel still builds exactly one
inline document. Hosts denying localStorage can still show the bundled library;
persistent changes are unavailable there.

Validation includes local/schema tests, generic build/panel compatibility,
synthetic geographic source isolation, and a real-browser built-page walkthrough
with networking disabled after installation. Globe integration separately checks
exact-coordinate navigation, nearby filtering and aircraft-family selection.

Sources: [Wikidata access/licensing](https://www.wikidata.org/wiki/Help:Data_access),
[MediaWiki geographic search](https://www.mediawiki.org/wiki/API:Geosearch).
