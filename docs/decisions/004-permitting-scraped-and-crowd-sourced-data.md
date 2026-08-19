# ADR 004: scraped and crowd-sourced data is permitted

**Date:** 2026-08-19
**Status:** Accepted
**Amends:** ADR 002 (people layer scoping), specifically its camera clause and its
"official and owner-consented sources only" rule.

## Context

ADR 002 and section 8 of the design spec restricted the project to official and
owner-consented feeds, and the people layer to Wikidata entities reached through an
allowlist of seven static association properties. Under that rule a scraped page, a
community-run aggregator or a user-submitted record could not be ingested at all, whatever
its quality.

That rule was written for a demo. It also rules out most of the coverage the project
actually needs. Community feeds are the aircraft layer already: adsb.lol and adsb.fi are
volunteer receiver networks, so the line between "official" and "crowd-sourced" was never
clean. OpenStreetMap, Wikidata and Wikipedia are the same shape. Excluding scraped sources
mainly excluded public information that is free to read and awkward to fetch.

The call has been taken to permit both, including on the people layer.

## Decision

Scraped and crowd-sourced sources are permitted anywhere in the project, including the
people layer. Person records may come from crowd-sourced or scraped sources and are no
longer limited to the Wikidata property allowlist.

Every source, however it was obtained, still carries the same obligations:

1. **Recorded in `docs/data-sources.md`** with endpoint, method of collection, licence or
   terms position, cadence and verification date. Scraped sources say so explicitly and
   name the page they came from.
2. **Two-layer contract discipline unchanged.** Scraped and user-submitted input is
   permissive at the wire layer, strict at the domain layer. A record that will not map is
   dropped and counted. Scraped input is the least trustworthy input in the system and gets
   validated hardest.
3. **Provenance on the card.** Every entity shows where its data came from and how old it
   is, and a scraped or crowd-sourced origin is shown as such rather than dressed up as
   authoritative.
4. **Robots and rate limits are honoured.** `robots.txt`, published crawl delays and any
   stated request cap are respected in code. A descriptive User-Agent with contact details
   on every scrape. Cache server-side, never scrape from the browser.
5. **An explicit prohibition still binds.** A source whose terms prohibit scraping or
   redistribution is not scraped. ADSBexchange's globe map remains the worked example: its
   tile endpoints return 403 and scraping it is prohibited by name.

## What this does not change

Three lines survive untouched, because they are about harm rather than about sourcing:

- **No aggregators of unsecured private cameras.** That is access to other people's
  compromised devices, not scraping a public page.  Still binding.
- ~~**No face recognition or person identification on any camera image, ever.**~~ **Reversed
  in part by ADR 013.** Faces in photographs are matched 1:N against held profiles, in phase
  14. The camera half of this line survives: face matching is not applied to camera feeds.
  A written legal position from counsel remains a blocker on public deployment.
- ~~**No present tense on people.** No "last seen", no movement lines, no code path joining
  a person record to a live position feed.~~ **Overruled by ADR 007.** A person may now be
  joined to any data in the system, live position feeds included, and the structural test
  asserting that separation is deleted. Provenance, confidence thresholds and the removal
  control are what remain. Read ADR 007 before relying on anything in this section.

## Consequences

**The privacy position is reopened.** ADR 002's safety argument rested on the allowlist doing
the work in the query rather than in policy. Person data from scraped and crowd-sourced
sources cannot lean on that, so the written privacy position becomes load-bearing rather than
a tidy-up. It is still a phase 6 deliverable and is now a blocker for any public deployment
carrying person data.

~~Specifically: the legitimate-interests assessment under UK GDPR Article 6(1)(f), the data
protection impact assessment and the privacy notice.~~ **Corrected by ADR 006 and settled by
ADR 008.** UK GDPR is the wrong instrument: the profiles and the customers are in the United
States, so the frame is the US state patchwork, CCPA and CPRA first, with the California
Delete Act reaching data brokers directly. What is owed is a written US position naming which
state laws reach the population, how access and deletion requests are served inside the
statutory windows, and whether data broker registration applies.

**Erasure needs its own mechanism.** Scheduled re-sync from Wikidata propagated upstream
deletion for free. A scraped or user-submitted record has no upstream to delete from, so
the report control has to be able to remove and suppress a record directly. ADR 006 made that
a feature and ADR 008 specified it: removal deletes, suppression survives re-ingest, and the
suppression is visible in the product with its reason.

**Accuracy risk moves to us.** A crowd-sourced or scraped record that is wrong is wrong in
our name. Provenance display and the report control are the mitigation, not a claim of
correctness.

**Commercial licensing gets harder to reason about, not easier.** Scraped data usually has
no licence at all, which is not the same as being free to redistribute. The licence audit in
`docs/data-sources.md` covers scraped sources too and has to say what the position is.

## Alternatives considered

**Permit scraping everywhere except the people layer.** Rejected on instruction. It was the
narrower change and would have kept ADR 002's privacy argument intact.

**Keep the allowlist and add scraped sources behind a feature flag.** Rejected. A flag that
switches the privacy posture of the product is worse than a written decision, because nobody
can tell from the code which posture is live.
