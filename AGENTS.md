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
- `dbFlags` bit 1 (value 1) is military; bit 4 is a privacy ICAO address. A PIA aircraft is
  displayed anonymised until phase 11 correlates it to a registration, per ADR 009. The PIA
  flag stays on the record after correlation and the card says the identification is
  inferred, never observed. LADD is not applied at all: it binds FAA-provided feeds and our
  positions come from volunteer receivers.
- **Live-mover layers are a union of providers, not one with a failover** (ADR 010). Merge
  key is the existing identity: ICAO 24-bit address for aircraft, MMSI for vessels. Every
  record carries which provider supplied it and how old
  that report is. Conflicts resolve by recency, never by provider precedence, and two
  positions are never averaged into a third no receiver reported. One record per hex is
  asserted by a test: the obvious bug here is one aircraft counted three times.
- ADS-B Exchange does not filter aircraft on FAA blocking programmes, which is why it is in
  the union. Access is a paid RapidAPI key (`adsbexchange-com1.p.rapidapi.com`, verified 401
  without one) or a free feeder key. Its terms **prohibit redistribution**, and serving
  positions to a browser is redistribution, so that is a licence blocker on the layer.
- **Never touch the ADS-B Exchange globe map endpoints.** `/data/aircraft.json` and `/re-api/`
  answer 403 "Request forbidden by administrative rules", and `robots.txt` disallows `/api/`,
  `/mapproxy/`, `/re-api/` and `/globe_history/` by name. The API is the only way in.
- airplanes.live answers 403 until you email them a project description; adsb.one was
  Cloudflare-blocked from our network on 2026-08-19. Both serve the same readsb v2 schema, so
  neither needs parser work once access lands.
- Per-provider cadence floors, not one global floor. adsb.lol tolerates a short cycle; a
  metered ADS-B Exchange key does not, so its calls are demand-driven rather than a sweep.
- **AISHub only grants API access to members running a physical AIS receiver**: at least 10
  vessels averaged over 7 days, 90% uptime, downsampling no coarser than 60s, delay under 10s,
  streamed as raw NMEA to a UDP port they allocate. Feeding them synthesized NMEA, scraped
  data or data from other public AIS services is prohibited by name, so there is no software
  route in. No username means the layer reports itself unavailable, like any missing key.
- **AISHub signals failure with HTTP 200 and an empty body**, both for a bad username and for
  a call more often than its documented once per minute. An empty 200 is an error, counted,
  and it must never empty the vessel store. Asserted by a test.
- AISHub `output` defaults to XML, so pass `output=json` explicitly, same trap as CelesTrak's
  `FORMAT`. Use `format=1` for degrees, knots and metres; `format=0` scales longitude and
  latitude by 600000, course and speed by 10, draught by 10.
- AISHub sentinels are not nulls: course 3600 (or 360.0), speed 1024 (or 102.4), heading 511
  and `IMO` 0 all mean "not available" and map to `None`. Its timestamp is `TIME` in JSON but
  `TSTAMP` in XML and CSV, and the human-readable form is naive with a `GMT` suffix, so attach
  UTC in the adapter.
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
- Sentinel-2 scenes come from earth-search STAC, keyless, `POST /v1/search` with `collections`,
  `bbox` and `datetime`. **Filter on `eo:cloud_cover`**: both London scenes on 2026-08-18 came
  back at essentially 100% cloud, and an unfiltered search returns white rectangles that look
  like a broken layer. Revisit is about five days, so imagery for a requested date usually does
  not exist. Carry the scene's own timestamp, never the requested one. `visual` is a
  Cloud-Optimised GeoTIFF and cannot go straight to a browser.
- **NASA Worldview snapshot `BBOX` is `south,west,north,east`, latitude first**, the opposite of
  this project's `[longitude, latitude]` rule. Flip it in the adapter. Getting it wrong returns
  a valid image of the wrong place, which nobody notices.
- TfL JamCams need **no key**. `lat` and `lon` are top-level but `available`, `imageUrl`,
  `videoUrl` and `view` are key-value pairs inside `additionalProperties`. A camera can be
  listed and dark, so honour `available` or the layer ships a stale frame presented as live.
  The inventory is 1.1MB: fetch daily, never per view.
