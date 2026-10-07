# Discovery, quick knowledge cards and offline planetary atlas

Research date: 2026-10-05. This is a proposal and gap audit, not an implemented
feature or an approved integration with any external model service.

Implementation update: the initial [source-linked discovery library](DISCOVERY.md)
is now implemented locally, including 15 starter cards, public packs and a
standalone offline shell. [Historical imagery and soil estimates](AREA-SCIENCE.md)
are also implemented locally. Three source-reading learning journeys and local
quizzes are now available. Detailed planetary terrain, full offline articles and optional
Parcimonia/System One adapters remain future increments. Independent Moon/Mars
spherical overview pages and small original NASA map packs are now available;
see [planetary coverage and limits](PLANETARY-OVERVIEWS.md).

## Intent

Provide fast, sourced information about observed places, mapped objects and
vehicles; encourage discovery and learning; support installable offline packs for
Earth, Moon, Mars and eventually other bodies. Minimize API and model calls.
Keep the public encyclopedia independent of encrypted private investigation cases.

## Existing foundation and missing behavior

`src/tools/queries/environment.js:getMapFeatures` already queries monuments and
memorials within 2.5 km, administrative areas and named map features. Existing
aviation/maritime queries and selected-contact context already provide structured
vehicle metadata. The new area workspace provides evidence and offline encrypted
case persistence, not an offline encyclopedia or offline global imagery.

Missing: entity-linked Wikipedia/Wikidata cards; local searchable POI packs;
guided discovery and learning paths; explicit body-aware coordinates; a planetary
viewer with open offline maps; optional cost-aware decision-provider adapters.

## Google Earth comparison

Official Google Earth documentation describes knowledge cards, searchable places,
saved placemarks, rich text/link/image/video content, narrative presentation,
KML import/export, 3D views and Street View. Google Earth Education documents
Voyager guided tours and educational content. These functions are useful product
references; current availability differs by product/platform and this research
does not assert parity across Earth Web, Pro, mobile or VR.

First equivalent: a sourced quick card on a selected feature and an "Explore
nearby" list, followed by curated thematic journeys and saved public collections.
Reuse existing scene/view tools rather than constructing another globe UI.

## Data and offline design

- Wikidata: stable QIDs, names, descriptions, coordinates, entity types and
  Wikipedia/official-site links. Structured data is CC0; snapshots have dates.
- Wikipedia/Wikivoyage: encyclopedia and travel/learning content. Kiwix/ZIM is
  an established offline packaging option. Retain applicable text and media
  attribution/licenses separately from Wikidata's structured-data license.
- OSM: mapped POIs and existing infrastructure. Preserve ODbL attribution and
  dataset provenance. Use licensed distributable datasets/map packages, not bulk
  harvesting of public tile servers.
- USGS/IAU planetary nomenclature: named features for Moon, Mars and other
  bodies, including downloadable KML/shapefiles. Combine with separately licensed
  NASA/USGS scientific imagery and mission information after source review.

Packages should declare body, coordinate frame, longitude convention, source
revision, languages, license, attribution, byte size and checksum. Start with
selected landmarks and small thematic/regional packs; full encyclopedias and
high-resolution terrain are separate optional downloads. A local index can use
SQLite FTS/spatial indexing on a local backend, or browser-side indexes for small
packs. Offline encyclopedia, offline basemap, and offline imagery are distinct
capabilities that must be tested separately.

Moon/Mars coordinates cannot be treated as terrestrial WGS84 positions. Preserve
body-specific radius/ellipsoid, planetocentric/planetographic convention and east/
west longitude. Add explicit Earth/Moon/Mars controls; do not place lunar markers
on the existing Earth globe.

Google Maps Map Tiles API policy expressly excludes offline use and image
analysis/machine interpretation/object identification. Do not use those tiles to
build offline packs or feed a recognition model. Use licensed open imagery for
optional perception experiments; retain the existing online Google visualization
as a separate renderer/provider.

## Cheap lookup and optional System One routing

