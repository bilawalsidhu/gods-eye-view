"""The social post layer's domain contract.

Read ADR 005 before changing anything here. The short version, and the reason this module
looks the way it does: **the pin a post draws is about its subject, never its author.** No
source in this layer reports where the person who posted is, and two of them do not report a
coordinate at all, so the contract's job is to make it impossible to lose track of which kind
of claim a given post is making.

**:attr:`SocialPost.location_basis` is required and it is the whole design.** ``upstream``
means the source handed us the coordinate: a Commons file is geotagged to the thing it is a
picture of. ``derived`` means we resolved it from the words, which for Mastodon is the only
option available, because a Mastodon status object carries no positional field whatsoever.
Verified again on 2026-08-23 against a live ``mas.to`` public timeline: not on the status, not
on its account, not in the EXIF-ish ``meta`` block of its media attachments. Any position on a
Mastodon post is one we invented from its text, and a contract that let the two look alike
would be presenting a guess about a city with the same weight as a geotag.

So the two bases carry different fields, enforced by
:meth:`SocialPost._check_basis_matches_evidence` rather than by convention. A ``derived`` post
must carry its evidence and an ``upstream`` post must carry none, because there is nothing to
describe when the source simply gave us the coordinate.

**There are two ways a position can be derived, and the second one was a surprise.** The first
is the one ADR 005 describes: resolved from a post's words, so it carries the phrase and the
place it matched. The second is a coordinate the *provider* supplied that turns out to be a
copied placeholder rather than an observation, and it carries
:attr:`SocialPost.coordinate_shared_by` instead. Measured on 2026-08-24: a Commons geosearch of
50 files within 10km of Charing Cross returned **all fifty on one coordinate**, to seven decimal
places, and the files are bulk Unsplash imports called things like "Rustic stovetop" and
"Binoculars". Seven decimal places is centimetres, and fifty independent photographs cannot
agree to a centimetre, so that coordinate was copied from a city record and is not where anything
was photographed. Left as ``upstream`` it would have put fifty pins on Charing Cross, each
asserting an observed position, through the very field designed to stop that.

**A post is a fixed event, not a mover.** One timestamp, no track, no speed, no dead
reckoning. Two posts joined to the same profile are two dated points, and the line between
them is not something any source reported, so nothing here offers one to draw.

**Every media item carries its own licence or it does not exist.** Licences in this layer are
per item and not per source: one Commons file is CC BY-SA 4.0 and the next is public domain.
:class:`MediaLicence` therefore has no optional name, which makes "shown without a licence"
unrepresentable rather than merely discouraged. An item whose licence cannot be determined is
dropped by the adapter and counted, which is where that rule has to live because the adapter
is the only thing that has seen the payload.

That has one consequence worth stating out loud, because it looks like a bug from outside: a
**Mastodon attachment is always dropped**. A Mastodon status carries no rights field of any
kind, on the attachment or on the account, so its licence cannot be determined and the rule
above applies. The Mastodon half of this layer is text.
"""

import re
from typing import Literal, Self

from pydantic import Field, model_validator

from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.contracts.geo import Point

LocationBasis = Literal["upstream", "derived"]
"""Where a post's coordinate came from.

``upstream``: the source supplied it, about the post's subject. ``derived``: we resolved it
from the post's words against the city gazetteer, at city precision and no finer.

Two values and no third. "unknown" was considered and rejected: a post whose location cannot
be established is not a post this layer can draw, so it is dropped at the adapter rather than
carried with a basis that means nothing on a card.
"""

MEDIA_DATED_BY = Literal["published"]
"""How a media item's date was established.

One value today, and it is a placeholder with a purpose. ADR 015 requires a photo to be dated
to its EXIF capture time where present and its publication date otherwise, with which one was
used recorded. Only publication is implemented, because Commons' own ``DateTimeOriginal`` is
free text rather than a date: ``cir. 1948`` is a real value from a real file, measured on
2026-08-23, and parsing it into anything would be inventing precision. The literal exists so
that adding ``captured`` later is a contract change a reader can see rather than a silent
reinterpretation of every date already stored.
"""


