"""The social post contract.

One rule in this contract does real work and the rest is shape: a post has to say whether its
coordinate was reported or worked out, and the two cases have to be structurally different
rather than differently labelled. Most of this file is about that rule, because it is the one
that stops a guess about a city being served with the same weight as a geotag, and it is the
one a future adapter is most likely to get wrong by leaving a field unset.
"""

from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from tracker.contracts.geo import Point
from tracker.contracts.social import MediaLicence, PostMedia, SocialPost

WHEN = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)
LONDON = Point(lon=-0.1278, lat=51.5074)


def upstream(**overrides: Any) -> SocialPost:
    """A post whose coordinate the source supplied."""
    fields: dict[str, Any] = {
        "source": "commons",
        "post_id": "176884078",
        "url": "https://commons.wikimedia.org/wiki/File:Example.jpg",
        "posted_at": WHEN,
        "text": "St Paul's from the river",
        "point": LONDON,
        "location_basis": "upstream",
        "retrieved_at": WHEN,
    }
    return SocialPost(**(fields | overrides))


def derived(**overrides: Any) -> SocialPost:
    """A post whose coordinate we resolved from its words."""
    fields: dict[str, Any] = {
        "source": "mas.to",
        "post_id": "117145956891649200",
        "url": "https://mas.to/@someone/117145956891649200",
        "author_handle": "@someone",
        "posted_at": WHEN,
        "text": "walking in London today",
        "point": LONDON,
        "location_basis": "derived",
        "location_phrase": "in London",
        "place_name": "London",
        "retrieved_at": WHEN,
    }
    return SocialPost(**(fields | overrides))


class TestLocationBasis:
    """The split ADR 005 exists to enforce."""

    def test_a_derived_post_must_name_the_phrase_it_came_from(self) -> None:
        # Without the phrase the card cannot show the derivation, and a city-level guess then
        # renders exactly like a reported position. This is the failure the whole layer is
        # designed around, so it is a validation error rather than a convention.
        with pytest.raises(ValidationError, match="derived location must carry its evidence"):
            derived(location_phrase=None)

    def test_a_derived_post_must_name_the_place_it_matched(self) -> None:
        with pytest.raises(ValidationError, match="derived location must carry its evidence"):
            derived(place_name=None)

    def test_an_upstream_post_must_not_carry_a_phrase(self) -> None:
        # The other direction, and it is not symmetry for its own sake: an adapter that fills
        # a phrase in on an upstream record has confused a coordinate it was handed with one
        # it worked out, and nothing else in the system would ever notice.
        with pytest.raises(
            ValidationError, match="upstream location must carry no derivation evidence"
        ):
            upstream(location_phrase="in London")

    def test_an_upstream_post_must_not_carry_a_place_name(self) -> None:
        with pytest.raises(
            ValidationError, match="upstream location must carry no derivation evidence"
        ):
            upstream(place_name="London")

    def test_a_copied_provider_coordinate_is_derived_evidence_without_a_phrase(self) -> None:
        # The second kind of derivation, found on 2026-08-24: a coordinate the provider gave us
        # that several files in one response share to seven decimal places. There is no phrase,
        # because nothing was read from any words; the evidence is the sharing itself.
        post = derived(location_phrase=None, place_name=None, coordinate_shared_by=50)
        assert post.location_basis == "derived"
        assert post.is_observed_position is False

    def test_a_derived_post_with_no_evidence_at_all_is_refused(self) -> None:
        with pytest.raises(ValidationError, match="derived location must carry its evidence"):
            derived(location_phrase=None, place_name=None)

    def test_an_upstream_post_must_not_claim_a_shared_coordinate(self) -> None:
        # The two are contradictory by construction: a coordinate known to be copied is not a
        # coordinate the source gave us about its own subject.
        with pytest.raises(ValidationError, match="upstream location must carry no derivation"):
            upstream(coordinate_shared_by=50)

    def test_a_coordinate_shared_by_one_file_is_not_evidence_of_anything(self) -> None:
        # One file on a coordinate is the normal case and means nothing was copied, so the
        # field is absent rather than 1. A 1 here would read as a claim.
        with pytest.raises(ValidationError):
            derived(coordinate_shared_by=1)

    def test_both_valid_shapes_construct(self) -> None:
        assert upstream().location_phrase is None
        assert derived().location_phrase == "in London"

    def test_only_upstream_counts_as_an_observed_position(self) -> None:
        # The question every consumer actually asks. A property rather than a stored field, so
        # it cannot drift out of step with the basis it is derived from.
        assert upstream().is_observed_position is True
        assert derived().is_observed_position is False

    def test_there_is_no_third_basis(self) -> None:
        # "unknown" was considered and rejected: a post whose location cannot be established
        # is dropped by the adapter, not carried with a basis that means nothing on a card.
        with pytest.raises(ValidationError):
            upstream(location_basis="unknown")


