# Status

Last updated: 2026-08-19. This is the only document expected to churn.

Nothing goes in **Works** without evidence. Everything below was checked by running the
command quoted, not by reading the code.

## Now

Phase 1, the vertical slice, part-built. The backend half is up and serving real live
aircraft, and that is the part with evidence behind it. The three remaining phase 1
deliverables are the test suite, the frontend and CI. All three are in flight and none has
been observed passing.

Read `docs/plan/implementation-plan.md` for the phase 1 acceptance criteria. The
backend-only ones are met. Every criterion needing a browser or a completed test run is not.

## Works

Proven on 2026-08-19 by running the app against the live adsb.lol feed.

**The backend serves real live aircraft through strict contracts.** Two earlier live runs
recorded 462 aircraft and 336 military aircraft in the stores. Re-verified while writing
this document: 446 aircraft and 320 military. Both figures come from
`GET /api/layers`, and both feeds reported `healthy: true`:

```
{"layers":{"aircraft":446,"military":320},
 "feeds":[{"source":"adsb.lol/point","healthy":true,"entity_count":446,...},
          {"source":"adsb.lol/mil","healthy":true,"entity_count":320,...}]}
```

Every one of those records passed the `Aircraft` contract at
`src/tracker/contracts/aircraft.py:55`: `strict=True`, `extra="forbid"`, `frozen=True`. A
record that will not map is dropped and counted, never partially accepted.

**Every REST endpoint returns 200.** Checked with curl against a running
`uv run tracker`:

| Endpoint | Result |
| --- | --- |
| `GET /api/health` | 200 |
| `GET /api/capabilities` | 200 |
| `GET /api/layers` | 200 |
| `GET /api/aircraft` | 200 |
| `GET /api/aircraft/{icao24}` | 200, with a real aircraft (`4cad0f`, callsign `RYR9NT`, registration `EI-HGW`, type `B38M`, altitude 11,102m) |

**A partial bounding box is rejected, not guessed at.** `GET /api/aircraft?west=-1`
returns 422. Silently defaulting a missing edge to the world would return every aircraft
to a client that believed it was filtering (`src/tracker/api/routes_entities.py:39`).

**The adsb.fi failover fires on a real HTTP 420 and keeps the military layer up.** Seen on
the first live run of the app against `/v2/mil`, and seen again during this
verification run against `/v2/point`, straight out of the server log:

```
GET https://api.adsb.lol/v2/point/51.5000/-0.1200/250 "HTTP/1.1 420 "
WARNING tracker.sources.adsb: adsb.lol failed for /v2/point/... (rate limited (HTTP 420);
backing off 120s before retrying); trying adsb.fi
```

420 is not a standard status code. It is handled explicitly at
`src/tracker/sources/base.py:21` and gets the provider's own backoff rather than the
generic retry curve.

**`ruff` is clean on the backend source.** With `src/`, `scripts/` and the docs in place
and no test files present, `uv run ruff check .` reported `All checks passed!` and
`uv run ruff format --check .` reported `26 files already formatted`.

**`openapi.json` is generated and drift-checked.**
`uv run python scripts/dump_openapi.py --check` reports `openapi.json is up to date`. The
committed schema has five paths, which matches the five endpoints above.

## Broken or not yet built

**`mypy --strict` does not pass.** `uv run mypy src scripts` reports one error in shipped
code:

```
src/tracker/sources/adsb.py:181: error: Unused "type: ignore" comment  [unused-ignore]
```

Confirmed with a cleared `.mypy_cache`, so it is not a stale-cache artefact.
`warn_unused_ignores = true` is set in `pyproject.toml:90`, so the suppression on the
`alt_baro` narrowing at `src/tracker/sources/adsb.py:181` is no longer needed and has to
go. One line, and it is the smallest blocker on this list.

**The viewport failover to adsb.fi does not work.** The military path `/v2/mil` is
identical on both providers, which is why the military failover works. The viewport path
is not: adsb.fi uses `/v2/lat/{lat}/lon/{lon}/dist/{nm}` and answers HTTP 400 for
adsb.lol's `/v2/point/{lat}/{lon}/{nm}`. Confirmed on 2026-08-19, both paths called
directly. Seen live in the server log during the run above: the adsb.lol 420 fell over to
adsb.fi, which returned 400, so that poll produced nothing. The failover in
`src/tracker/sources/adsb.py:331` retries the same path against the secondary base URL and
needs a per-provider path mapping instead.

**The test suite, the frontend and CI are all in flight and none is proven.** All three
started landing in the same session this document was written, so treat their state as
current-at-a-glance rather than verified:

- **Tests.** `tests/fixtures/` holds six recorded real payloads. Contract tests have begun
  arriving under `tests/contracts/`; `tests/sources/`, `tests/services/` and `tests/api/`
  are still bare. `uv run pytest` has never been observed passing, and the 85% branch
  coverage gate in `pyproject.toml:113` has never run to completion. `ruff` and
  `mypy --strict` both report errors in the newly arrived test files, which is expected of
  work in progress and is not evidence about `src/`.
- **Frontend.** The workspace now exists (`package.json`, `vite.config.ts`,
  `tsconfig.json`, `eslint.config.js`), but no globe has been rendered and verified.
  Nothing about the render policy in `docs/architecture.md` is proven, including the
  frame-rate targets, the `PointPrimitiveCollection` approach and the dead-reckoning
  behaviour.
- **CI.** `.github/workflows/ci.yml` exists and has never been observed green. Every check
  in the Works section above was run by hand on one machine, so "green on a clean clone"
  is unproven.

Anyone updating this file next: run the commands, paste the output, and replace these
three bullets with what actually happened.

**No `/ws` client has been seen connecting.** The hub, the broadcast loop and the message
contracts exist and `/ws` is mounted (`src/tracker/api/routes_ws.py:31`), but no browser or
test has been observed driving it, so the fan-out path is unproven end to end. That covers
snapshot-on-connect, per-interval batching and slow-client dropping.

**Only the aircraft layers exist.** One of the seven entity classes out of seven. Vessels
and satellites (phase 2), cities (phase 4), organisations and people (phase 6) and social
posts (phase 8) have no code behind them, and nor do events, cameras, POIs or buildings.
`/api/capabilities` already reports them as unavailable with the reason, which is the
honest degradation path working.

**Five more sources were called and verified on 2026-08-19, and none of them has code behind
it.** Satellite imagery as a queryable source rather than a basemap: Element 84 earth-search
STAC returned two real Sentinel-2 scenes over London (both at essentially 100% cloud, which is
the gotcha the adapter has to handle), the Copernicus Data Space catalogue returned a real
product record keyless, and the NASA Worldview snapshot API returned an `image/jpeg`. Cameras:
TfL JamCams returned 889 London cameras with **no key at all**, correcting this repo's earlier
claim that an app key was needed, and one still was pulled live from S3. New York 511 returned
2,931 cameras keyless, of which 1,561 are enabled with an HLS stream and 1,066 are `Disabled`.
Windy answered 403 without a key, so its gate is confirmed and its payload shape is not. All
of it is in the verified table with its shape and its traps; none of it is built.

**Post content analysis and face matching are decided and unbuilt.** ADR 014 settles what a
post is read for: sentiment on the post and never on a profile, co-presence as a scored
inference, image content as derived, and motive not asserted at all. ADR 013 settles face
matching, 1:N against held profiles only, and records that the decision was Alexander
Fanthome's taken with the legal exposure in front of him. They are phases 8 and 14. Nothing is
written, no model weights are downloaded, and the written legal position from counsel that
gates public deployment does not exist.

**The ADS-B Exchange access position was checked and recorded.** On 2026-08-19 the RapidAPI
host `adsbexchange-com1.p.rapidapi.com/v2/mil/` answered HTTP 401 with a RapidAPI key error,
confirming the host, the path shape and the gate; nobody has a key, so no data has been seen.
The globe map's own endpoints are closed: `/data/aircraft.json` and `/re-api/` both answered
HTTP 403 "Request forbidden by administrative rules", and `robots.txt` disallows `/api/`,
`/mapproxy/`, `/re-api/` and `/globe_history/` by name. airplanes.live answered 403 asking for
a project description by email, which nobody has sent. adsb.one was Cloudflare-blocked from
this network. The provider union in ADR 010 is therefore designed and unbuilt, and the
aircraft layer still runs on adsb.lol alone.

**AISHub is documented and gated behind hardware.** Checked on 2026-08-19: the webservice
host `data.aishub.net/ws.php` answers and its full parameter contract is published, but a call
with an invalid username returns **HTTP 200 with an empty body**, so no payload has been seen
and the source stays NOT YET VERIFIED. Access requires running a physical AIS receiver meeting
their published quality bar, and their terms prohibit feeding them data from other public AIS
services, so the blocker is an antenna rather than code.

**Six new sources were called and recorded but nothing consumes them yet.** On 2026-08-19
the GeoNames city file, Wikidata WDQS, Wikimedia Commons geosearch, the OpenStreetMap
notes API and a Mastodon public timeline all answered successfully and are now in the
verified table in `docs/data-sources.md`. Two negatives worth the same weight:
`mastodon.social` no longer serves its public timeline anonymously (HTTP 422) while
`mas.to` does, and Bluesky's `searchPosts` answered HTTP 403 from this network. No adapter
exists for any of them.