Recommended order: exact source ID/QID or vehicle type -> local spatial/text index
-> existing licensed cache -> open web lookup when enabled -> optional small
decision model for ambiguous ranking/routing -> optional text synthesis.
Ordinary fact lookup should not require a model call.

Jev (TypeSafe), Laya and OpenJev target typed yes/no, choice and score decisions.
They can help select a source, rank candidate entities or decide whether evidence
is sufficient to show a suggested association. They are not encyclopedias and
typed output does not establish factual correctness or calibrated confidence.
OpenJev names multiple repositories/forks; select an exact revision and supported
hardware before planning integration.

Inspection of the Parcimonia checkout describes it as an adaptive compute
router with observation-only/shadow operation. `docs/LOCAL_DECISION_PILOT.md`
records an experimental Laya adapter and a small fixture pilot; it does not
establish production savings or justify replacing the deterministic baseline.
Parcimonia should propose the least-cost mechanism under declared locality,
evidence, latency and budget constraints. The host owns intent and authorization;
verifiers and measured outcomes govern acceptance/escalation.

Model-provider adapters should be optional and off by default. Keep vendor/model
packages out of the base globe bundle. Start in shadow mode against a labeled
discovery/routing benchmark; measure exact entity matches, abstention, latency,
memory and actual cost. No provider's advertised speedup is assumed for this app.

## Staged delivery

1. Earth quick cards: existing POI lookup, Wikipedia/Wikidata/official-site links,
   explicit entity association, dates and sources. Aircraft/vessel type cards
   distinguish class knowledge from verified information about a live vehicle.
2. Small offline landmark packs and discovery lists; validate app launch and card
   lookup with networking disabled. Curated packs label their selection criteria.
3. Educational paths, comparison cards, sourced quizzes and optional local
   summaries. Separate user learning content from any model-training claims.
4. Body-aware Moon/Mars viewer and landmark packs: geological features, mission
   landing sites and exploration history; optional open map/terrain packages.
5. Parcimonia shadow routing with exact optional Laya/OpenJev/Jev adapters after
   measuring the deterministic/local-index baseline. Activate only on demonstrated
   quality/cost improvement and explicit provider configuration.

Keep these capabilities modular, with separate data provenance and proof limits.
Public discovery, private case metadata, planetary rendering and optional routing
have independent lifetimes and storage boundaries. Model-provider activation
remains a separate configuration and measurement step.

## Primary sources

Implementation follow-up: the first five local gates now cover public cards,
offline installation, source-reading journeys, independent Moon/Mars overviews
and deterministic routing diagnostics. The [routing gate](DISCOVERY-ROUTING.md)
separates a 12-fixture baseline from real Parcimonia core execution (12 strict-
local abstentions) and synthetic System One protocol tests. No learned routing
gain, paid inference or production cost saving is claimed. Each capability's
documentation records its scope, data provenance and validation boundaries.

- [Google Earth features](https://developers.google.com/maps/documentation/earth/add-features-to-projects?platform=computer)
- [Google Earth stories and projects](https://www.google.com/intl/en_ca/earth/outreach/learn/create-a-map-or-story-in-google-earth-web/)
- [Google Earth educational discovery](https://www.google.com/intl/en_uk/earth/education/explore-earth/)
- [Wikidata access and licenses](https://www.wikidata.org/wiki/Help:Data_access)
- [MediaWiki geographic search](https://www.mediawiki.org/wiki/API:Geosearch)
- [Kiwix offline reader](https://get.kiwix.org/en/solutions/applications/kiwix-reader/)
- [USGS planetary downloads](https://planetarynames.wr.usgs.gov/GIS_Downloads)
- [Google Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies)
- [TypeSafe Jev introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Laya decision engine](https://github.com/NandhaKishorM/laya)
- [OpenJev local implementation](https://github.com/lookski/openjev)
- [OpenJev DiffusionGemma fork](https://github.com/SteFletcher/openjev/blob/main/README.md)
