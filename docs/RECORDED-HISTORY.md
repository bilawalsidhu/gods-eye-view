# Recorded history

A record contract, a conformance suite and one store for position history that
outlives the in-memory windows (#1075). Nothing records yet: a recorder, a
read route and a replay UI are separate work that builds on these.

| File                                         | What it is                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/data/historyRecords.js`                 | The record and coverage contract, validation, store order, playback fixes and MF-JSON export |
| `src/data/fixtures/history-conformance.json` | Language-neutral conformance cases: every store, in any language, should pass them           |
| `src/testSupport/historyConformance.mjs`     | Runs those cases against any store from `node:test`                                          |
| `src/testSupport/historyMemoryStore.mjs`     | The reference store: the contract in plain arrays, the oracle for differential tests         |
| `server/providers/history/dayStore.js`       | A `node:sqlite` store with one database file per UTC day                                     |

## Records

```text
{source, key, t, lat, lon, heightM, bearingDeg, receivedAt, timeKind, provenance, flags}
```

- `source` and `key` are non-empty, well-formed strings (no lone surrogates,
  which have no UTF-8 form) of at most 256 UTF-8 bytes; one `(source, key, t)`
  is one record.
- `t` is whole epoch milliseconds on the clock `timeKind` names: `vehicle` (the
  contact's own report time), `feed` or `receipt`. Playback receives it as the
  matching `FIX_FLAGS` time flag.
- `provenance` is `observed`, `derived` (gap filling, dead reckoning) or
  `simulated` (exercises, scenarios). A query returns `observed` records unless
  it names others, and playback refuses to mix provenances in one track.
- `heightM`, `bearingDeg` and `receivedAt` are NaN when absent. `flags` keeps
  BREAK and FLOOR only. Negative zero is stored as zero.
- A record identical to a stored one is a **repeat**; a different one for a
  stored `(source, key, t)` is a **conflict**, and the stored record stays.

A record that breaks a rule is refused by index with the first field that is
wrong, in this order, and the rest of the batch is written:

| Field                    | Rule                                                             | Reason       |
| ------------------------ | ---------------------------------------------------------------- | ------------ |
| `source`, `key`          | Well-formed string, 1 to 256 UTF-8 bytes, no NUL                 | field name   |
| `t`                      | Integer ms, 0 to 9999-12-31T23:59:59.999Z                        | `t`          |
| `t`                      | Not more than `futureToleranceMs` (10 s) after the store's clock | `future`     |
| `lat`, `lon`             | Number, \|lat\| ≤ 90, \|lon\| ≤ 180                              | field name   |
| `timeKind`, `provenance` | One of the names above                                           | field name   |
| `heightM`                | Finite, or absent                                                | `heightM`    |
| `bearingDeg`             | 0 ≤ value < 360, or absent                                       | `bearingDeg` |
| `receivedAt`             | A valid time as `t`, or absent                                   | `receivedAt` |
| `flags`                  | Non-negative integer; only BREAK (16) and FLOOR (8) are kept     | `flags`      |

Absent is `null`, `undefined` or NaN. A coverage interval is refused with
`source`, `time` (a bound that is not a valid time), `order` (from after to),
`span` (more than a day) or `future`.

## Coverage

Coverage intervals say when the recorder was running for a source, at most a
day each. A recorder writes `[previous poll, this poll]` with every successful
poll, so continuous recording is continuous coverage, and an outage costs no
storage. Where there is no coverage there is no information:
`historyPlaybackFixes` puts a BREAK on the first fix after any span that
coverage does not hold whole, so `contactPlayback` holds the last position
through an outage (`motion: 'unknown'`) instead of drawing a line across it.

Coverage is on the recorder's clock, so the span checked between two fixes is
between their `receivedAt` times (`t` when a record has none). A fix reported
at 12:00:00 and received 30 s later was recorded at 12:00:30; judging coverage
on report times would hide an outage that falls inside the latency, and would
break a track that starts recording after its first report time.

For replay, create the track with `createTrack({policy: HISTORY_REPLAY_POLICY})`: the live
policy calls every recorded motion stale, because it measures age against the
wall clock. `mergeHistory` keeps the newest 128 fixes of a track, so a longer
track is replayed through windows of the store (a query per window around the
playback time), not merged whole.

## Queries

`query({source, fromMs, toMs, keys?, provenance?, limit?, cursor?})` returns
`{records, nextCursor, unreadableDays}`.

- Both bounds are inclusive. Order is `t`, then `key` by **UTF-8 bytes**
  (`compareUtf8`); JavaScript's `<` compares UTF-16 units and orders astral
  characters differently.
- Paging is keyset paging: the cursor holds the last `(t, key)` and the query it
  belongs to. Every record appears on exactly one page whatever the page size;
  a cursor passed with a different source, range, provenance or key list is
  refused with `cursor_mismatch`. The page size may change between pages.
- Refusals carry a stable `code`: `invalid_source`, `invalid_range`,
  `invalid_limit` (1 to 10,000), `invalid_provenance`, `invalid_keys` (1 to
  1,000), `invalid_cursor`, `cursor_mismatch`, `read_only`, `closed`.

`coverage({source, fromMs, toMs})` returns the merged intervals clipped to the
range. `prune()` applies retention and returns `{droppedDays}`.

## The day store

`openHistoryDayStore({dir, retentionDays = 7, maxBytes = Infinity, readOnly = false, futureToleranceMs = 10_000, maxOpenDays = 4, now})`:

- One SQLite file per UTC day, `YYYY-MM-DD.sqlite`, named by UTC whatever the
  local zone. Retention and the byte cap delete whole files, oldest first, and
  never today's or a later day's (records are refused more than
  `futureToleranceMs` ahead, so a later day exists only near midnight or after
  the clock steps back). Deleting a day's rows from one large database instead took
  9.5 s per million rows and left the file its old size.
- WAL mode: one writer per directory and any number of `readOnly` openers,
  including from another process. The writer holds an exclusive lock on
  `writer.lock` in the directory; a second writer, in this process or another,
  is refused with `locked`, and the lock goes when the process ends, however
  it ends. `synchronous = NORMAL`: an application crash loses nothing
  committed; a power loss may lose the last transactions.
- Writes are atomic per day file. A storage error (disk full, a file that
  cannot be opened) is thrown: the days written before it stay, the failed
  day's batch is rolled back whole, and later days are not written. Since a
  stored record sent again is a repeat, the whole batch can be resent.
- A day file that is not a database of this schema, version and day (corrupt,
  another SQLite database, a later `schema_version`, or a day file renamed to
  another day) is reported in `unreadableDays`, skipped by reads and never
  written; records and coverage for that day are refused with
  `unreadable_day`. The writer runs `PRAGMA quick_check` on a file it did not
  create before adding to it; a reader finds damage past the header as it
  reads, and from then on that store treats the day as unreadable. A busy file
  is waited for (5 s) and is not reported as damaged. A file cut off while
  being created (no tables yet) is created again. Only regular files with a
  valid day name are ever deleted.
- About 110 bytes per record with both indexes, measured on 100,000 records.

## Conformance

A new store passes when the shared cases pass:

```js
import test from 'node:test';
import { runHistoryConformance } from '../src/testSupport/historyConformance.mjs';

runHistoryConformance({
  test,
  label: 'my store',
  open: (options, t) => openMyStore(options), // {now, retentionDays?}
});
```

A store in another language reads `history-conformance.json` directly; its
`$comment` explains the notation. The day store's tests add a differential
test (random writes, queries with random page sizes, and pruning, compared with
the reference store over 40 seeds) and replay a recorded ADS-B capture through
`contactPlayback` across a simulated recorder outage. A writer is killed while
writing to show that committed batches survive whole, and
`src/data/fixtures/history-day-v1.sql` is a day file as version 1 wrote it,
which later versions must still read.

## Export

`historyMovingFeatures(records, {coverage})` writes one contact as an OGC
Moving Features JSON 1.0 FeatureCollection: one linear MovingPoint per
continuous segment, split where playback would break.
A segment of one fix is a one-instant `Discrete` MovingPoint, as the
standard's text allows (OGC 19-045r3, 7.2.1); the published JSON schema asks
for two coordinates per MovingPoint and one feature per collection, so a
validator built on it refuses that segment and an empty export.
