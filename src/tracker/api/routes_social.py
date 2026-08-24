"""The social post read route: posts about a place, saying how each one was placed.

Read ADR 005 first. The one thing this route exists to protect is that
:attr:`~tracker.contracts.social.SocialPost.location_basis` reaches the client on every post,
so a client never has to infer whether a pin is a coordinate the provider gave us or a city we
resolved from a sentence. That is guaranteed structurally rather than by care here: the field is
required on the contract, so a post cannot be serialised without it.

**The two halves of this layer have opposite triggers, and neither was a choice.** The lead
asked whether to poll or to go demand-driven, and the providers answer it.

*Commons is demand-driven because it has no other mode.* Geosearch is a radius query capped by
the provider at 10km, verified from its own error body. There is no "give me the world" call, so
a poller would have to sweep the globe in 10km circles, which is on the order of five million
requests for photographs nobody is looking at. So it is asked when someone looks somewhere, at
most once a second, which is the floor the client already owns.

*Mastodon is polled because it cannot be asked about a place at all.* A public timeline is a
firehose with no geographic query of any kind: you take what it gives and derive locations from
the words. There is nothing to make demand-driven. Its floor is the provider's own
``cache-control: max-age=15``, because polling faster than a provider's cache cannot return
anything new.

**Wide viewports are answered honestly rather than tiled.** The obvious way to cover a
viewport wider than 10km is to tile it into circles, and at country zoom that is hundreds of
requests per pan. So this route asks once, at the centre of the box, with the radius clamped to
what the provider allows, and **reports the radius it actually searched** in
:attr:`SocialSnapshot.searched_radius_m`. A client can then say "photographs within 10km of the
centre of this view", which is true, rather than showing a sparse scatter that reads as a broken
layer. Nothing here presents partial coverage as complete, which is the whole reason the field
is on the response rather than in a comment.

**Media is served as our own address, not the provider's.** Every media URL is rewritten to the
proxy before it leaves this route, so ADR 005's no-hot-linking rule is closed at the boundary
rather than trusted to a client that has to know about Wikimedia. A URL the proxy would refuse
is passed through unchanged rather than being dressed up as a proxy address that will 400; the
adapter's licence and rendition checks are what stop such a URL existing in the first place.

**Mastodon posts carry no media and the shape does not pretend otherwise.** A status has no
rights field, so its attachments cannot be licensed and the adapter drops them. Nothing here
special-cases that: an empty ``media`` tuple is simply what a derived post has.

**The clients live on the state, and that was a correctness fix rather than tidying.** Both hold
state that only means anything across requests, the cadence floors and the last timeline page,
so they have to outlive one. They used to be a module-level singleton here, built on first use,
which served correctly and broke the removal path: a :class:`~tracker.services.social.SocialClients`
constructed in ``build_state`` was a *different object* from the one this route answered out of,
so a removal under ADR 008 swept a page nobody read and reported reaching a cache it had never
touched. :class:`~tracker.api.state.AppState` builds the pair itself now, so there is one per
state by construction and no wiring step that can be missed.
"""

import logging
from typing import Annotated, Final

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from tracker.api.routes_media import proxy_url
from tracker.api.state import StateDep
from tracker.contracts.base import ContractViolationError, StrictModel, UtcDatetime
from tracker.contracts.geo import BoundingBox
from tracker.contracts.social import SocialPost
from tracker.sources import commons
from tracker.sources.base import RateLimitedError, SourceError, describe_exception

_log = logging.getLogger(__name__)

SOCIAL_PATH: Final = "/api/social"
"""The full path, carried on the route rather than left to a mount prefix.

``app.py`` includes every router with no prefix, so each one owns its own paths. This matches
``routes_media`` beside it; ``routes_entities`` reaches the same place by putting ``/api`` on
its ``APIRouter`` instead, and either works as long as the router and the constant agree.
Spelling it in full here means a caller importing this constant gets the address that actually
serves, which is what stopped the proxy URL builder being able to drift."""

READ_LIMIT: Final = 540
READ_LIMIT_MAX: Final = 600
"""How many posts one call will return. A ceiling, not a target, and it has to sit above the sum.

**It was 200 while the Commons half fetched 500, which is the same bug one layer up.** A limit
that truncates records already fetched, parsed and licensed spends the whole cost of them and
then throws 300 away, and nothing in the response says it happened. 540 is one Commons query at
its 500 ceiling plus one Mastodon page at its 40, so the default cannot silently cut either half;
the max is round headroom above that. Whenever you change either provider's page size, change
this, and the way to notice is that the two numbers are named in this docstring."""


