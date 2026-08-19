# Tracker: working conventions

A real-data situational-awareness globe. CesiumJS frontend, FastAPI backend.
One backend process owns every upstream feed; the browser only ever talks to us.

**Why it exists.** A demo of wealth profile enrichment for Altrata, built on public data
only. The business collects data on people and organisations, resolves it to one profile,
joins it up and sells the insight. The population is the wealth tiers: UHNW over $30m,
VHNW $5m to $30m, HNW over $1m, plus Likely UHNW and Likely VHNW on partial valuations.
Use those exact terms, one tier per profile, higher tier wins. This project rebuilds the
profile-to-asset join from public sources. Read
[business context](docs/business-context.md) before changing anything user-facing.

## Commands

```bash
uv sync                                  # install backend + dev tools
uv run tracker                           # serve backend on :8000
uv run pytest                            # tests, branch coverage, fail_under=85
uv run ruff check . && uv run ruff format --check .
uv run ty check                          # fast type check, runs on every commit
uv run mypy                              # strict, the correctness gate in CI
uv run python scripts/dump_openapi.py    # refresh openapi.json (committed)
cd frontend && pnpm dev | pnpm test | pnpm lint | pnpm typecheck | pnpm codegen
```

Both type checkers run and neither replaces the other. ty is quick and is right about
`@computed_field` over `@property`, where mypy reports a false `prop-decorator` error.
mypy with the pydantic plugin catches constructor arguments on a generic pydantic model,
for example `Env[int](payload="x")`, which ty passes clean. ty does not honour mypy's
coded `# type: ignore[...]`, so a line needing both carries both, mypy first:
`# type: ignore[arg-type]  # ty: ignore[invalid-argument-type]`. Reversing that order
stops mypy honouring its own ignore.

Verification before claiming anything is done:
`uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run mypy && uv run pytest -m "not live" && (cd frontend && pnpm verify)`

## Layout

- `src/tracker/contracts/` strict Pydantic domain models, one module per entity class
- `src/tracker/sources/` one adapter per upstream feed, permissive wire models inside
- `src/tracker/services/` store, hub, pollers, enrichment, classification, search
- `src/tracker/api/` FastAPI routers
- `frontend/src/globe/` Cesium viewer and one module per render layer
- `tests/fixtures/` recorded real upstream payloads, used by tests only
- `docs/` architecture, data sources, status, decisions, plan, spec

## Geospatial conventions

Non-negotiable. Violations are bugs even when the code appears to work.

- Coordinate order is `[longitude, latitude]` in every contract, GeoJSON style.
- WGS84 / EPSG:4326 throughout the domain. Cesium owns all projection.
- Degrees in contracts. Radians only inside orbital maths, converted at the boundary.
- Altitude in metres above the WGS84 ellipsoid. Feeds sending feet are converted in the
  source adapter, never downstream.
- Times are timezone-aware UTC, ISO 8601 in contracts. A naive datetime is a validation
  error; use `contracts.base.UtcDatetime`.
- Bearings are degrees clockwise from true north, `0 <= x < 360`.

## Contract discipline

Two layers, and the boundary between them is the point.

- **Wire models** live inside a `sources/` adapter, are permissive (`extra="ignore"`),
  and mirror exactly what the upstream sends including its inconsistencies.
- **Domain contracts** live in `contracts/`, derive from `StrictModel`
  (`strict=True, extra="forbid", frozen=True`), and are what the rest of the app sees.
- The adapter maps wire to domain explicitly. A record that will not map is dropped and
  counted, never partially accepted.

Reason: `/v2/mil` returns eight fields `/v2/point` does not. A strict model at the wire
layer would reject every military aircraft; a permissive model in the domain would let
junk reach the renderer.

## Gotchas

Each of these has already cost time or would break something silently.

- `adsb.lol` `alt_baro` is a number **or** the string `"ground"`. `flight` is
  space-padded (`"RAM801F "`). `type` is the message source (`adsb_icao`), the aircraft
  type designator is `t`, and the registration is `r`.
- Heading resolution order: `track`, then `true_heading`, then `mag_heading`, then `dir`.
  Only about half of live records carry `track`.
- `dbFlags` bit 1 (value 1) is military; bit 4 is a privacy ICAO address. PIA aircraft are
  displayed anonymised and never unmasked.
- CelesTrak permanently firewalls abusive clients. Never fetch a group more than once per
  two-hour window. The guard is in code and asserted by a test, not left to config.
- CelesTrak `EPOCH` is naive but is UTC by specification. Attach UTC in the adapter.
- Always pass `FORMAT` explicitly to CelesTrak; the default changed to CSV in May 2026.
- Satellite positions come out of SGP4 in TEME. Convert to ECEF via GMST at the *same*
  timestamp or the whole constellation smears diagonally.
