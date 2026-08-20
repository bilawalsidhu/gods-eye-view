# ADR 014: what we read out of a post, and what we refuse to claim we read

**Date:** 2026-08-19
**Status:** Accepted
**Relates to:** ADR 005 (geolocated social posts), ADR 007 (a person may be joined to any data
in the system), ADR 011 (cross-source corroboration), ADR 012 (occupancy is an inference),
ADR 013 (people are identified in photographs), ADR 015 (all of this runs locally over one
evidence contract, and image reading is closed-set label scoring rather than open-vocabulary
description).

## Context

ADR 005 settled where a post draws its pin and stopped there. The post itself was treated as a
dot with a timestamp. The instruction now is to read the content: who is with whom, where they
are, why, how they feel about it, and the same questions asked of an attached photograph.

That is four different claims with four different evidence qualities, and lumping them together
is how a product ends up asserting a motive with the same confidence as a date.

## Decision

**A post is analysed for four things, each labelled separately, each derived, each one weak
source under ADR 011.**

**Sentiment is an attribute of the post, never of the person.** It is stored on the
`SocialPost` record. It never becomes a mood, a disposition or a risk score on a profile. Where
it is aggregated it is aggregated over posts about a subject and shown as exactly that: what
posts said, over a window, with the count. A profile carries no sentiment field.

**Co-presence is an inference, and the strongest thing this layer produces.** Two named people
in one post, resolved to two profiles, is evidence they were in the same place on that date. It
is not proof, because a post can name someone who is not there. So it is recorded as a dated,
sourced, confidence-scored link between two profiles, labelled an inference, and it needs an
independent origin before it is asserted. It feeds the associate graph and the phase 12
occupancy candidate set, where a corroborated co-presence elsewhere is a contradiction that
removes a candidate outright.

**An image is read for what and where, and the reading is derived.** A vision model naming a
landmark, a vessel, an aircraft livery, a venue or a registration in a photograph produces a
derived attribute with its own confidence, never an upstream one. A place read off a picture is
city-level at best and carries the same "location mentioned in the image" treatment that ADR
005 gave to a location read out of text. Who is in the image is ADR 013 and is governed there.

**Why is not asserted.** Motive is not observable and no model reads it off a photograph. Where
the author states a reason in their own words it is carried as a quote, attributed to them,
with no interpretation layered on top. Anything else is left empty, on the same rule that stops
this project approximating a missing field.

**How gets the same treatment.** A visible mode of travel in a photograph is an observation
about the photograph, so "a private jet appears in this image" is fine and "they flew private
to Nice" is an inference that needs the aircraft, the route and a date to stand up.

Every one of these carries its source, its date and its confidence onto the card, and every one
of them is excluded from aggregate counts while it is below the assertion threshold.

## Consequences

**A model output is not a source.** Whatever extracts co-presence, sentiment or image content
is machinery, so a claim resting only on it rests on one origin no matter how many fields it
populates. Two models agreeing is one source. This is the ADR 011 independence rule applied to
ourselves, and it is the rule that stops the enrichment layer inflating its own confidence.

**Co-presence is the highest-value and highest-harm output short of occupancy.** "These two
people were together on this date" is exactly what a customer pays for and exactly what is
damaging when wrong. It gets the unconfirmed state, the score on the card and the exclusion
from counts, and it never silently becomes a location entry on either profile.

**Sentiment will be read as being about the person however it is labelled.** Keeping it off the
profile contract is the only structural defence available, so it stays off, and a card showing
it says whose words it is measuring.

**This is all machine work with no reviewer**, per the project's standing rule. The threshold,
the unconfirmed state, the provenance display and the removal control carry the whole burden.

## Alternatives considered

**Put a sentiment score on the profile.** Rejected. It is a fabricated attribute of a person
built from what other people wrote, it invites use as a risk or propensity signal, and no
public source supports it.

**Treat two names in a post as an asserted meeting.** Rejected. A post naming two people is
frequently about neither of them being together, and asserting it would put a wrong meeting on
two real profiles from a single crowd-sourced sentence.

**Infer intent and motive from post text.** Rejected as fabricated precision. The project
already refuses to approximate a missing field, and a motive is a missing field on almost every
post there is.