class SocialSnapshot(StrictModel):
    """Posts near a place, and an honest account of how far we looked.

    ``searched_radius_m`` against ``box_radius_m`` is the pair that matters. When the first is
    smaller, the answer covers the middle of the requested box and nothing further out, and a
    client that ignored the difference would render partial coverage as a thin scatter.
    """

    count: int
    posts: tuple[SocialPost, ...]
    searched_radius_m: int
    box_radius_m: int
    derived_as_of: UtcDatetime | None = None
    """When the polled half last returned a timeline. None before the first successful poll."""
    notices: tuple[str, ...] = ()
    """Plain statements about what this answer does not cover. Empty when it covers the box."""


def proxied(post: SocialPost) -> SocialPost:
    """The same post with every media address pointing at our proxy.

    ``model_copy`` rather than a rebuild, so a field added to either contract travels through
    here without this function needing to know about it. A rebuild that listed the fields would
    silently drop the new one.
    """
    if not post.media:
        return post
    media = tuple(
        item.model_copy(
            update={
                "url": proxy_url(item.url),
                "preview_url": None if item.preview_url is None else proxy_url(item.preview_url),
            }
        )
        for item in post.media
    )
    return post.model_copy(update={"media": media})


router = APIRouter()


@router.get(SOCIAL_PATH)
async def list_social_posts(
    state: StateDep,
    *,
    west: Annotated[float, Query(ge=-180.0, le=180.0)],
    south: Annotated[float, Query(ge=-90.0, le=90.0)],
    east: Annotated[float, Query(ge=-180.0, le=180.0)],
    north: Annotated[float, Query(ge=-90.0, le=90.0)],
    limit: Annotated[int, Query(ge=1, le=READ_LIMIT_MAX)] = READ_LIMIT,
) -> SocialSnapshot:
    """Posts whose subject is in this box, each saying how it came to be placed there.

    The box is required rather than optional, unlike the mover routes. Those hold a world set
    and filter it; this one has to ask a provider about a place, and a request with no place is
    not a smaller version of this query, it is a different one.

    Raises:
        HTTPException: 422 when the box is inverted, which is the caller's mistake rather than
            ours and must not read as a server fault. A ``west`` greater than ``east`` is
            legitimate and means the box crosses the antimeridian.
    """
    try:
        box = BoundingBox(west=west, south=south, east=east, north=north)
    except ValidationError as exc:
        detail = exc.errors()[0]["msg"] if exc.errors() else "invalid bounding box"
        raise HTTPException(status_code=422, detail=detail) from exc

    held = state.social
    box_radius = int(box.enclosing_radius_m())
    searched = min(box_radius, commons.RADIUS_MAX_M)

    notices: list[str] = []
    upstream: tuple[SocialPost, ...] = ()
    try:
        parsed = await held.commons_client.posts_near(box.centre, radius_m=searched)
        upstream = parsed.records
        if parsed.dropped + len(parsed.records) >= commons.RESULT_LIMIT:
            # The same honesty as `searched_radius_m`, for the other axis. Central London
            # returns a full 500 even inside a 359m circle, so a count of 500 is the ceiling
            # rather than a total, and a client that read it as a total would be wrong about
            # every dense place. Counted on the records the provider sent rather than the ones
            # that mapped, or a single dropped file would hide the truncation.
            notices.append(
                f"the nearest {commons.RESULT_LIMIT} photographs, not all: provider ceiling"
            )
    except RateLimitedError:
        # Our own one-per-second floor, or the provider's. Not an error: the caller asked
        # faster than we are allowed to ask, and saying so beats an empty answer that reads
        # as "no photographs here".
        notices.append("photographs skipped: asked again inside its one-second floor")
    except (SourceError, ContractViolationError, httpx.HTTPError) as exc:
        # Named rather than a bare `except Exception`: a read route must not 500 because one
        # provider misbehaved, and it must not swallow our own bugs while it is at it. These
        # three are the ways a provider fails; anything else is ours and should surface.
        _log.info("commons geosearch failed: %s", describe_exception(exc))
        notices.append(f"photograph search unavailable: {describe_exception(exc)}")

    await held.refresh_derived()
    notices.extend(held.notices)

    if box_radius > searched:
        # The honest statement, and the reason `searched_radius_m` is on the response at all.
        notices.append(
            f"photographs within {searched // 1000}km of the centre, the provider's widest"
        )

    inside = [post for post in (*upstream, *held.derived) if box.contains(post.point)]
    inside.sort(key=lambda post: post.posted_at, reverse=True)
    posts = tuple(proxied(post) for post in inside[:limit])
    return SocialSnapshot(
        count=len(posts),
        posts=posts,
        searched_radius_m=searched,
        box_radius_m=box_radius,
        derived_as_of=held.derived_as_of,
        notices=tuple(dict.fromkeys(notices)),
    )
