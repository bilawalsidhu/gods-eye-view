# God's Eye View data platform: roadmap

Status: **phase 0 is built**; the rest is planned. The schema is in
[`db/migrations/`](../../db/migrations), the vocabulary in
[`ONTOLOGY.md`](ONTOLOGY.md), and running it in [`OPERATIONS.md`](OPERATIONS.md).

## Goal

Grow God's Eye View from a map of live feeds into a personal data platform: one
store of typed objects, the links between them, and their history, fed by open
data and your own files, with the globe, alerts and an analyst interface built
on top. It runs on the home server, for one owner, for protection and
awareness.

It is not a copy of any commercial product, and it does not try to be a
multi-tenant service. Where an enterprise feature would only matter at scale
(roles, accreditation, federated deployment) it is left as a seam, not built.

## Principles

1. **Provenance on every fact.** Source, run, retrieval time, licence,
   confidence. An alert you cannot trace is an alert you cannot trust.
2. **Append-only history.** Nothing is overwritten. A correction is a new
   state that supersedes the old one, so you can ask what the system believed
   at any past time.
3. **Ontology as data.** New object and link types are rows, not migrations.
4. **Keep the raw payload.** Any parser mistake can be fixed and re-run.
5. **The globe stays fast.** The map reads a current-state view, not the
   history; heavy analysis never runs in the render path.
6. **Few feeds, trusted.** Add a source when it answers a question you have,
   not because it exists.
7. **Private by construction.** Places, notes, documents and people are
   `private` or `personal` and never leave through a share link or export.
8. **Replayable.** Because history is append-only and two-axis, any past
   picture can be rebuilt as it was known then (`objects_as_of`).

## Where it fits in the codebase

