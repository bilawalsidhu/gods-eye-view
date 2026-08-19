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

**The commercial join does not exist yet.** No profile, no wealth tier, no ownership link.
What runs is raw aircraft positions. The profile-to-asset join that carries the commercial
story (`docs/business-context.md`) starts at phase 5, so nothing here demonstrates the
product yet.

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
