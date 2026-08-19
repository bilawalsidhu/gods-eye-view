# Tracker: working conventions

A real-data situational-awareness globe. CesiumJS frontend, FastAPI backend.
One backend process owns every upstream feed; the browser only ever talks to us.

## Commands

```bash
uv sync                                  # install backend + dev tools
uv run tracker                           # serve backend on :8000
uv run pytest                            # tests, branch coverage, fail_under=85
uv run ruff check . && uv run ruff format --check .
uv run mypy                              # strict, gates CI
uv run python scripts/dump_openapi.py    # refresh openapi.json (committed)
cd frontend && pnpm dev | pnpm test | pnpm lint | pnpm typecheck | pnpm codegen
```

Verification before claiming anything is done:
`uv run ruff check . && uv run mypy && uv run pytest && (cd frontend && pnpm verify)`

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

## The people layer

Read `docs/superpowers/specs/2026-08-19-tracker-design.md` section 8 in full before
touching it. The short version: only Wikidata entities with a Wikipedia sitelink are
searchable, and only an allowlist of static public-association properties (P19, P20,
P159, P937, P69, P7153 via P625) can produce a map pin. Residence (P551) and raw
coordinates on living humans are excluded inside the SPARQL query itself.

No present tense, no "last seen", no movement, and no code path joining a person to any
live feed. That separation is asserted by a test. Do not widen the allowlist for a
feature request.

## Documentation rules

- Update the relevant doc in the same commit as the change.
- `docs/data-sources.md` is the single source of truth for feed facts. Never write an
  endpoint into it that you have not called successfully. Record the verification date.
- `docs/status.md` is the only file expected to churn: Now, Works, Broken, Next.
- ADRs under `docs/decisions/` are append-only.
- Reference code as `path:line`, do not paste snippets into docs.

Docs index: [architecture](docs/architecture.md) ·
[data sources](docs/data-sources.md) · [status](docs/status.md) ·
[plan](docs/plan/implementation-plan.md) · [decisions](docs/decisions/)
