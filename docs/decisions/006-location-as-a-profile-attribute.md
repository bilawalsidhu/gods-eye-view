# ADR 006: location is a first-class profile attribute

**Date:** 2026-08-19
**Status:** Accepted, amended
**Amends:** ADR 002 and the scope boundary in `docs/plan/implementation-plan.md`. Corrects
the jurisdiction framing in ADR 004 and in section 8 of the design spec.
**Amended by:** ADR 007, which overrules the "a person never carries a live position"
paragraph below in full, and ADR 008, which widens the address rule below (a profile carries
postal addresses including home addresses, not only a public-record business address) and
adds contact and identity attributes alongside location.

## Context

The profile carried no location of its own. A person resolved to owned assets and to a
short allowlist of static association places, and ADR 004 lifted the allowlist but did not
add location as an attribute in its own right.

That does not match the product. Altrata's own person model carries location as a
demographic attribute next to name, date of birth, nationality and gender, and carries
address display names, work locations and education locations. See the APB requirements and
the unified data model pages in Confluence. A demo of profile enrichment that cannot hold a
profile's location is not demoing the product.

Two corrections to earlier documents in this repo, both of which were wrong:

**The jurisdiction framing was wrong.** ADR 004 and the spec made UK GDPR Article 6(1)(f),
a DPIA and an Article 14(5)(b) notice the gating condition. The customers and the profile
population are in the United States, so that is the wrong instrument. US state privacy law
is the relevant frame, and it is a different shape: California's CCPA and CPRA give
residents access and deletion rights, several other states have followed, and the
California Delete Act reaches data brokers directly. It is narrower than GDPR and it is not
nothing.

**Removal was described as a gap.** ADR 004 said a scraped record has no upstream deletion
to propagate, as though that left no mechanism. The business already operates a removal
request process. That is the mechanism, and it belongs in the design as a feature.

## Decision

**Person profiles carry location attributes.** Each one is dated and carries its source:

- Residence city, region or country, at whatever granularity the source supports.
- Address, where the source is a public record and the address is the profile's own
  business or registered address.
- Work location and education location.
- Publicly reported past appearances and affiliations that resolve to a place: a board
  seat, a keynote, a named building, an event on a date that has passed.
- Location history, as a dated series rather than a single current value, because a profile
  that has moved is a profile with two dated entries.

**Every location entry states its date and its source on the card**, and an entry derived
by joining two sources is labelled as derived rather than reported. A profile with no dated
location shows none, and no default or approximation fills the gap.

**Removal requests are a feature, not a policy note.** A record can be removed and
suppressed directly, the suppression persists across re-ingest so the next crawl does not
resurrect it, and suppression is visible in the product with its reason. This is the same
mechanism already demoed for FAA LADD opt-outs and privacy ICAO addresses.

**The US position is documented before any public deployment carrying real profiles**: which
state laws apply to the population, how access and deletion requests are served inside the
stated windows, and data broker registration if that applies. Replaces the UK GDPR wording
in ADR 004 and in section 8 of the spec. It is a smaller obligation than the one it
replaces, not an absent one.

## What this does not change

One line survives, and it is the line between this product and a different product:

**A person never carries a live position, and presence is never inferred.** No current
location on a person. No "last seen". No correlating a named individual against a live
aircraft, vessel, camera or geotagged post to place them somewhere now. Asset movement stays
on the asset: an owned jet's live ADS-B position is shown on the aircraft, the ownership
link to the person is shown, and neither card claims the owner is aboard.

The reason is not the jurisdiction and does not change with it. The population is UHNW and
VHNW individuals, and a real-time or inferred location on a named wealthy private individual
is the input to extortion, burglary and worse. That risk sits with the individual, and the
reputational and legal exposure sits with whoever published the location, whichever
country's law is being read. Dated history does not carry that risk, which is why it is
permitted above and why the present tense is not.

Also unchanged: no face recognition or person identification on any camera image, no
de-anonymising a privacy ICAO address, and no wealth tier inferred from an asset or a
position.

## Consequences

**Location is a dated series, so the contract needs a date on every entry.** A location
without a date cannot be validated as historical, so it is dropped at the adapter and
counted, in line with the existing contract discipline.

**"Derived" has to survive to the card.** A location inferred by joining sources is the
weakest field on the profile and the most likely to be wrong about a named individual.
Labelling it is not decoration.

**Suppression state has to outlive the record.** Removing a row is not enough if the next
crawl re-adds it, so suppression is keyed independently of the ingest.

**Accuracy risk is ours.** A wrong location on a named person is a wrong claim published in
our name. Provenance, the date, and the removal route are the mitigation.

## Alternatives considered

**Add a current-location field and let the UI decide what to show.** Rejected. It puts the
whole distinction in the layer most likely to be changed by whoever ships the next feature,
which is the failure mode ADR 002 was written about.

**Keep location off the profile entirely.** Rejected. It does not match the product being
demoed, and dated public location data is ordinary wealth intelligence.
