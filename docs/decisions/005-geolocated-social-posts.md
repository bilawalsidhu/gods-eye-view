# ADR 005: geolocated social posts are a subject layer, not a people layer

**Date:** 2026-08-19
**Status:** Accepted, amended
**Amended by:** ADR 007. The no-join-to-a-person clause below is overruled: a post may be
joined to a person or organisation record like any other data, carrying the join's source,
confidence and date. Everything else here stands, in particular the `upstream` versus
`derived` split, which is what stops a join manufacturing precision it does not have.
**Relates to:** ADR 002 (people layer scoping), ADR 004 (scraped and crowd-sourced data)

## Context

The brief asks for social media post locations, text and image. That is a reasonable ask
and it is also the single feature in this project most likely to turn it into something we
would not want to demo, because the obvious implementation is a person locator.

Three facts shaped the decision, all verified on 2026-08-19 and recorded in
`docs/data-sources.md`.

**The platforms that had real geotagging are gone.** Twitter's public API is closed,
Instagram's location endpoints are closed, Panoramio is dead. What remains keyless is
Mastodon, OpenStreetMap notes, Wikimedia Commons geosearch and Flickr on a free key.

**A Mastodon post has no coordinates.** The status object returned by
`/api/v1/timelines/public` carries `content`, `tags`, `media_attachments`, `account` and
`created_at`, and nothing positional. Any position we show on a Mastodon post is one we
invented from its words. That is a different class of claim from an AIS position report and
cannot be presented in the same way.

**Some sources carry a real coordinate about a real subject.** An OpenStreetMap note is a
comment left *at* a place, about that place. A Commons geosearch result is a photograph
*of* a place. Neither says anything about where its author is now.

That split is the whole design.

## Decision

The social post layer maps the location of a post's **subject**, never its author.

**One contract, `SocialPost`, with a `location_basis` field.** Two values. `upstream` means
the source supplied the coordinate: OpenStreetMap notes, Commons geosearch, Flickr with
`has_geo`. `derived` means we resolved it from the text: Mastodon. The field is required,
so no post can exist in the domain without stating which it is.

**A derived location is labelled in words on the card**, as "location mentioned in the
text", with the matched phrase shown. Derivation is a gazetteer match against the phase 4
city index only. No per-post geocoding call, no coordinate precision beyond the city, no
fallback to a general geocoder.

~~**No post is joined to a person or an organisation record.**~~ **Overruled by ADR 007.** A
post may be joined to a person or organisation, and the join carries its source, its
confidence and its as-of date on the card. A sub-threshold join shows as a possible match
and counts towards nothing. The author handle and a link to the original post remain the
only author data stored, because attribution requires them and nothing else does.

The `derived` label does the load-bearing work once joins are allowed. A city-level match
from a post's words, joined to a profile, is a dated entry sourced to that post at
city-level precision. It is not an observed position and the card does not read like one.

**A post is a fixed event, not a mover.** It has a timestamp and no motion. Two posts
joined to the same profile are two dated points, which is evidence, and the line between
them is not, so the globe does not draw one. Interpolating a route between two mentions
would be inventing the bit in the middle.

**Media is proxied, cached and licence-checked.** An image whose licence cannot be
determined is dropped and counted, not shown. Licences here are per item, not per source.

**No face recognition, no person identification, on any image.** Already the rule for
cameras under ADR 004, restated here because an image layer invites it.

## Consequences

**The pin is still about the subject, but the join is not.** "Show me posts about Monaco"
is what the layer draws on the globe. Under ADR 007 those posts can then be joined to a
profile, so "posts we have linked to this person, and where each one points" is available on
the card with a confidence and a date per link. What is not available is a pin asserting the
author's position, because no source in the layer supplies one.

**Mastodon coverage will be thin.** Public timelines are small, geographic mentions are
rare, and the city gazetteer will miss most posts. Thin is the correct outcome of not
inventing precision.

**Instance availability is not ours to control.** `mastodon.social` answered HTTP 422
`{"error":"This method requires an authenticated user"}` anonymously on 2026-08-19, while
`mas.to` answered 200 for the identical request. The instance list is configuration and an
instance refusing us is dropped for that cycle, not a feed failure.

**The report control has to cover posts.** A crowd-sourced record has no upstream deletion
to propagate, per ADR 004, and a post surfaced in the wrong place is exactly the case
someone will want removed.

**Flickr is unresolved commercially.** Per-photo licensing means the licence filter has to
be set before any public deployment, not after.

## Alternatives considered

**Pin posts to author-reported location.** Not available rather than rejected. None of the
four sources reports an author position: a Mastodon status has no positional field at all,
and an OSM note, a Commons file and a Flickr photo all carry a coordinate about their
subject. ADR 007 lifted the policy objection, but there is still nothing to read.

**Geocode every post with Nominatim.** Rejected twice over. Nominatim's terms prohibit bulk
use, and per-post geocoding manufactures street-level precision from a passing mention of a
city.

**Drop the layer.** Tempting, and rejected. The subject-location half of it is genuinely
useful (what is being said and photographed about a place, alongside what is moving through
it) and the sources for that half carry real coordinates about real places.

**Bluesky as a text source.** Deferred. `app.bsky.feed.searchPosts` answered HTTP 403 from
this network on 2026-08-19 while `app.bsky.actor.getProfile` answered 200, so search is
gated, and Bluesky posts carry no coordinates either. It would add volume to the derived
half and nothing to the upstream half.