**Single worker only.** Pollers start in the lifespan, so a second uvicorn worker would
duplicate every upstream request. `__main__.py:27` pins `workers=1`. Horizontal scaling
needs a cross-process lock first.

**The commercial join does not exist yet.** No profile, no wealth tier, no ownership link,
no contact or identity attributes. What runs is raw aircraft positions. The profile-to-asset
join that carries the commercial story (`docs/business-context.md`) starts at phase 5, so
nothing here demonstrates the product yet. The join scope widened on 2026-08-19: ADR 007
permits a person to be joined to any data in the system including live feeds, and ADR 008
puts the production profile attributes in, contact data included. Neither is built.

**Cross-source corroboration and occupancy estimation are decided and unbuilt.** ADR 011
makes enrichment a corroboration problem: an attribute carries the set of sources supporting
it, independence is counted at the origin, and one scraped source never crosses the assertion
threshold alone. ADR 012 adds an occupancy estimate for an aircraft or vessel as a labelled
inference over ownership, recorded route history, the live track, the associate graph and
each candidate's dated locations elsewhere. The corroboration service is a phase 6
deliverable and occupancy is the new phase 12. There is no profile record yet, so neither has
anything to run against. One thing did get verified for it: GDELT's DOC 2.0 article API
answered 200 with real articles on 2026-08-19 and is in the verified table, along with the
one-request-per-five-seconds cap it states in its own 429.

**Local multimodal evidence and the resolver are decided and unbuilt.** ADR 015, taken on
2026-08-19, settles how images, audio and video become claims: one evidence contract and one
deterministic resolver, modality-specific code confined to `sources/`, and an origin key so
that a video, a frame from it and its own transcript count once rather than three times. The
resolver is blocking plus per-field comparators plus additive log-odds scoring with two
thresholds, and no model scores a match. Local inference is four small ONNX models on CPU (a
sentence embedder, a CLIP-family image and text embedder, a face embedder for ADR 013, and
Whisper-small) used only for candidate generation, near-duplicate detection and
transcription. Nothing is written. The
evidence contract, the resolver and the model boundary are phase 6 deliverables; the image,
audio and video adapters are the new phase 13, and face matching on top of them is phase 14
(ADR 013). No model weights have been downloaded and no
transcription has been run on this machine, so none of the CPU cost claims in ADR 015 has a
measured number behind it yet.

**The removal and suppression control does not exist yet.** ADR 008 makes the right to be
forgotten a product feature, deleting the record and keeping a suppression key that survives
re-ingest. There is no person record to remove yet, so there is nothing to build against
until phase 6.

**Not licensed for commercial deployment.** adsb.fi is non-commercial and is the aircraft
failover. Full audit in `docs/data-sources.md`.

## Next

In order.

1. **Delete the unused `type: ignore` at `src/tracker/sources/adsb.py:181`** so
   `mypy --strict` passes on `src`. Smallest fix on this list and it unblocks the gate.
2. **Finish the phase 1 test suite** against the six recorded payloads in
   `tests/fixtures/`: the parser (including the 420 failover and the eight mil-only
   fields), the store's time to live and change draining, the hub's snapshot-then-delta
   behaviour, the poller's cadence floor, and the API's 422 on a partial box. Then get
   `uv run pytest`, `ruff` and `mypy --strict` green together in one run and record it here.
3. **Fix the viewport failover** with a per-provider path mapping, and cover it with a
   test that kills the primary. Until then the aircraft layer has no failover, only the
   military layer does.
4. **Finish the frontend vertical slice:** Cesium viewer on
   NASA GIBS imagery, aircraft in a `PointPrimitiveCollection` mutated in place, the
   WebSocket client batching per animation frame, click-to-select opening the docked card,
   and the ODbL attribution visible on screen.
5. **Get CI green** on both halves plus the OpenAPI drift check, so the claims in this
   document stop depending on one laptop.
6. **Then phase 2:** aisstream ships and CelesTrak satellites, per
   `docs/plan/implementation-plan.md`. Then cities in phase 4, organisations and people in
   phase 6, social posts in phase 8. All seven entity classes are now planned, sourced and
   documented; five of them have nothing written yet.
7. **Then the commercial half:** phase 10 makes recency measurable (per-attribute ages, a
   staleness delta against the incumbent value, a change feed, an enrichment API), which is
   the thing the demo is actually arguing. Phase 11 correlates privacy ICAO addresses back to
   registrations, per ADR 009. Phase 12 estimates who is aboard, per ADR 012, and it is last
   because it needs ownership, profiles, the corroboration service, the associate graph and
   accumulated route history before it has anything to reason over. Phase 13 turns images, audio
   and video into claims per ADR 015, and phase 14 matches faces to held profiles per ADR 013.
   Unsecured-camera aggregators are the one thing not designed here, and the plan says why.