- New York 511 is keyless and is **video, not stills**: `VideoUrl` is an HLS `.m3u8` and there is
  no image field at all. 1,066 of 2,931 cameras are `Disabled` and a second flag, `Blocked`, is
  set by the operator during an incident. Honour both, and remove a blocked camera rather than
  greying it out. Other states are not the same API: WSDOT answered 401 without a key.
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
- GDELT's DOC 2.0 article API states its own cap in the body of its 429: one request every
  five seconds. It answers 429 with a plain-text notice rather than JSON, so a parser that
  assumes JSON on any 2xx-or-not will throw. Cache per profile and back off.
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

**Enrichment is cross-source corroboration, not single-source assertion** (ADR 011). No
single online source is trusted on its own, because there is no researcher here to check it.
The rules, all asserted by tests:

- Every enriched attribute carries the **set** of sources supporting it, and its confidence
  is a function of how many independent origins agree.
- **Independence is judged at the origin.** Two aggregators carrying the same wire story are
  one source, and a Wikidata statement referencing the Wikipedia article that cites the same
  press release is one source. Where independence cannot be shown it is treated as absent.
- A single scraped or crowd-sourced source **never** crosses the assertion threshold alone.
  Primary records (a filing, a registry extract) may, because the source is the record.
- Corroboration raises confidence, never precision. Three sources saying London is a city.
- Conflicting dated values both stay, with the disagreement shown. Nothing is silently
  overwritten, and a combined value is labelled derived.
- Corroboration is its own service over domain contracts, not logic inside an adapter.

**Three enrichment paths produce a location, all dated and all corroborated.** A post's own
upstream coordinate; a location resolved from a post's words against the city gazetteer,
labelled derived (ADR 005); and a **person mentioned in a news or online report** that
resolves to a place, which is a report about a person rather than an observation of one, so
it is derived, city-level, sourced to the article and dated to its publication. GDELT DOC 2.0
is the news source, keyless, capped by the provider at one request per five seconds.

**Occupancy of an aircraft or vessel is estimated, and always labelled an inference**
(ADR 012, phase 12). It draws on registry ownership, movement history we recorded ourselves,
the live track and route pair, the associate graph from public filings, and each candidate's
dated locations from every other layer. Non-negotiable: contradiction beats corroboration, so
a corroborated location elsewhere in the window removes a candidate outright; below the
threshold nothing is named and the card reads "occupants not established"; the estimate is
excluded from every aggregate, never writes a location entry onto a profile, and never touches
a wealth tier; suppressed people are excluded from candidate generation, not filtered
afterwards. This is the highest-harm output in the system.

**FAA LADD and privacy ICAO addresses are worked through, not honoured** (ADR 009). A
LADD-listed aircraft resolves and displays like any other and LADD membership is an attribute
on the profile. A privacy address is correlated back to a registration in phase 11, above a
threshold set higher than for an ordinary registry join, with the anonymity and the inference
both shown on the card.

**People are identified in photographs, against the profiles we already hold** (ADR 013,
phase 14). It is 1:N against the profile list, never open-set identification of the public.
The reference face is Wikidata P18 resolved to Commons, so no P18 means no match and none is
asserted. A face detected in a photograph that matches no profile is discarded rather than
stored: we do not accumulate face data on people we hold no profile for. The threshold sits
above an ordinary registry join, a face match alone never crosses the assertion threshold
under ADR 011, the card says the identification is inferred from a named photograph, and a
suppressed person is out of the candidate set rather than filtered from the output. **It is
not applied to camera feeds.** A written legal position from counsel naming the jurisdictions
and the consent basis is a blocker on public deployment carrying real profiles, alongside the
phase 6 US privacy position. ADR 013 records that this reverses every prior exclusion in the
repo and that the decision was Alexander Fanthome's.

One thing is still out, and it is not a policy preference about joins:

- **Aggregators of unsecured private cameras.** Those index cameras whose owners
  misconfigured them, so using them is unauthorised access to a private system: Computer
  Misuse Act 1990 in the UK, state computer-access statutes and the CFAA in the US.
  Owner-published and official feeds cover the camera layer: TfL JamCams and New York 511 are
  both keyless and verified, Windy needs a key.

What has not changed:

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
Since ADR 009 stopped the product applying FAA LADD, this is the only suppression path
there is, and it is ours. There is no queue and no human step, so it takes effect
immediately.

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
- One post is one weak source. A location entry resting on a single post stays unconfirmed
  until an independent origin agrees, per ADR 011, and it is a candidate contradiction or
  corroboration for the phase 12 occupancy estimate.