class MediaLicence(StrictModel):
    """The rights on one media item, travelling with the item into the domain.

    Nothing here is optional except the parts that genuinely vary between licences. ``name``
    is required, and that is the load-bearing decision in this module: it makes an unlicensed
    item impossible to construct, so "we showed a photograph and could not say whose it was"
    cannot happen by omission.
    """

    name: str = Field(
        min_length=1,
        description=(
            "The licence as the provider names it, verbatim: 'CC BY-SA 4.0', 'Public domain'. "
            "Never normalised into a scheme of our own, because a card showing a licence has "
            "to show the one the item actually carries."
        ),
    )
    url: str | None = Field(
        default=None,
        description=(
            "Canonical licence text. Absent on public-domain items, which have no deed to "
            "link to, so absence here is not a missing value."
        ),
    )
    author: str | None = Field(
        default=None,
        description=(
            "Who to credit, plain text. None when the provider says the author is unknown, "
            "which Commons does often and explicitly. Arrives as HTML from Commons "
            "('Unknown author<span style=\"display: none;\">Unknown author</span>' is a real "
            "value) and is stripped in the adapter, because a card is not a browser."
        ),
    )
    attribution_required: bool = Field(
        description=(
            "Whether the licence obliges us to name the author wherever the item is shown. "
            "Commons states this per file in 'AttributionRequired' and the two values seen "
            "are the strings 'true' and 'false', so the adapter compares strings rather than "
            "trusting truthiness, the same trap as TfL's 'available' flag."
        ),
    )


class PostMedia(StrictModel):
    """One image, video or audio item attached to a post.

    ``url`` is the provider's own. Nothing in this project hands it to a browser: media is
    proxied and cached server-side, per ADR 005, so this is the address our proxy fetches
    from rather than the address a page loads.
    """

    url: str = Field(min_length=1, description="Provider URL for the full item, for our proxy.")
    preview_url: str | None = Field(
        default=None,
        description=(
            "A smaller rendition where the provider offers one. Its stated dimensions are "
            "not trustworthy: Commons reports the width that was asked for rather than the "
            "width of the bytes it served, so anything measuring this image reads the "
            "decoded bytes instead."
        ),
    )
    mime: str = Field(
        min_length=1,
        description=(
            "Media type as the provider reports it. Carried rather than filtered on, because "
            "a geosearch of the Commons file namespace returns audio as readily as "
            "photographs: two .ogg interviews came back in the first three results of a "
            "London query on 2026-08-23."
        ),
    )
    width: int | None = Field(default=None, gt=0, description="Pixels, when the provider says.")
    height: int | None = Field(default=None, gt=0, description="Pixels, when the provider says.")
    licence: MediaLicence
    dated_by: MEDIA_DATED_BY = Field(
        default="published",
        description="Which timestamp the item's date came from. See :data:`MEDIA_DATED_BY`.",
    )


_HANDLE = re.compile(r"^@[^@\s]+(?:@[^@\s]+)?$")
"""A Mastodon handle, local (``@user``) or fully qualified (``@user@instance``)."""