class TestAuthorHandle:
    """Attribution needs the handle, and ADR 005 says it needs nothing else."""

    @pytest.mark.parametrize("handle", ["@someone", "@someone@mas.to", "@a.b_c@pixelfed.social"])
    def test_accepts_a_local_or_qualified_handle(self, handle: str) -> None:
        assert derived(author_handle=handle).author_handle == handle

    @pytest.mark.parametrize("handle", ["someone", "@", "@a@b@c", "@with space", ""])
    def test_rejects_anything_that_is_not_a_handle(self, handle: str) -> None:
        # A field being quietly used for something else is how a display name, or worse a real
        # name, ends up in the one author field this layer is allowed to store.
        with pytest.raises(ValidationError):
            derived(author_handle=handle)

    def test_absent_is_allowed_because_commons_has_uploaders_not_handles(self) -> None:
        assert upstream().author_handle is None


class TestMediaLicence:
    """Per item, never per source, and never absent."""

    def test_an_item_cannot_exist_without_a_licence_name(self) -> None:
        # The load-bearing decision in the module. ADR 005 says an item whose licence cannot
        # be determined is dropped rather than shown, and a required name is what makes
        # "shown without a licence" unrepresentable rather than merely discouraged.
        with pytest.raises(ValidationError):
            MediaLicence(  # type: ignore[call-arg]  # ty: ignore[missing-argument]
                url=None, author=None, attribution_required=False
            )
        with pytest.raises(ValidationError):
            MediaLicence(name="", attribution_required=False)

    def test_a_public_domain_item_may_have_no_licence_url(self) -> None:
        # Absence here is a fact about the licence rather than a missing value: there is no
        # deed to link to. Measured on Commons, where 'Public domain' files carry no
        # LicenseUrl at all.
        licence = MediaLicence(name="Public domain", attribution_required=False)
        assert licence.url is None
        assert licence.author is None

    def test_attribution_required_is_a_real_boolean_here(self) -> None:
        # Commons sends the strings 'true' and 'false' and both are truthy. The string stays
        # in the adapter; by the time it reaches the domain it is a bool or it is a bug.
        with pytest.raises(ValidationError):
            MediaLicence(
                name="CC BY 4.0",
                attribution_required="false",  # type: ignore[arg-type]  # ty: ignore[invalid-argument-type]
            )


class TestPostMedia:
    """Dimensions are optional because some media has none."""

    def test_audio_may_carry_no_dimensions(self) -> None:
        # Commons reports width 0 and height 0 for application/ogg. Zero is not a dimension,
        # so the adapter maps it to None and this is the shape that has to accept the result.
        item = PostMedia(
            url="https://upload.wikimedia.org/x.ogg",
            mime="application/ogg",
            licence=MediaLicence(name="CC BY-SA 4.0", attribution_required=True),
        )
        assert (item.width, item.height) == (None, None)

    def test_a_zero_dimension_is_refused_rather_than_stored(self) -> None:
        # If a future adapter forgets the mapping, this is where it fails, rather than the
        # layer quietly describing a real recording as nought by nought.
        with pytest.raises(ValidationError):
            PostMedia(
                url="https://upload.wikimedia.org/x.ogg",
                mime="application/ogg",
                width=0,
                licence=MediaLicence(name="CC BY-SA 4.0", attribution_required=True),
            )

    def test_media_is_dated_by_publication_and_says_so(self) -> None:
        # ADR 015 asks which timestamp was used to be recorded. Only publication is
        # implemented, because Commons' own DateTimeOriginal is free text: 'cir. 1948' is a
        # real value and parsing it would be inventing precision.
        item = PostMedia(
            url="https://upload.wikimedia.org/x.jpg",
            mime="image/jpeg",
            licence=MediaLicence(name="CC0", attribution_required=False),
        )
        assert item.dated_by == "published"


class TestPostShape:
    """The rest of the contract, briefly."""

    def test_a_post_has_no_motion(self) -> None:
        # A post is a fixed event. Nothing here carries a track, a speed or a heading, so
        # nothing downstream can dead-reckon one or draw a line between two of them.
        forbidden = {"track_deg", "speed_over_ground_mps", "course_over_ground_deg", "heading"}
        assert forbidden.isdisjoint(SocialPost.model_fields)

    def test_empty_text_is_a_value_rather_than_a_reason_to_drop(self) -> None:
        # A geotagged Commons file with no description is still a post about a place.
        assert upstream(text="").text == ""

    def test_a_naive_timestamp_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            upstream(posted_at=datetime(2026, 8, 23, 12, 0))  # noqa: DTZ001 - the point

    def test_retrieval_time_is_distinct_from_posting_time(self) -> None:
        later = datetime(2026, 8, 23, 13, 0, tzinfo=UTC)
        post = upstream(retrieved_at=later)
        assert post.posted_at == WHEN
        assert post.retrieved_at == later

    def test_unknown_fields_are_refused(self) -> None:
        # StrictModel forbids extras, so an upstream growing a field fails a test here rather
        # than being silently ignored.
        with pytest.raises(ValidationError):
            upstream(author_display_name="Someone Real")

    def test_a_post_is_frozen(self) -> None:
        post = upstream()
        with pytest.raises(ValidationError):
            post.text = "edited"  # type: ignore[misc]  # ty: ignore[invalid-assignment]
