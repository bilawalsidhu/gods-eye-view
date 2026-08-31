# ADR 011: enrichment is cross-source corroboration, not single-source assertion

**Date:** 2026-08-19
**Status:** Accepted
**Amends:** ADR 004 (scraped and crowd-sourced data is permitted), ADR 006 (location as a
profile attribute), ADR 007 (a person may be joined to any data), ADR 008 (production
profile attributes).
**Relates to:** ADR 005 (derived versus upstream location on a social post), ADR 009 (PIA
correlation thresholds).

## Context

ADR 004 opened the door to scraped and crowd-sourced input. ADR 006, 007 and 008 then
widened what a profile holds and what it may be joined to. Every one of those decisions
raised the volume of enrichment and none of them said how a claim earns the right to be
displayed.

The rule that was implied but never written is the one this project actually turns on:
**no single online source is trusted on its own.** A scraped leadership page, a Mastodon
post mentioning a city, a news article placing someone at an event, a crowd-sourced note.
Each is one weak signal. The business already works this way, it just uses a researcher to
do it, and this project has no researcher (see the no-human-verification rule in
`AGENTS.md`). So the corroboration has to be in the schema and in the scoring.

There is also a failure mode this prevents. Altrata's own production problem is chimera
profiles, attributes of several people wrongly merged. A pipeline that accepts the first
source it finds builds chimeras faster than one that requires two independent sources to
agree.

## Decision

**Every enriched attribute carries the set of sources supporting it, not one source.** A
value with one supporting source and a value with four are different objects in the
contract, and the card shows which it is looking at.

**Confidence is a function of independent corroboration.** The rules, all in code and each
asserted by a test:

- **Independence is judged at the origin, not at the endpoint.** Two aggregators carrying
  the same wire story are one source. A Wikidata statement whose reference is the
  Wikipedia article that cites the same press release is one source. The adapter records
  the origin it can see, and sources that cannot be shown to be independent are counted
  once.
- **A single scraped or crowd-sourced source never crosses the assertion threshold on its
  own.** It is displayed as unconfirmed with its score and is excluded from every
  aggregate. Primary records (a regulatory filing, a registry extract, a company's own
  filing of its officers) may cross it alone, because the source is the record rather than
  a report about the record.
- **Corroboration raises confidence, it never raises precision.** Three sources saying
  London is still a city. Nothing in the corroboration path may narrow a place, a date or
  a name beyond what the strongest single source actually said.
- **Contradiction is kept, not overwritten.** Two dated values that disagree both stay on
  the profile, both dated, both sourced, and the card shows the disagreement rather than
  picking a winner silently. Where one is a primary record and the other is a report, the
  card says so.
- **An attribute produced by combining sources is labelled derived**, per ADR 006, and the
  label travels to the card and through the API.

**Cross-referencing is a first-class service, not a step inside an adapter.** Corroboration
runs over domain contracts after the adapters have mapped them, so a new source
strengthens or weakens existing claims rather than writing its own parallel truth.

## Consequences

**Most public claims will sit below the bar, and that is the correct output.** A demo where
half the enriched attributes read "unconfirmed, one source" is an honest demo. Tuning the
threshold down to fill the card is the one thing this decision exists to prevent.

**Independence is the hard part and it will be imperfect.** Wire copies, syndication and
Wikipedia-to-Wikidata loops are common, and the adapter can only record the origin it can
see. Where independence is unknown it is treated as absent, which costs recall and
protects against the chimera.

**It costs latency and it costs sources.** A claim needs a second source before it is
asserted, so enrichment lags the first sighting. Phase 10 measures recency, so this shows
up as a real number rather than a feeling: an attribute has an age and a corroboration
count and the demo shows both.

**Contact attributes get no exemption.** A wrong contact attribute attaches a real stranger
to a named profile, so a single-source email or phone stays unconfirmed exactly like a
single-source location.

## Alternatives considered

**Trust the strongest source and overwrite the rest.** Simpler, and it is roughly what a
weekly production scan does. Rejected because it hides disagreement, which is the signal a
customer would most want, and because it makes a chimera indistinguishable from a good
profile.

**Score every source once, up front, with a per-source trust weight.** Rejected as the only
mechanism. A per-source weight is useful and is kept, but it says nothing about whether two
sources are the same story twice, which is the failure this decision targets.