class SocialPost(StrictModel):
    """One post, with a position that states where it came from.

    The identity is ``(source, post_id)``. Neither alone is unique: two instances mint their
    own ids, and one instance reuses none.
    """

    kind: Literal["social_post"] = "social_post"

    source: str = Field(
        min_length=1,
        description=(
            "Which upstream this came from, as that upstream is named in "
            "docs/data-sources.md: 'commons', or the Mastodon instance host such as 'mas.to'. "
            "The instance rather than 'mastodon', because instances are configuration and one "
            "refusing us is a different fact from the layer being down."
        ),
    )
    post_id: str = Field(
        min_length=1,
        description="The provider's own id, verbatim. Unique within `source` and not beyond it.",
    )
    url: str = Field(
        min_length=1,
        description=(
            "Link to the original, which attribution needs and which is the only way a viewer "
            "can check what we made of it."
        ),
    )
    author_handle: str | None = Field(
        default=None,
        description=(
            "The author's handle, and per ADR 005 the only author data stored, because "
            "attribution requires it and nothing else does. None on Commons, where the "
            "uploader is a wiki username rather than a handle and is carried on the item's "
            "licence as its author instead."
        ),
    )
    posted_at: UtcDatetime = Field(
        description=(
            "When the post was published. Never when we fetched it, and never a capture date: "
            "for a Commons file this is the upload time, which is the moment the thing became "
            "a post."
        ),
    )
    text: str = Field(
        description=(
            "The post's words, HTML stripped. May be empty: a geotagged Commons file with no "
            "description is still a post about a place, and an empty string is the true value "
            "rather than a reason to drop it."
        ),
    )
    point: Point = Field(
        description=(
            "Where the post's subject is. Required, because a post whose location cannot be "
            "established is dropped by the adapter rather than carried without one."
        ),
    )
    location_basis: LocationBasis
    location_phrase: str | None = Field(
        default=None,
        min_length=1,
        description=(
            "The words the position was resolved from, shown on the card as ADR 005 requires "
            "so that a reader can see the derivation and judge it. Required when "
            "`location_basis` is 'derived' and forbidden when it is 'upstream'."
        ),
    )
    place_name: str | None = Field(
        default=None,
        min_length=1,
        description=(
            "The gazetteer place the phrase matched, so the card can say 'mentioned London' "
            "rather than showing bare coordinates. Same rule as `location_phrase`."
        ),
    )
    coordinate_shared_by: int | None = Field(
        default=None,
        gt=1,
        description=(
            "How many files in the same response carried this exact coordinate, when more than "
            "one did. Set only on a `derived` post, and it is the evidence for that "
            "classification in place of a matched phrase: a coordinate several files share was "
            "copied rather than observed. Absent on a post whose coordinate is its own."
        ),
    )
    media: tuple[PostMedia, ...] = Field(
        default=(),
        description=(
            "Attached media that carried a determinable licence. Anything else was dropped "
            "and counted by the adapter, which is why this is never a tuple of items with "
            "unknown rights."
        ),
    )
    retrieved_at: UtcDatetime = Field(
        description="When we fetched it, for staleness. Distinct from `posted_at` on purpose."
    )

    @model_validator(mode="after")
    def _check_basis_matches_evidence(self) -> Self:
        """Make the two bases structurally different, not merely labelled differently.

        This is the one rule in the module that is worth a validator rather than a docstring.
        A ``derived`` post without its phrase is a guess wearing a geotag's clothes, and an
        ``upstream`` post carrying a phrase is an adapter that has confused the coordinate it
        was given with one it worked out. Both are the failure ADR 005 exists to prevent, and
        neither would show up in any other test.
        """
        derived = self.location_basis == "derived"
        from_text = self.location_phrase is not None and self.place_name is not None
        from_sharing = self.coordinate_shared_by is not None
        if derived and not (from_text or from_sharing):
            msg = (
                "a derived location must carry its evidence: either the phrase it came from "
                "and the place it matched, or the number of files sharing its coordinate. "
                "Without one the card cannot show the derivation ADR 005 requires"
            )
            raise ValueError(msg)
        if not derived and (
            self.location_phrase is not None or self.place_name is not None or from_sharing
        ):
            msg = (
                "an upstream location must carry no derivation evidence: the source gave us "
                "the coordinate about its own subject, so there is nothing to describe"
            )
            raise ValueError(msg)
        return self

    @model_validator(mode="after")
    def _check_handle_shape(self) -> Self:
        """A handle that is not a handle is a field being used for something else."""
        if self.author_handle is not None and not _HANDLE.match(self.author_handle):
            msg = (
                f"author_handle must look like @user or @user@instance, got {self.author_handle!r}"
            )
            raise ValueError(msg)
        return self

    @property
    def is_observed_position(self) -> bool:
        """Whether the coordinate was reported rather than worked out.

        A property rather than a stored field, so it cannot disagree with
        :attr:`location_basis`. Exists because "is this a real coordinate" is the question
        every consumer of this contract actually wants to ask, and a consumer comparing
        against the string literal itself is one typo away from treating a guess as a fix.
        """
        return self.location_basis == "upstream"
