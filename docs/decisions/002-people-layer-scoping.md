# ADR 002: the people layer is a knowledge map, not a locator

**Date:** 2026-08-19
**Status:** Accepted

The most consequential decision in this project. Read it before touching anything in the
people layer, and read `docs/superpowers/specs/2026-08-19-tracker-design.md` section 8
alongside it.

## Context

The brief asks for search across notable public figures and organisations, with the camera
flying to a relevant place and a card explaining what you are looking at. Sitting next to
that, in the same application, are live aircraft, live ships and live cameras.

That adjacency is the risk. An application that shows a person's name on a globe next to a
live aircraft layer is one feature request away from being a tool for locating people. The
harm is not hypothetical and the wrong version of this feature is both a UK GDPR breach and,
in the wrong hands, Protection from Harassment Act 1997 territory.

Policy does not survive a feature request. A rule written in a document ("we do not show
current locations") lasts until someone asks for a reasonable-sounding feature and nobody
in the room remembers why the rule exists. So the constraint has to be somewhere a feature
request cannot reach it.

## Decision

**The people layer is a knowledge map of notable public entities. It is never a locator.**

Enforcement lives in the data layer, not in policy.

**Notability is a query constraint.** Only Wikidata entities holding a Wikipedia sitelink
are searchable. That is a mechanical filter rather than a judgement call, and it excludes
private individuals by construction: a person with no Wikipedia article cannot be found,
because the search never returns them.

**A map pin can only come from the property allowlist.** Coordinates reach the renderer
only through these static, public, historical association properties, resolved via
coordinate location (P625):

| Property | Meaning |
| --- | --- |
| P19 | Place of birth |
| P20 | Place of death |
| P159 | Headquarters location |
| P937 | Work location |
| P69 | Educated at |
| P7153 | Significant place |

Nothing else can produce a pin. Not a property that looks similar, not a new one someone
finds useful, not a coordinate that happens to be attached to the entity.

**Residence and living-human coordinates are excluded inside the SPARQL query itself.**
P551 (residence) and raw coordinates on any living human (an instance of Q5 with no P570
date of death) are filtered in the query sent to Wikidata, not in the code that reads the
response. The reason is specific: a home address is then never fetched, never enters this
process, never reaches a log, and cannot render even if a later bug lets something through
a downstream filter. Filtering after the fetch would leave the address in memory and one
mistake away from the screen.

**No present tense, anywhere.** No "last seen". No current location. No movement lines. A
pin reads "Born in Ulm, per Wikidata" and says which relationship it represents.

**No code path joins a person to any live feed.** Person search and the GDELT event layer
share no code path, and that separation is asserted structurally by a test rather than left
to review. GDELT pins are labelled "news coverage location", because that is what GDELT
geocodes: where a story is about, not where anyone is.

**No geocoding of arbitrary names**, and no user-contributed person records.

**Provenance on every card.** The relationship in words, links to Wikidata and Wikipedia,
both licences (Wikidata CC0, Wikipedia CC BY-SA 4.0), and a report control. Scheduled
re-sync from Wikidata propagates upstream deletion, which is the erasure mechanism.

## Consequences

**Legal work is a gate on public deployment, not a follow-up.** Before this layer is
exposed publicly, three documents must exist under `docs/`:

- a written **legitimate-interests assessment** under UK GDPR Article 6(1)(f), which is the
  lawful basis being relied on;
- a **data protection impact assessment**, because this is large-scale processing of
  personal data with a plausible risk to the rights of the people involved;
- a **public privacy notice** relying on Article 14(5)(b), the disproportionate-effort
  exemption from notifying each individual, which only holds because the data is already
  public and the processing is narrow.

All three are phase 6 deliverables. The layer does not go public without them.

**The allowlist is load-bearing and is never widened for a feature request.** Adding a
property to that list is not a small change, it is a change to the legal basis of the
feature. Every entry on it is defensible as a static, public, historical association about
a person notable enough to have a Wikipedia article. Add current-location or
residence-adjacent properties and the GDPR balancing test flips: the legitimate-interests
assessment above stops holding, and the feature becomes the thing this ADR exists to
prevent. If someone asks for it, the answer is no, and this document is why.

**Some searches return nothing on the map, and that is correct.** A notable person with no
allowlisted place property has a card and no pin. Showing an approximate or inferred
location to fill the gap is exactly the failure mode being designed out.

**The feature is deliberately less capable than it could be.** Wikidata holds far more than
seven usable properties. We use seven. That is the trade, taken on purpose.

**The same principle governs cameras**, because it is the same class of risk applied to a
different feed. Official and owner-consented sources only: Transport for London JamCams
under TfL open data terms, and the Windy webcam directory, which is owner-submitted.
Aggregators of unsecured private cameras are excluded outright. No face recognition or
person identification on any camera image, ever.

## Alternatives considered

**Policy-only enforcement, filtering in application code.** Rejected. It puts the
constraint in the layer most likely to be edited, by whoever is implementing the next
feature, months after anyone remembers the reasoning. It also means the sensitive data is
fetched and held in the process before being discarded, so any logging or caching bug
becomes a disclosure.

**A blocklist of dangerous properties instead of an allowlist.** Rejected. A blocklist
fails open. Wikidata gains properties continuously, so anything not yet blocked would
render, and the failure mode is a home address on a globe. An allowlist fails closed: an
unknown property yields nothing.

**Notability by follower count, page views or an editorial list.** Rejected. Each is a
judgement call that someone has to make and defend, and each drifts. A Wikipedia sitelink
is mechanical, externally maintained, and already the outcome of a community notability
process.

**Dropping the people layer entirely.** Considered seriously, and it remains the fallback
if the assessments above cannot be completed. It was not chosen because the scoped version
is genuinely useful (fly to where Einstein was born, see where an organisation is
headquartered) and is defensible on data that is already public, historical and static. The
scoping is what makes it defensible, which is why the scoping is not negotiable.

**Including current residence for public figures whose addresses are already published.**
Rejected without qualification. "Already published somewhere" is not a lawful basis, and
aggregating scattered public facts into a single searchable map is precisely the
aggregation harm data protection law exists to address.