- Never expose the aisstream, Windy or TfL key to the browser. Keyed feeds are proxied.
- Windy image tokens expire after ten minutes. Never cache an image URL beyond validity.
- Cesium's `Entity` API collapses in the low thousands of movers. Use
  `PointPrimitiveCollection` / `BillboardCollection` and mutate positions in place. This
  cannot be retrofitted; it is a rewrite.
- Multiple uvicorn workers each run lifespan and so duplicate every poller. Pollers run
  in a single process until a lock exists.
- Nominatim and Overpass require a descriptive User-Agent with contact details and are
  rate-limited to roughly one request per second. Cache server-side; never call from the
  browser.
- GeoNames `cities15000` is a tab-separated bulk file with no header and 19 fixed columns.
  Column 6 is latitude and column 7 is longitude, the opposite of our contract order.
  Cities do not move, so this is a weekly download into a local index, never a poller and
  never a TTL store.
- A Mastodon status object has **no coordinates**, no place object, nothing positional. Any
  location on a post is derived from its text and is labelled as derived. See ADR 005.
- `mastodon.social` answers HTTP 422 "requires an authenticated user" on its public
  timeline; `mas.to` answers 200 for the identical request. Instances are configuration and
  a 401, 403 or 422 drops that instance for the cycle rather than failing the feed.
- Wikidata WDQS has a 60-second query timeout and blocks generic User-Agents. Every query
  ships with a `LIMIT`.
- Wikimedia Commons, Mastodon and Flickr license each record separately. The item's own
  licence and author travel with it into the domain contract, and an item whose licence
  cannot be determined is dropped and counted rather than shown.

## Data sourcing

Scraped and crowd-sourced sources are permitted, on the people layer included. See
`docs/decisions/004-permitting-scraped-and-crowd-sourced-data.md`, which amends ADR 002.
This matches how the business itself collects: the Leadership Extractor scrapes company
leadership pages across the whole private organisation universe weekly, the Annual Report
Extractor pulls boards and leadership out of filings, and the AI Profile Builder builds
profiles from the open web. All three put a machine on the fetch, a language model on the
extract and a researcher on the verify. See [business context](docs/business-context.md).

The business buys data as well as scraping it: licensed wealth and identity files, and
bought contact files supplying address, email and phone at scale. **This project buys
nothing.** It is public sources only, so a bought file never appears here, and a contract
field that a bought file would fill in production simply sits empty. Do not add a vendor
feed, and do not fabricate a value to stand in for one.

**No human verification in this project.** It is a proof of concept and a demo: no
researcher, no review queue, no QA step, no approval state, no admin accept/reject screen.
Never design anything on the assumption a person will check it. The machine carries the
burden instead: strict contracts, unmappable records dropped and counted, a confidence
threshold below which no link is asserted, low-confidence matches shown as unconfirmed and
excluded from aggregates, and provenance on every card. This is a rule, not a backlog item.

The obligations that come with scraped and crowd-sourced input:

- Record every source in `docs/data-sources.md` with how it was collected, its licence or
  terms position, cadence and verification date. Say plainly when a source is scraped.
- Scraped and user-submitted input is the least trustworthy input in the system. Permissive
  at the wire layer, strict at the domain layer, unmappable records dropped and counted.
- Show provenance on the card. A scraped or crowd-sourced origin is displayed as such,
  never presented as authoritative.
- Honour `robots.txt`, published crawl delays and stated request caps in code. Descriptive
  User-Agent with contact details. Cache server-side, never scrape from the browser.
- Do not scrape a source whose terms prohibit scraping or redistribution. ADSBexchange's
  globe map is the worked example: 403 on the tiles and prohibited by name.

## The people layer

Read `docs/superpowers/specs/2026-08-19-tracker-design.md` section 8 and ADR 002 for the
reasoning, then ADR 004, ADR 006, ADR 007 and ADR 008 for what changed. Person records are no
longer limited to Wikidata entities reached through the seven-property allowlist, and scraped
and crowd-sourced person data is allowed under the sourcing rules above.

**The profile carries the production attribute set**, per ADR 008, because a thinner profile
demos a thinner product than the one that exists:

- Identity: name and alternate names, date of birth, age, gender, nationality, deceased
  date, hometown or place of birth.
- Contact: personal and business email, personal and business phone, postal addresses
  including a home address, social handles including LinkedIn.
- Wealth tier, roles, and dated locations.

Contact and identity attributes are match keys before they are display fields, and the
entity resolution in phase 6 uses them. Every rule below applies to them exactly as it
applies to a location: a date, a source, dropped and counted if undated, labelled derived if
produced by a join, provenance on the card.

Contact attributes are **marked PII in the contract** so the card and the API can serve a
profile with them suppressed. The business sells packages defined by that exclusion
(`NoContactData`, `NoPII`), so it is a demo feature rather than plumbing.

