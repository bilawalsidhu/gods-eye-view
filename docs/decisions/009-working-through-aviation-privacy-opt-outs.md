# ADR 009: LADD and privacy ICAO addresses are worked through, not honoured

**Date:** 2026-08-19
**Status:** Accepted
**Supersedes:** the LADD and PIA suppression rules in ADR 002, in the scope section of
`docs/plan/implementation-plan.md`, and in phases 3 and 5 of that plan.
**Relates to:** ADR 007 (a person may be joined to any data in the system), ADR 008
(production profile attributes, contact data included).

## Context

Two aviation privacy mechanisms were honoured by this project and are now not.

**FAA LADD** (Limiting Aircraft Data Displayed) is a voluntary programme. An owner asks the
FAA to withhold their aircraft from the data feeds the FAA itself provides to subscribers.
It binds those feeds. It does not bind a volunteer receiver network listening to a
transponder on 1090MHz, which is where every position in this project comes from. We were
applying a suppression that was never handed to us.

**A privacy ICAO address (PIA)** is an FAA programme letting an aircraft broadcast a
temporary hex code not tied to its registration, so a listener cannot look it up. Defeating
it means correlating the anonymous track against everything else observable (type, callsign,
airport pair, timing, prior sightings) and inferring the registration.

The commercial case for both is the same and it is real. The population that uses LADD and
PIA overlaps almost exactly with the population this product is built to profile, so
honouring the opt-outs removed the join precisely where it mattered most. ADR 007 already
established that the join is the product.

## Decision

**LADD is not applied.** A LADD-listed aircraft is resolved and displayed like any other,
from phase 3. Nothing in the ownership path reads a suppression list. Being on the LADD
programme is carried as an attribute on the record, because it is itself a fact about the
owner worth having on a wealth profile, and it is not a display block.

**PIA is correlated, in phase 11.** A privacy address is matched back to a registration by
scored candidate generation over observable signal. Three constraints, all in code:

- **The threshold is set higher than for a plain registry join**, with the reason recorded
  next to the constant. A PIA correlation is a probabilistic claim about an identity that
  was deliberately obscured, so a wrong one is worse than a wrong ordinary join.
- **Below the threshold nothing is asserted.** Possible match, score shown, excluded from
  every aggregate.
- **The anonymity is never hidden.** A correlated card shows that the aircraft was
  broadcasting anonymously and that our identification is inferred, not observed.

## Consequences

**This is the deliberate defeat of a privacy choice, and the document says so.** An owner on
LADD or PIA took a step to not be looked up. The product now looks them up anyway. That is
the instruction, it is a legitimate commercial call for the business to make, and it is
written down plainly so nobody later reads the code and assumes it was an accident.

**The legal position is unsettled rather than clear, and it differs between the two.**
Neither LADD nor PIA is backed by a statute prohibiting third-party correlation, and
ADS-B is an unencrypted broadcast, which is the basis on which every public flight tracker
operates. So the exposure is not primarily aviation law:

- **Selling the output is the risk, not observing it.** Publishing aggregated movement
  data about identified private individuals runs into state privacy statutes, data broker
  registration regimes (California's Delete Act reaches brokers directly), and contractual
  terms on any upstream we resell. ADR 008's US position work has to cover this
  specifically, not just profile attributes in general.
- **PIA correlation is closer to the line than LADD.** Circumventing a technical measure
  designed to prevent identification is a harder argument to defend than declining to apply
  a display list we were never given, and it is the part a regulator or a journalist would
  pick up first.
- **Reputational exposure is concrete.** The population is UHNW individuals and their
  families, for whom aircraft movement is a personal security matter. A product that
  unmasks their deliberately anonymised aircraft will be reported that way if it surfaces.

**None of the above is a reason not to build it.** It is the exposure the business is
choosing to take, and the phase 6 US privacy position is the gate on shipping it publicly.

**Removal still works.** A removal request deletes and suppresses, per ADR 008, and that is
now the only suppression path in the product. It is ours, not the FAA's.

## Alternatives considered

**Honour LADD, correlate PIA.** Rejected on instruction. It was the position with the
cleanest story (we apply the list the FAA publishes, and we read public radio otherwise)
and it would have cost the join on exactly the aircraft that matter.

**Correlate PIA but hold it internally, showing only the ownership join and not the
movement.** Rejected on instruction. It would have kept the enrichment value while leaving
the anonymised track unpublished, which is where most of the reputational exposure sits.
