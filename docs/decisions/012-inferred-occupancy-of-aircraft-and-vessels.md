# ADR 012: occupancy of an aircraft or vessel is estimated, and always labelled an inference

**Date:** 2026-08-19
**Status:** Accepted
**Supersedes:** the phase 8 pattern-intelligence rule "aggregated across assets, never
pinpointing a person" in `docs/plan/implementation-plan.md`.
**Relates to:** ADR 007 (a person may be joined to any data in the system), ADR 009 (LADD
and PIA are worked through), ADR 011 (cross-source corroboration).

## Context

ADR 007 permits a person to be joined to a live feed and requires that an inference be
labelled as one. It used the aircraft case as its own example: the jet being airborne is a
fact about the aircraft, "the owner is aboard" is an inference. It stopped there and left
the inference unbuilt, and phase 8 went further and banned it outright by requiring pattern
intelligence to stay aggregate.

The instruction is to build it. The commercial case is plain: a customer asking "is the
principal travelling, and with whom" is asking the question the whole product exists to
answer, and the evidence to attempt it is already in the system by phase 11. Ownership from
the FAA registry and ITU MARS (phase 5), the profile and the associate graph from filings
(phase 6), route history we recorded ourselves (phase 8), the live transponder or AIS
position (phases 1 and 2), and privacy-address correlation (phase 11).

## Decision

**The product produces an occupancy estimate for an aircraft or vessel in flight or under
way, as an explicit inference with its evidence and its confidence shown, never as an
observation.** Default state is no estimate.

The evidence an estimate may draw on, all of it already in the system:

- **Ownership**, registry-sourced, with the existing entity-resolution confidence attached.
  A corporate owner resolves to the officers and beneficial owners behind it, each as a
  separate candidate rather than one merged blob.
- **Movement history we recorded ourselves**: home base, frequented airfield and marina
  pairs, typical departure windows, repeat routes.
- **The live position and track** from the transponder or AIS, including the current
  origin and destination pair where it can be established.
- **The associate graph**: co-directors, co-owners, fellow trustees and household members
  as they appear in public filings. Associates are candidates, not passengers.
- **Dated location evidence for each candidate from every other layer**: a geolocated or
  text-derived post, a news or online report placing them somewhere, a publicly reported
  appearance. This is the part that does most of the work, and it cuts both ways.

The rules, all in code and each asserted by a test:

- **Contradiction is fatal and beats corroboration.** A corroborated dated location for a
  candidate elsewhere in the same window removes that candidate outright. It does not just
  lower the score.
- **Corroboration follows ADR 011.** A single weak source placing a candidate near the
  departure airport does not put them on the aircraft.
- **Below the threshold no name is shown.** The card reads "occupants not established" and
  says what was considered. There is no half-named candidate. The threshold is set at least
  as high as the PIA correlation threshold in ADR 009 and the reason sits next to the
  constant.
- **Every estimate is labelled an inference, on the card and in the API**, with the evidence
  it rests on itemised and the confidence shown. An occupancy estimate is never rendered in
  the same style as an observed position.
- **Excluded from every aggregate.** An estimate never counts towards a figure, a ranking
  or a corridor statistic.
- **It never produces a location attribute on the profile.** An inferred occupant does not
  get a dated location entry. Only an observation or a reported location does that, per ADR
  006, and letting an inference write into the location series would launder it into
  evidence and then corroborate the next inference with itself.
- **It never touches the wealth tier.** Unchanged from ADR 007.
- **Suppression and removal apply first.** A person with a removal or suppression flag is
  never a candidate, and the estimate is computed after suppression rather than filtered
  afterwards.

## Consequences

**This is the highest-harm output in the system and it should be read that way.** Naming
who is aboard a specific aircraft in flight, for a population whose movements are a
personal security matter, is more sensitive than any single attribute on the profile. The
threshold, the inference label, the exclusion from aggregates, the contradiction rule and
the removal path are the only things holding it, and none of the five is negotiable or
tuned for a better-looking demo.

**Wrong here is worse than wrong anywhere else.** A wrong contact attribute attaches a
stranger to a profile. A wrong occupancy estimate puts a named person in a place they are
not, at a time, in a product a customer may act on. Hence contradiction being fatal and the
default being silence.

**It raises the stakes on the phase 6 US privacy position**, which now has to cover an
inferred, time-specific location claim about a named individual, not just held attributes.
That work stays a blocker on any public deployment carrying real profiles, and ADR 009's
point about selling the output being the risk applies here in its sharpest form.

**Most estimates will be "not established", and the ones that are not will usually be the
owner alone on a repeat route.** That is the honest ceiling of public data and the demo
shows the reasoning either way, because the reasoning is the product.

## Alternatives considered

**Keep pattern intelligence aggregate, as phase 8 originally had it.** Rejected on
instruction. It was the safe position and it answered a weaker question than the one
customers ask.

**Estimate occupancy but hold it internally, showing only that the asset is moving.**
Rejected for the same reason ADR 009 rejected the equivalent split. It keeps the exposure
and drops the demonstrable value.

**Estimate a headcount without naming candidates.** Rejected as dishonest rather than
safer. Public data gives no basis for a count, and a number with no names would be a
fabricated precision, which the no-approximation rule already forbids.