| Today                                          | Becomes                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/providers/*` proxies, one per feed     | Connectors: the same fetch, plus a normaliser that emits objects and observations                                                               |
| `getAnalystRecords()` on each layer (22 files) | The shape of the normaliser's output, so the existing mapping work is reused                                                                    |
| Layers fetch their own feed                    | Layers read `object_current` and `observation` through one query API (phase 2); the direct fetch stays as a fallback while the database is down |
| `changelog.d`, `docs/`                         | Unchanged; the platform gets its own `db/` and `server/platform/`                                                                               |

New code lives behind a boundary: `server/platform/` (connectors, resolver,
rules, API) and `db/migrations/`. The browser never talks to Postgres; it
calls a same-origin `/api/platform/*`, held to the same loopback and
allowed-hosts rules the key-setup routes already use.

## Phases

Each phase ships something usable and has an exit test. Sizes are rough, for
one person working part time.

### Phase 0: foundation (built)

- Add the `postgis` service to `compose.yaml` (profile `platform`, bound to
  loopback, named volume) and `GEV_DATABASE_URL` in `.env`.
- Migration runner: numbered `db/migrations/*.sql`, applied in order, recorded
  in a `schema_migration` table. Plain SQL, no ORM.
- Split `schema.sql` into the first migrations; seed the ontology.
- `pg` pool in `server/platform/db.js`, health route, and a test that applies
  all migrations to a throwaway database.
- Backups: nightly `pg_dump` plus WAL archiving to a second disk; a restore
  test on a schedule. Decide this now: it is the part that is hard to retrofit.

**Exit:** `docker compose up` brings the database up empty; migrations apply
and re-apply cleanly; a backup restores into a scratch database.

### Phase 1: first connectors (about 2 weeks)

- Connector framework: schedule, `ingest_run` bookkeeping, raw payload
  storage, normalise, upsert states and observations, `external_id` lookup.
- Port three sources end to end: **FIRMS** (events), **Vigicrues** (sensors and
  observations), **ENTSO-E** (infrastructure and observations). They cover
  all three write paths.
- Idempotency test: running a connector twice writes nothing the second time.
- A `/api/platform/objects` and `/api/platform/observations` read API.

**Exit:** the three sources fill the database on a schedule; re-runs are
no-ops; a corrected upstream value creates a superseding state, not an update.

### Phase 2: the globe reads the platform (about 2 weeks)

- A platform-backed source for the three ported layers; the globe draws from
  `object_current`.
- Object page: properties, links, timeline of states, sources and licences.
- Time slider for the ported layers, reading history instead of the live feed.
- Replay: pick a past moment (and what was known then) and the globe, the
  object pages and the alert list show that picture.
- Attribution shown from the `source` table, replacing the hand-kept credits
  for these layers.

**Exit:** the three layers look and behave as before, plus a working "as of"
time control, a replay of a past incident from stored data, and an object
page.

### Phase 3: places and watch zones (about 1 week)

- Create and edit your places (`private`), with radius or area.
- Spatial links computed on write: `located_in`, `near`, `affects`.
- "What is near my places" query and a panel for it.

**Exit:** adding a place shows every event, sensor and piece of infrastructure
within its radius, with how each was found.

### Phase 4: rules and alerts (about 2 weeks)

- Rules engine over the declarative `alert_rule.spec`, evaluated on each
  ingest run, with cooldown and dedupe.
- Channels: ntfy first (self-hostable), then Telegram or Signal. Credentials
  stay in `.env`; the table holds only a reference.
- Alert inbox: acknowledge, mute, resolve, and a view of why each fired.
- A daily brief generated from structured events, each line linked to its
  object.

**Exit:** a test flood warning inside a watch zone reaches your phone once,
shows its sources, and does not repeat inside the cooldown.

### Phase 5: more connectors and identity resolution (ongoing)

- Port the remaining feeds in order of how often you look at them: earthquakes,
  cyclones, Copernicus EMS, Ghost Maps, air quality, SNCF and bike share,
  vessels and aircraft (observations only; they are high volume).
- Resolver: candidate generation by distance, name similarity and type;
  scoring; a review queue; accepted merges set `merged_into` and write
  `same_as`. Every verdict is stored with its signals.
- Retention: detach observation partitions older than the policy.

**Exit:** two sources reporting the same fire become one object with two
states and a visible provenance trail; a wrong merge can be undone.

### Phase 6: your own data and investigations (about 3 weeks)

- Import: CSV, GeoJSON, KML (the existing import code is the start), and
  documents with text extraction.
- People: the `person` type with required basis, retention and erasure,
  agreement documents linked to each person, and an audit view of every read.
- Document mentions linked to objects; full-text search.
- Investigation boards: pinned objects, notes, a status, and the question you
  are trying to settle.
- Export of an investigation with its sources, minus anything `private`
  unless you ask for it.

**Exit:** you can open a case, pin objects, attach a document, and export a
sourced summary.

### Phase 7: analyst interface and hardening (about 3 weeks)

- Natural-language questions answered by generating a structured query that is
  shown, run read-only, and returned with object citations. The model never
  answers from memory when the data can answer.
- The existing MCP server (`server/mcp`) exposes the same read API to outside
  tools.
- Row-level security and named roles, only if someone else will use it.
- Encrypted backups, secret rotation, an audit view, a dependency and
  container update routine.

**Exit:** a question like "what changed near my places this week?" returns a
checked answer with citations.

## Risks

| Risk                                                  | Mitigation                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ontology is wrong and every connector bakes it in | Start with eight types; change types as data until phase 5; keep `props_schema` strict so drift shows up in tests                                                                            |
| Open data is patchy, late or duplicated               | Provenance, confidence and the resolver; show data age everywhere                                                                                                                            |
| Observation volume (vessels, aircraft) fills the disk | Monthly partitions, retention policy, thinning on write                                                                                                                                      |
| Alert fatigue                                         | Severity thresholds, cooldowns, a weekly review of which rules fired and were never opened                                                                                                   |
| Licence terms limit storage or redistribution         | `source.licence` and `terms_note` are required; check them before a connector is enabled                                                                                                     |
| Privacy and legal exposure                            | `person` records need a stated basis, are private, audited, retention-dated and erasable; keep the operator agreement on file as a document; GDPR applies to anything about people in the EU |
| One person, long project                              | Each phase has a usable exit; stop after any of them and the system still works                                                                                                              |
| Home-server loss                                      | Phase 0 backup with a tested restore, kept on a second disk and off-site                                                                                                                     |

## Decisions needed

1. **Time zone and retention:** how long to keep raw payloads and observations
   (suggested: raw 90 days, observations 2 years, states forever).
2. **Alert channel:** ntfy self-hosted, or Telegram/Signal first.
3. **Off-site backup target.**
4. **Whether `private` rows should be encrypted at rest** beyond disk
   encryption (adds complexity to search).
5. **Which three connectors first:** the suggestion above covers all write
   paths; swap in feeds you check more often if you prefer.