Public sources fill few of these. Where a field is empty it is empty: no default, no
approximation, no inference.

**Location is a profile attribute.** Residence city or region, business or registered
address from a public record, home address, work and education location, and publicly
reported past appearances that resolve to a place. Rules that make it work:

- Every entry carries a date and a source. An undated location fails the contract and is
  dropped at the adapter and counted.
- Location is a dated series, not one current value. A profile that has moved has two
  dated entries.
- An entry produced by joining sources is labelled **derived**, not reported, and that
  label reaches the card.

**A person may be joined to any data in the system**, live position feeds included. ADR 007
removed the firewall that used to sit here and there is no prohibited join. What each join
must carry, asserted by a test:

- Its source, its confidence and its as-of date, all rendered on the card.
- A join below the confidence threshold is displayed as a possible match with its score and
  is excluded from every aggregate count. It is never asserted.
- An inference is labelled as an inference. An owned jet being airborne is a fact about the
  aircraft; "the owner is aboard" is an inference, and the card says which it is making.
- A join to a live feed produces a dated location entry like any other, sourced to the feed
  and dated to the observation. It does not become a current-location field.

What has not changed, and is not up for a feature request:

- No face recognition or person identification on any camera image.
- No aggregators of unsecured private cameras.
- No wealth tier, net worth figure or wealth signal inferred from a live feed, a position
  or a track. A tier comes from a profile or it does not exist. Owning a jet is not an
  estimated net worth.
- UHNW individuals are a security-sensitive population, and a home address or phone number
  joined to a live asset position is the highest-harm thing this project can hold. With the
  joins permitted and the attributes in, the only things limiting exposure are the confidence
  threshold, the provenance display, the PII suppression and the removal control. None of the
  four is negotiable and none is tuned down for a better-looking demo.
- A wrong contact attribute is worse than a wrong location: it attaches a real stranger to a
  named profile and gives someone a way to contact them. Sub-threshold matches stay
  unconfirmed.

**Right to be forgotten, honoured whatever the jurisdiction.** The report control and a
removal request both remove **and suppress** a person record. Suppression is keyed
independently of ingest so the next crawl does not resurrect it, the key holds no more
personal data than the flag needs, and the suppression shows in the product with its reason.
Same mechanism as FAA LADD suppression. There is no queue and no human step here, so the
control takes effect immediately.

We honour it as policy, not because a regulator compels it. **This project is not in GDPR
jurisdiction**: the profiles and the customers are in the United States, which has no single
federal privacy law and instead a state patchwork, with California's CCPA and CPRA the
sharpest edge and the California Delete Act reaching data brokers directly. The CCPA right to
delete is narrower than GDPR erasure and reaches information collected from the consumer
rather than everything held. Any UK GDPR wording still lying around this repo is wrong; ADR
008 settled it.

Before any public deployment carrying real profiles, the US privacy position is a phase 6
deliverable: which state laws reach the population, how access and deletion requests are
served inside the statutory windows, and whether data broker registration applies.

## The social post layer

Read ADR 005 before touching it, then ADR 007 for what changed. The short version: the pin
a post draws is about its subject, because no source in this layer reports an author
position. Joining a post to a person is permitted.

- `SocialPost` carries a required `location_basis`. `upstream` means the source gave us the
  coordinate (OpenStreetMap notes, Commons geosearch, Flickr `has_geo`). `derived` means we
  resolved it from the words (Mastodon). No post exists in the domain without saying which.
- A derived location is matched against the city gazetteer only. No per-post geocoding
  call, no precision finer than the city, no fallback geocoder.
- A post may be joined to a person or organisation record, per ADR 007, and the join carries
  its source, confidence and date. The `derived` label travels with it: a city-level match
  from a post's words never reads as an observed position.
- A post is a fixed event with a timestamp: no dead reckoning, no interpolation. Posts
  joined to a profile form a dated series like any other location evidence, and the globe
  shows them as dated points rather than drawing a route between them, because the route is
  not something any source reported.
- Media is proxied and cached, never hot-linked. No face recognition on any image.

## Documentation rules

- Update the relevant doc in the same commit as the change.
- `docs/data-sources.md` is the single source of truth for feed facts. Never write an
  endpoint into it that you have not called successfully. Record the verification date.
- `docs/status.md` is the only file expected to churn: Now, Works, Broken, Next.
- ADRs under `docs/decisions/` are append-only.
- Reference code as `path:line`, do not paste snippets into docs.

Docs index: [business context](docs/business-context.md) ·
[architecture](docs/architecture.md) ·
[data sources](docs/data-sources.md) · [status](docs/status.md) ·
[plan](docs/plan/implementation-plan.md) · [decisions](docs/decisions/)
