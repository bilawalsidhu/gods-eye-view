# ADR 013: people are identified in photographs, against the profiles we already hold

**Date:** 2026-08-19
**Status:** Accepted
**Supersedes:** the "Facial recognition linking public photographs to named people" entry
under "Not designed in this repo" in `docs/plan/implementation-plan.md`, and the matching
exclusion carried in `AGENTS.md`, `README.md`, ADR 004, ADR 007 and ADR 008.
**Relates to:** ADR 007 (a person may be joined to any data in the system), ADR 009 (privacy
addresses are correlated, with the inference shown), ADR 011 (cross-source corroboration),
ADR 012 (occupancy is an inference), ADR 014 (post content analysis), ADR 015 (entity
resolution and inference run locally, which is how this is built: the face embedder proposes
candidates and never scores the match, and no photograph is sent to a third-party API).

## Context

Every prior document in this repo excluded this. The reason recorded was never effort: it is
the Clearview AI fact pattern. The ICO fined Clearview £7.5m with a deletion order, France,
Italy, Greece and the Netherlands took their own enforcement, Illinois BIPA gives a private
right of action over a faceprint and Texas CUBI gives the state one, and the EU AI Act treats
some deployments as prohibited and the rest as high risk. Several US states treat a faceprint
as biometric identifier data needing a consent that a scraped photograph cannot supply.

That position was put in front of Alexander Fanthome on 2026-08-19, in those terms, alongside
the alternative of taking names only from captions, tags and alt-text. **He chose face
matching, and this ADR records that the decision is his.** The commercial case is the same one
behind ADR 012: a photograph is often the only public evidence placing a named person
somewhere on a date, and the product's whole job is placing named people.

## Decision

**The product matches faces in public photographs against the profiles it already holds, and
every match is an inference with its confidence and its evidence shown.**

The shape of the thing matters more than the fact of it:

- **It is 1:N against a known profile list, not open-set identification of the public.** The
  candidate set is the profiles in the system. There is no capability to answer "who is this
  stranger", and none is built.
- **The reference face comes from Wikidata P18 resolved to Commons**, so every reference
  photograph is attached to a known entity and carries its own licence. A person with no P18
  has no reference face, no match is possible, and none is asserted.
- **A face found in a photograph that matches no profile is discarded, not stored.** We do not
  accumulate face data on the general public. This is the line between matching against people
  we already profile and building a biometric database, and it is not negotiable.
- **The threshold sits above an ordinary registry join**, on the same reasoning as ADR 009's
  privacy-address rule: the harm from a wrong match is attaching a real stranger to a named
  profile.
- **A face match alone never crosses the assertion threshold**, per ADR 011. It is one source.
  It needs an independent origin agreeing before the location it implies is asserted, and a
  photograph plus the caption naming the same person is one source, not two.
- **Below the threshold it is a possible match** with its score, excluded from every aggregate,
  never asserted.
- **The card says the identification is inferred from a photograph**, names the photograph, its
  source, its licence and its date, and shows the confidence. It never reads as an observation.
- **A location from a photo match is a dated location entry** like any other, dated to the
  photograph rather than to the match, and labelled derived.
- **Suppressed people are excluded from the candidate set**, not filtered from the output, and
  a removal deletes the reference embedding with everything else.
- **A photograph whose licence cannot be determined is not used**, same rule as the rest of the
  media layer.

**It is not applied to camera feeds.** Owner-published traffic and city cameras are in scope as
a camera layer and out of scope for face matching. Matching a licensed Commons portrait against
a licensed Commons photograph is a different act from running recognition over a live public
street, and the second one is where the prohibited-practice end of the EU AI Act and the public
reaction both live. If that is wanted it is a separate decision, taken deliberately, not a
quiet consequence of this one.

## Consequences

**A written legal position is a blocker on public deployment carrying real profiles.** It has
to name the jurisdictions the product will operate in and the consent basis claimed, signed off
by counsel rather than by engineering. This does not block the demo and it does not block the
build. It blocks shipping to real customers with real people in it, and it sits next to the US
privacy position already listed as a phase 6 deliverable.

**Illinois and Texas are the sharpest exposure in the US**, and the population is US-based per
ADR 008. BIPA is a private right of action with statutory damages per violation, which is the
mechanism that makes it expensive rather than merely regulatory.

**The reference set is thin and skewed.** Wikidata P18 covers a fraction of any wealth
population and covers the already-famous best. Most profiles will never have a reference face,
so most photographs will produce nothing. That is the honest ceiling and the demo should show
it rather than hide it.

**Accuracy is not uniform across faces.** Published evaluations of face matching consistently
show higher false-match rates for some demographic groups than others, which means a wrong
match is not randomly distributed. With no researcher in this project to catch one, the
threshold and the unconfirmed state carry that whole weight.

## Alternatives considered

**Names from captions, tags, alt-text and EXIF only.** Rejected on instruction. It was offered
as the alternative, it carries almost none of this exposure, and it would have answered a
weaker version of the question.

**Match faces but hold the result internally.** Rejected for the reason ADR 009 and ADR 012
both rejected the equivalent split. It keeps the exposure and drops the value.

**Open-set identification of anyone in a photograph.** Rejected, and this one was not a close
call. It is the Clearview product exactly, it requires retaining face data on people we hold no
profile for, and nothing in the brief needs it.
