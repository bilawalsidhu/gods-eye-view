# ADR 007: a person may be joined to any data in the system

**Date:** 2026-08-19
**Status:** Accepted, amended
**Amended by:** ADR 008, which corrects the UK GDPR paragraph in Consequences below (the
frame is US state privacy law, not GDPR) and states what a profile actually holds now that
the join is permitted. Then ADR 011, which sets what a join and an attribute have to clear
to be asserted at all (independent corroboration, not one source). Then ADR 012, which
builds the inference this ADR used as its own example, "the owner is aboard", as a phase 12
occupancy estimate with its evidence and its confidence shown.
**Supersedes:** every rule in this project that forbade joining a person record to other
data. Specifically: ADR 002's "no join between a person's name and any real-time feed",
ADR 004's restatement of it, ADR 005's "no post is joined to a person or an organisation
record", section 8 of the design spec, the scope boundary in
`docs/plan/implementation-plan.md`, the people-layer section of `AGENTS.md`, the "where it
stops" section of `docs/business-context.md` and the scope note in `README.md`.

## Context

The project was built with a structural firewall around person records. A person could be
joined to an owned asset and to nothing else: not to a live position feed, not to a
geolocated social post, not to an event. The separation was asserted by tests so that it
could not be undone by a feature request.

That firewall has been removed on instruction. The join is the product. Altrata's
commercial value is a profile resolved against everything else that is known, and a demo
that refuses the join demonstrates the opposite of what the business sells. Holding a
person apart from the data also produced a strange result in practice: the profile could
show an owned jet's live position while the schema pretended no connection existed between
the two.

The privacy argument for the firewall was made in ADR 002 and is recorded there. It has
been considered and overruled.

## Decision

**A person record may be joined to any other data in the system.** Live feeds included:
aircraft, vessels, satellites, cities, organisations, social posts, events and cameras.
There is no prohibited join and no structural test asserting a separation.

What replaces the firewall is evidence discipline, which was always the better mechanism:

- **Every join carries its source, its confidence and its as-of date**, and those render on
  the card. This is the existing entity-resolution machinery from phase 6, applied to every
  join rather than to ownership alone.
- **A join below the confidence threshold is not asserted.** It is displayed as a possible
  match with its score and is excluded from every aggregate. Unchanged from phase 6, and it
  matters more now, because chimera profiles are a live production problem in the business.
- **An inference is labelled as an inference.** An owned aircraft being airborne is a fact
  about the aircraft. "The owner is aboard" is an inference, and if the product says it, it
  says it in those words with what it is based on.
- **A location is a dated attribute with provenance**, per ADR 006. A join to a live feed
  produces a dated entry like anything else, with the feed named as its source.
- **No fabricated precision.** A city-level match stays city-level. A derived location says
  derived. Unchanged from ADR 005 and ADR 006.
- **Removal on request removes and suppresses the record**, keyed independently of ingest so
  the next crawl does not resurrect it. Unchanged, and now the primary control.

## What this does not change

Less than this ADR originally left standing. ADR 009 then reversed the aviation opt-outs, so
what remains is:

- **No aggregators of unsecured private cameras.** Unauthorised access to someone's
  misconfigured device, not a data-sourcing choice. Still binding.
- ~~**Facial recognition identifying named people from photographs.** Intended by the
  business, not designed in this repo.~~ **Reversed by ADR 013.** Faces are matched 1:N against
  held profiles, in phase 14. Not open-set, not on camera feeds, and a face matching no profile
  is discarded rather than stored. A written legal position from counsel remains a blocker on
  public deployment carrying real profiles.

And what changed after this ADR was written:

- ~~**No de-anonymising of a privacy ICAO address.**~~ **Reversed by ADR 009.** LADD is not
  applied and privacy addresses are correlated back to registrations in phase 11, above a
  higher threshold, with the anonymity and the inference shown on the card.

## Consequences

**The product is now capable of being a person locator, and the code no longer prevents
it.** That is the direct consequence of the instruction and it should be stated plainly
rather than softened. The population this demo is built around is UHNW individuals, for whom
being locatable is a real security exposure for them and their families. The mitigation is
now provenance, confidence and the removal control, all of which are weaker than a
structural test, because they depend on the product being used as intended.

**The privacy position is now load-bearing and unresolved.** ~~The UK GDPR Article 6(1)(f)
legitimate-interests assessment, the DPIA and the privacy notice from ADR 004.~~ **Corrected
by ADR 008:** UK GDPR is the wrong instrument and was already superseded by ADR 006. The
population and the customers are in the United States, so the frame is the US state
patchwork, CCPA and CPRA first. What survives the correction is the substance: joining person
records to live position feeds is a materially different processing activity from a dated
biographical attribute, and the US position has to be written against the joins as they now
stand rather than the old scope. **This ADR does not clear that work; it enlarges it.**
Nothing carrying person data goes public until it is done. ADR 008 enlarges it again by
adding contact attributes.

**Accuracy risk rises with the join count.** A wrong join is a false statement about a named
person in our name. The confidence threshold and the "possible match" display are the only
things standing between a demo and a defamatory claim, so neither is optional and neither
may be tuned down for a better-looking demo.

**Tests change shape.** The structural separation tests are deleted. What replaces them:
tests that every join renders a source, a confidence and a date, that a sub-threshold join
is excluded from aggregates, and that an inference is labelled as one.

## Alternatives considered

**Permit the join everywhere except live position feeds.** Rejected on instruction. It was
the narrower change and it would have kept the security argument for the UHNW population
intact while still allowing the profile, posts and events to be joined up.

**Permit the join behind a feature flag.** Rejected for the same reason ADR 004 rejected it.
A flag that switches the privacy posture of the product is worse than a written decision,
because nobody can tell from the code which posture is live.
