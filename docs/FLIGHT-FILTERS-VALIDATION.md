# Live flight filters

Local implementation and REAL browser validation, 2026-10-11. The existing
contact lookup and tracker could already find an aircraft, but Live Flights had
no airline or flight filter in its Data Layers row.

Enable **Live Flights**, expand **Filter airline / flight**, enter a company
code and/or flight identifier, then use **Apply filter**. A blank field leaves
that dimension unrestricted. **Loaded flights** lists up to 200 matching
contacts; narrow the filter when more are present. **Select & follow** selects
one stable transponder identity and uses the existing camera tracker. **Show
all** clears the display filter. Escape releases camera tracking. Controls and
help text follow the upstream English interface.

The company field accepts a two-character IATA code (including alphanumeric
codes) or a three-letter ICAO code. An explicit lookup uses the existing
same-origin adsbdb enrichment proxy. Its airline endpoint resolves IATA to one
or more ICAO prefixes and supplies names. When operator metadata is unavailable,
a three-letter ICAO prefix can still be used directly and is labeled as such;
an unresolved IATA code reports the missing mapping and keeps the previous
filter. Airline membership uses the observed callsign prefix, not country,
registration, aircraft owner, or a guessed operator.

The flight field accepts an exact observed callsign, a full ICAO-style callsign,
or an IATA flight number with a provider-published ICAO alias. Matching is exact,
case-insensitive and ignores input whitespace. Commercial flight numbers are
not spliced onto operator prefixes: alphanumeric ATC callsigns can differ from
the marketed flight number. Unknown IATA aliases report an explicit error;
an absent live callsign produces zero results. This is live coverage, not a
schedule, and absence does not prove a flight has been cancelled.

The filter is session-local. It does not change feed queries, worldwide versus
regional fallback policy, the 30-second flight polling interval, retention,
source freshness or motion timing. The underlying records remain loaded.
Filtered contacts do not render as billboards, fleet models, detection labels
or nearby/analyst results. The row shows matching / loaded counts. Applying a
filter releases a tracked contact outside its cohort; a later source callsign
change can also release an excluded subject. The source health remains visible.

Matching is cached by metadata identity/callsign and invalidated on filter
changes. The option list is refreshed on feed updates and filter actions rather
than rebuilt each frame. Focused inputs and unsubmitted drafts survive panel
refreshes. Lookups are explicit, cancellable and superseded responses cannot
replace newer selections. No global operator catalog is fetched at startup.

## Evidence

- REAL UI: `BA` and `BAW` both resolved British Airways and selected 45 of 5,481
  loaded aircraft at the time of the check. Traffic totals naturally change.
- REAL UI: selecting `BAW639` produced one matching aircraft, moved the follow
  camera to it and displayed `BAW639 · FL340 · 459 kts`, British Airways and the
  supplied ATH–LHR route. Screenshot:
  `output/playwright/flight-filter-selected.png` (local ignored artifact).
- REAL UI: entering `BA639` resolved `BA639 → BAW639` and retained that matching
  contact. The live provider was explicitly labeled regional fallback during
  this check; the retained global set is not a claim of current worldwide fixes.
- Tests cover IATA/ICAO matching, different commercial/ATC numbers, unknown data,
  missing callsigns, in-place metadata updates, cancellation/supersession,
  stable identity selection, capped lists, and form focus/draft preservation.
- Full ordinary suite: 6,281 passed, zero failed, one existing skip. Both
  serialized allocation gates passed (14 tests). After the final missing-call
  and source-change guards, 97 focused regression tests passed. Build,
  formatting, and import/package boundary validation passed.

API contract: [adsbdb airline and callsign documentation](https://github.com/mrjackwills/adsbdb#readme).
Availability and correctness of community operator/route mappings remain
provider-dependent. No guarantee of complete airline or worldwide live coverage
is made. Validation was performed locally; no production deployment or upstream merge is claimed.
