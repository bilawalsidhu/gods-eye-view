# Ontology

The vocabulary the platform stores things in. The tables are in
[`db/migrations/`](../../db/migrations); this page says what the words mean and how the
existing layers map onto them. Types and links are rows in `object_type` and
`link_type`, so this page and the seed data are the contract.

## Objects

Every object has a stable `id`, a type, and a series of versioned states
(name, properties, geometry, validity, source, confidence). Readings that
arrive often are `observation` rows, not states.

| Type             | Meaning                                                          | Example                                                                                                      |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `place`          | A location you care about. `private`.                            | Home, a destination                                                                                          |
| `event`          | Something that happened or is in force                           | A fire detection, a flood warning, a quake, a Copernicus activation, a conflict report, a grid-stress period |
| `sensor`         | A fixed instrument                                               | A river gauge, an air-quality station, a webcam                                                              |
| `infrastructure` | A fixed facility or network node                                 | A rail station, a grid zone, a port, an airport                                                              |
| `asset`          | A mobile thing tracked by public feeds                           | An aircraft, a vessel, a bike-share fleet                                                                    |
| `organisation`   | An operator or publisher                                         | SNCF, RTE, Vigicrues                                                                                         |
| `area`           | A region                                                         | A warning zone, an administrative boundary                                                                   |
| `document`       | A file or report                                                 | A bulletin, an imported PDF                                                                                  |
| `person`         | An individual you are entitled to record (see [People](#people)) | A household member, a contact who agreed                                                                     |

## Links

Typed, directed (unless symmetric), with a validity range, a source, a
confidence and a reason (`pipeline`, `rule` or `analyst`).

| Link              | Reads as                           | Typical use                                           |
| ----------------- | ---------------------------------- | ----------------------------------------------------- |
| `located_in`      | A is located in area B             | Station in a commune; derived from geometry           |
| `near`            | A is near B                        | Within a stated distance (`props.distance_m`)         |
| `affects`         | event A affects B                  | A flood warning affects a place                       |
| `measured_by`     | A is measured by sensor B          | A river reach and its gauge                           |
| `operated_by`     | A is operated by organisation B    | A station and its operator                            |
| `reported_by`     | event A was reported by document B | Evidence for an event                                 |
| `derived_from`    | A is derived from B                | A computed alert zone                                 |
| `involved_in`     | person A was involved in event B   | Someone affected by an incident                       |
| `present_at`      | person A was present at B          | A visit to a place, with a validity range             |
| `associated_with` | A is associated with B             | An analyst's looser claim; the reason goes in `props` |
| `same_as`         | A is the same as B                 | An accepted merge                                     |

## Mapping the existing layers

| Layer                              | Object type                            | Notes                                                                                |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| NASA FIRMS                         | `event`                                | One per detection cluster; `props.frp`, `props.confidence`                           |
| Vigicrues sensors                  | `sensor` + observations                | Level and flow as observations; zones are `area` with an `event` per vigilance level |
| Copernicus EMS                     | `event`                                | Activation code is the external id                                                   |
| ENTSO-E                            | `infrastructure` (zone) + observations | Load, generation, price as observations per zone                                     |
| Earthquakes                        | `event`                                | Magnitude and depth in props                                                         |
| Cyclones                           | `event`                                | Track points as observations of the event                                            |
| Ghost Maps                         | `event`                                | Event kind from the symbol classifier; geometry from KML                             |
| Air quality                        | `sensor` + observations                |                                                                                      |
| SNCF stations                      | `infrastructure`                       | UIC code is the external id                                                          |
| Bike share stations                | `infrastructure` + observations        | Availability as observations                                                         |
| Flights, vessels, transit vehicles | `asset` + observations                 | Positions are observations; thin on write                                            |
| CCTV and webcams                   | `sensor`                               | Metadata only; no images stored                                                      |

## Identity

Each source's own key is stored in `external_id`, unique per source, which is
what makes ingestion idempotent. Across sources, objects are matched by the
resolver (phase 5): candidate pairs of the same type close in space and time,
scored on name similarity, distance and shared identifiers, with every signal
stored in `merge_candidate.signals`. Automatic merges are limited to
high-score pairs; the rest go to a review queue. A merge never deletes: the
losing object gets `merged_into`, and an undo clears it.

## Time

Two axes, kept separate:

- `valid_during`: when it was true in the world.
- `recorded_at` and `superseded_at`: when the system knew it.

A correction closes the old state (`superseded_at`) and inserts a new one, so
"what did we believe at 09:00" and "what was true at 09:00" are different,
answerable questions.

## Confidence

A number from 0 to 1 on every state and link. It starts from the source's
`trust` prior, is lowered for stale or partial data, and raised when
independent sources agree. It orders competing states in `object_current` and
feeds alert severity. It is a ranking aid, not a probability.

## Sensitivity

`public`, `personal`, `private`. Places, notes and investigations default to
`private`; documents to `personal`. Shared exports, share links and any
outside-facing route exclude `private` by default.

## People

The `person` type exists so past events can be reconstructed and reviewed
from the data collected, including who was involved. It is held to a stricter
standard than the other types, because records about individuals carry legal
obligations (GDPR applies to anything about people in the EU, whatever the
scale):

- **A stated basis is required.** `props.basis` must say why the record may be
  held: an operator agreement (with `agreement_ref`), consent, or your own
  household. The type's JSON Schema rejects a person without one.
- **Private by default.** `sensitivity` is `private`; person objects are
  excluded from share links, exports and any outside-facing route unless an
  export is explicitly asked to include them.
- **A retention date.** `object.retain_until` is set on every person; the
  retention job (phase 5) deletes their states, observations and links when it
  passes. Extending it is a recorded decision, not a default.
- **Audited.** Reads and writes of person objects go to `audit_log`.
- **Only from lawful sources.** Open data, your own files, and data covered by
  the agreement. No scraping behind logins, and nothing taken from other
  people's accounts.
- **Erasure works.** Because history is append-only, deleting a person is a
  distinct, logged operation that removes their rows and the links that name
  them; it is tested, since a right-to-erasure request must be answerable.

Keep the agreement itself (who agreed, scope, duration) as a `document`
linked to the person, so the basis can be checked later.

## Replay

Reconstructing what happened is a first-class use. `gev.objects_as_of(valid_at,
known_at)` returns the picture at a chosen time: what was true at `valid_at`,
as the system knew it at `known_at`. Rewinding `known_at` too is what lets you
review a past decision on the information that existed then, not what was
learned afterwards. Observations (positions, readings) replay by `observed_at`.

## Boundaries

- **No scraping behind logins, and no personal-account data from other
  people.** Sources are open data and your own files.
- **Respect licences.** Each source row records the licence and any storage or
  redistribution limit, and a connector is not enabled until that is filled in.

## Extending

To add a type: insert into `object_type` with a `props_schema`, then add a
connector or mapping that writes it. To add a link: insert into `link_type`.
Neither needs a migration. Add the type to the table above in the same change.
