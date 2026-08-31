"""One official, owner-published traffic camera.

**The boundary that defines this layer is legal, not technical.** Only feeds published by
the body that owns the cameras are permitted: a road authority publishing its own CCTV
inventory. Aggregators of unsecured private cameras are excluded on principle and stay
excluded, because they index cameras whose owners misconfigured them and using one is
unauthorised access to a private system (Computer Misuse Act 1990 in the UK, state
computer-access statutes and the CFAA in the US). Every provider behind this contract was
found on the authority's own domain, publishing its own estate.

**ADR 013 does not reach this layer and must not be extended to it.** Faces are matched in
photographs against profiles we already hold. A camera stream is explicitly out of that
permission, so nothing here detects, embeds or identifies a person, and no field on this
contract could carry the result if it did.

Four things about camera feeds that produce wrong output rather than an error, and each one
is a field on this model rather than a comment somewhere:

**1. An availability flag is not a liveness signal, and it is often a string.** TfL's
``available`` is the string ``"true"`` or ``"false"``, so ``if ap["available"]:`` is true for
both, and Caltrans' ``inService`` is the same shape. Worse, both arrive inside an inventory a
CDN holds for hours: TfL's own ``modified`` stamps read 2026-08-19 on a payload fetched on
2026-08-24, five days behind, while the still the record points at was six minutes old.
:attr:`available` therefore carries the provider's assertion and nothing more. Liveness comes
from the picture's own ``Last-Modified``, which the proxy route reads per request and never
stores here.

**2. A camera does not move, so there is no observation time to hold.** Every other live
layer in this project carries a fix time because its subject moves and a stale fix is a wrong
position. A camera is furniture. :attr:`inventory_at` is when *we* read the list, which is a
statement about our own freshness and is deliberately not dressed up as an observation.

**3. Coordinates in a camera inventory are frequently rubbish, and the record still carries a
live stream.** Measured on 2026-08-24 against New York 511: four enabled cameras sat outside
any plausible New York box, three at exactly ``0.0, 0.0`` and one with the longitude sign
dropped, and all four carried a working HLS playlist. So a plausibility box per provider is a
requirement rather than a nicety, and it lives in the adapter where the box can be stated in
that authority's own terms.

**4. A camera inventory can ship credentials.** Nine New York records carried plaintext
basic-auth credentials to a directly addressable camera over plain HTTP, in the ``VideoUrl``
field. Those records are dropped and counted in the adapter and their values are never stored
or logged, which is why :attr:`video_url` is constrained to what a host allowlist has already
approved rather than to whatever the provider sent.

**Media addresses are the provider's own, and what happens to them differs by kind.** A
finite file (a JPEG still, TfL's 120KB MP4 clip) is fetched by our proxy and served from us,
which is the ADR 005 rule and it applies here unchanged. A genuinely live stream is not: see
``api/routes_cameras.py`` for why relaying one is a different thing from caching a file, and
for what the browser is allowed to open directly.
"""

from typing import Literal, Self

from pydantic import Field, model_validator

from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.contracts.geo import Point

VideoKind = Literal["mp4", "hls"]
"""How a camera's moving picture is delivered, when it has one.

``mp4`` is a finite file and behaves like any other media item here: it is proxied and cached.
``hls`` is a live playlist plus a rolling window of segments, which is not a file and cannot be
cached like one. The browser needs to know which before it decides what to open, and the
distinction is also what decides whether our proxy is involved at all.

Deliberately not a boolean. ``has_video`` would collapse two things that need opposite handling,
and the layer would then either relay a live stream through a laptop or hot-link a cacheable
file, depending on which way the boolean was read.
"""