- Media is proxied and cached, never hot-linked.

**Post content is analysed for four things, and they are not the same claim** (ADR 014).
Sentiment is an attribute of the post and never of a person, so there is no sentiment field on
a profile and no mood, disposition or risk score anywhere. Co-presence, two named people in one
post resolving to two profiles, is a dated, sourced, confidence-scored inference that they were
together, never proof, and it feeds the associate graph and the phase 12 candidate set. An
image is read for what and where, always derived and city-level at best, with who governed by
ADR 013. Why is not asserted at all: a stated reason is carried as an attributed quote and
anything else stays empty. A model output is not an independent source, so two models agreeing
is still one origin.

## Entity resolution and multimodal evidence

Read ADR 015. It does not decide **whether** to read a face, a landmark or a sentiment:
ADR 013 and ADR 014 decided that. It decides **how any of it runs**. Everything runs locally
on one laptop with an internet connection: no cloud inference, no paid model API. That is a
licensing position as much as a deployment one, because posting scraped or licensed media to
a third party to be described is redistribution, and shipping a reference portrait out to be
embedded hands a biometric identifier to someone with no basis to hold it.

**One evidence contract, one resolver, whatever the modality.** A claim carries its value,
its date, its source, its **origin key** and the modality it arrived in. Modality-specific
code lives in `sources/` adapters. Nothing under `services/` branches on modality.

- **Video is not a fourth modality.** It is frames plus an audio track, handled by the image
  path and the audio path, sharing one origin key.
- **The origin key is the whole game.** A video, a still pulled from it and its own
  transcript are **one** source, not three. Three re-uploads of one photograph are one
  source, and near-duplicate detection is what proves it. This is ADR 011's wire-story rule
  applied across modalities and it is the easiest thing here to get wrong.
- **Modality is not a trust level, origin is.** A company's own webcast is a primary record
  and may cross the assertion threshold alone. A caption on a crowd-uploaded photo never
  does.
- **Timestamps come from the media, not the run.** A transcript segment is dated to the
  call. A photo is dated to its EXIF capture time where present, otherwise its publication
  date, and which one was used is recorded. Undatable media is dropped and counted.
- **The resolver is deterministic and classical**: blocking, per-field comparators, additive
  log-odds scoring, two thresholds (assert above, possible match between, nothing below). A
  score decomposes into the fields that produced it. **No model scores a match.** Embeddings
  propose candidates and nothing else.
- **Local models are four small ONNX on CPU**: a sentence embedder, a CLIP-family image and
  text embedder, a face embedder of the ArcFace class (used only as ADR 013 permits), and
  Whisper-small. Weights pinned by hash, not committed, fetched on first use, and the model
  version stored on every embedding, because a silent mixed-version index looks like poor
  recall rather than a bug, and because a removal under ADR 008 has to delete every version
  of a reference face embedding. With the weights absent the product runs text-only and
  reports the media layers unavailable, like any missing key. The test suite must pass
  without them.
- **A model output is not a source** (ADR 014), and the origin key is what enforces it. A
  face match, a landmark reading, a registration read off the tail and a caption all taken
  from the same photograph are **one** origin between them. Running a second model over the
  same picture does not create a second source.
- **Image content reading is closed-set, not open-vocabulary description.** The image
  embedding is scored against a candidate label set built from records the system already
  holds: the phase 4 gazetteer, the phase 5 registries, the phase 6 organisations and assets.
  The model ranks things we can already name and cite, so there is nothing to hallucinate.
- **Vectors are blobs in the existing SQLite file, scanned with numpy.** No vector database
  and no vector server until a brute-force scan is measurably too slow.
- **Audio is demand-driven and cached by content hash, never a poller.** Hours of earnings
  calls on a laptop CPU is not a sweep.
- **Face matching is a candidate generator, not a decision.** ADR 013 decided that faces are
  matched; ADR 015 only says the embedder runs locally and its output is scored, thresholded
  and corroborated like any other claim. Running it on this machine is what keeps ADR 013
  inside its own limits: reference portraits never leave the laptop, a face matching no
  profile is discarded rather than stored, and a removal deletes the embedding with the
  record.
- **Media never asserts a person's location on its own.** A geotag says where the camera
  was. Joining that to a person needs corroboration like any other join.

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
