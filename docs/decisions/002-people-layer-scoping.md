# ADR 002: the people layer is a knowledge map, not a locator

**Date:** 2026-08-19
**Status:** Superseded in part
**Amended by:** ADR 004 (the property allowlist is lifted; scraped and crowd-sourced person
data is permitted), ADR 006 (location is a dated profile attribute) and **ADR 007 (a person
may be joined to any data in the system, live position feeds included)** and ADR 008 (the
profile carries contact and identity attributes, and the jurisdiction is US state law rather
than GDPR). The
no-join-to-a-real-time-feed rule below no longer holds. The reasoning for it is kept here
deliberately, because it is the argument that was overruled and whoever revisits this should
read it rather than rediscover it.

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

**The people layer is a knowledge map of notable public entities. It is not a locator.**
(Overruled by ADR 007 and ADR 008. Kept as written because it is the decision that was taken
at the time.)

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

**Provenance on every card.** The relationship in words, links to Wikidata and Wikipedia,
both licences (Wikidata CC0, Wikipedia CC BY-SA 4.0), and a report control. Scheduled
re-sync from Wikidata propagates upstream deletion, which is the erasure mechanism.