class Camera(StrictModel):
    """One camera in an authority's published estate, at the moment we read the inventory.

    Frozen and strict like every other domain contract. The required fields are the ones
    without which the record is worthless: which authority published it, a stable identity
    inside that authority, a place, a name a person can read, and the licence that lets us
    show it at all.
    """

    kind: Literal["camera"] = "camera"

    provider: str = Field(
        min_length=1,
        max_length=40,
        description="Which authority's feed this came from, as the adapter names itself. "
        "Half of the merge key, and it is part of the identity rather than provenance: no "
        "two authorities publish the same camera, so there is no ADR 010 recency contest "
        "here and deliberately no ``providers`` tuple. Same reasoning as the transit "
        "contract's ``feed_id``.",
    )
    camera_id: str = Field(
        min_length=1,
        max_length=120,
        description="The authority's own identifier, unique within its feed. The other half "
        "of the merge key. Never a positional or generated value: a camera that changed key "
        "between two inventory reads would expire itself off the globe and reappear.",
    )

    name: str = Field(
        min_length=1,
        max_length=200,
        description="What the authority calls this camera, for the card and for search.",
    )
    point: Point = Field(
        description="Where the camera is, longitude first. Every provider here sends latitude "
        "first, as separate scalars or as strings, so each adapter flips at its boundary. "
        "``altitude_m`` is left unset unless the authority states one: inventing ground level "
        "would be a fabricated value.",
    )
    country: str = Field(
        pattern=r"^[A-Z]{2}$",
        description="ISO 3166-1 alpha-2, from the adapter rather than from the feed. No "
        "provider here states a country, and every one of them is a single-jurisdiction road "
        "authority, so the adapter knows it and the payload does not.",
    )

    operator: str = Field(
        min_length=1,
        max_length=120,
        description="The body that owns and publishes the camera, for the card and the "
        "mandatory credit. Not the same string as ``provider``, which is our short name for "
        "the feed.",
    )
    licence: str = Field(
        min_length=1,
        max_length=200,
        description="The licence or terms this record travels under. Required, not optional: "
        "this project drops an item whose licence cannot be determined, so a record that "
        "reached the contract has one and it has to reach the card rather than living only on "
        "the layer.",
    )

    still_url: str | None = Field(
        default=None,
        max_length=500,
        description="The provider's own address for a single JPEG or PNG frame, or ``None`` "
        "when the authority publishes no still. Never handed to a browser directly: the "
        "camera route proxies it, so the provider's cadence stays ours to manage and a "
        "viewer's browser does not tell a road authority which junction they looked at.",
    )
    video_url: str | None = Field(
        default=None,
        max_length=500,
        description="The provider's own address for a moving picture, or ``None``. Constrained "
        "by a per-provider host allowlist in the adapter before it ever reaches this field, "
        "because a New York inventory shipped nine addresses carrying plaintext credentials to "
        "a directly addressable camera and an unconstrained field would have stored them.",
    )
    video_kind: VideoKind | None = Field(
        default=None,
        description="``mp4``, ``hls``, or ``None`` when there is no moving picture. Set if and "
        "only if ``video_url`` is set; the model validator below enforces the pair, because a "
        "URL with no kind is a URL nothing knows how to open and a kind with no URL is a "
        "promise of video the card cannot keep.",
    )

    view: str | None = Field(
        default=None,
        max_length=80,
        description="Which way the camera points, in the authority's own words: TfL says "
        "``West``, New York says ``Northbound``. Free text rather than a bearing, because none "
        "of these providers reports degrees and converting a compass word into a number would "
        "invent a precision nobody published.",
    )
    roadway: str | None = Field(
        default=None,
        max_length=200,
        description="The road the camera watches, where the authority names it.",
    )

    available: bool = Field(
        description="The provider's own availability assertion, parsed rather than truth-"
        "tested. Not a liveness signal: see this module's docstring. An unavailable camera is "
        "carried rather than dropped, because 'the authority says this one is down' is "
        "information and silently omitting it makes the estate look smaller than it is.",
    )
    inventory_at: UtcDatetime = Field(
        description="When we read the inventory that listed this camera. Our own freshness, "
        "not the picture's: the inventory is CDN-cached for hours on two of the four providers "
        "and the ``modified`` stamps inside TfL's payload were five days behind the stills "
        "they described when measured on 2026-08-24.",
    )

    @model_validator(mode="after")
    def _video_url_and_kind_agree(self) -> Self:
        """A moving picture needs both an address and a way to open it, or neither.

        Enforced here rather than trusted to four adapters, because the two failure modes are
        silent in opposite directions. A ``video_url`` with no ``video_kind`` is an address the
        browser cannot decide what to do with, so it opens nothing and the camera reads as
        still-only. A ``video_kind`` with no URL is the card promising video and then having
        none, which reads as a broken layer rather than as a camera that never had a stream.
        """
        if (self.video_url is None) != (self.video_kind is None):
            msg = (
                "video_url and video_kind must be set together: "
                f"got url={self.video_url!r}, kind={self.video_kind!r}"
            )
            raise ValueError(msg)
        return self

    @property
    def key(self) -> str:
        """The merge key: provider and identity, joined.

        A plain property rather than a computed field, for the reason
        :class:`~tracker.contracts.base.StrictModel` gives: derived values stay off the wire so
        the model round-trips through ``validate_json`` without preprocessing.
        """
        return merge_key(self.provider, self.camera_id)


def merge_key(provider: str, camera_id: str) -> str:
    """The store key for a camera, from the two halves of its identity.

    A module-level function as well as a property because the adapters build the key before a
    ``Camera`` exists, when they are deciding whether they have already seen a record in this
    sweep. One implementation, so the store and the adapter cannot disagree about what a
    duplicate is.
    """
    return f"{provider}:{camera_id}"
