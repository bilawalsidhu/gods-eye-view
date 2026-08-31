"""The Mastodon adapter, and mostly the one decision in it that matters.

A Mastodon status has no coordinate, so every position this adapter produces is one it worked
out from the words. That makes *which words it will match* the entire safety property of the
layer, and most of this file is about the words it must refuse.

The refusals are not hypothetical. Measured over 60 real posts, matching every capitalised
word would have offered 208 candidates to a 34,000-entry gazetteer, including ``Mission``
(a real city of 85,000), ``Blaine`` (70,000), ``Chad``, ``Alpha``, ``Bum``, ``Been``, ``Can``
and the sentence-initial ``The``. Those tests are the ones to read first, because a future
change that loosens the rule will pass everything else in this file.
"""

import json
from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest

from tests.conftest import fixture_bytes
from tracker.contracts.city import City
from tracker.contracts.geo import Point
from tracker.sources.base import RateLimitedError
from tracker.sources.mastodon import (
    InstanceRefusedError,
    MastodonClient,
    exact_city_resolver,
    instance_of,
    location_phrases,
    parse_timeline,
    plain_text,
)

WHEN = datetime(2026, 8, 23, 17, 0, tzinfo=UTC)
FIXTURE = "mastodon_masto_public_live.json"


def city(name: str, lon: float, lat: float, population: int, geonames_id: int) -> City:
    return City(
        geonames_id=geonames_id,
        name=name,
        ascii_name=name,
        point=Point(lon=lon, lat=lat),
        feature_code="PPL",
        country_code="XX",
        population=population,
        timezone="UTC",
        elevation_m=None,
        modification_date=date(2026, 1, 1),
    )


# A gazetteer small enough to reason about, holding the two real matches in the recorded
# timeline plus the two false friends the extraction rule has to refuse.
GAZETTEER = (
    city("Utrecht", 5.12, 52.09, 357_179, 1),
    city("Gaza", 34.47, 31.50, 410_000, 2),
    city("Mission", -98.32, 26.22, 85_000, 3),
    city("Blaine", -93.23, 45.16, 70_000, 4),
    city("London", -0.1278, 51.5074, 8_961_989, 5),
    city("London", -81.23, 42.98, 383_822, 6),
)


def search(phrase: str) -> tuple[City, ...]:
    """Stands in for the gazetteer's own ranked search, which matches partially on purpose."""
    folded = phrase.casefold()
    return tuple(place for place in GAZETTEER if folded in place.name.casefold())


RESOLVE = exact_city_resolver(search)


def status(**overrides: Any) -> dict[str, Any]:
    """One status in the shape a public timeline returns."""
    base: dict[str, Any] = {
        "id": "117145956891649200",
        "uri": "https://mas.to/users/someone/statuses/117145956891649200",
        "url": "https://mas.to/@someone/117145956891649200",
        "created_at": "2026-08-23T16:40:00.000Z",
        "content": "<p>Walking in London today</p>",
        "language": "en",
        "account": {"acct": "someone"},
        "media_attachments": [],
    }
    return base | overrides


def timeline(*statuses: dict[str, Any]) -> bytes:
    return json.dumps(list(statuses)).encode()


class TestWhatIsRefused:
    """The 208 candidates, and why none of them is offered to the gazetteer."""

    @pytest.mark.parametrize(
        "text",
        [
            "Mission accomplished",
            "Blaine said hello",
            "Chad and Alpha arrived",
            "The Position was Posted",
            "Science and Sports",
            "Been there. Can confirm.",
        ],
    )
    def test_a_bare_capitalised_word_is_not_a_location_claim(self, text: str) -> None:
        # This is the test that matters. Mission is a city of 85,000 in Texas, Blaine one of
        # 70,000 in Minnesota, and matching either here would put a pin on a globe because
        # somebody used an ordinary noun at the start of a sentence. A bare capitalised word
        # carries no claim about place, so it never reaches the gazetteer at all.
        assert location_phrases(text) == ()

    def test_a_headline_fragment_is_not_a_location_claim(self) -> None:
        # Multi-word capitalised phrases looked promising: 77 of them across 38 of 60 posts.
        # Then you read them. This is a real one, from a real post, behind a real "in".
        phrases = location_phrases("Woman Pleads Guilty in Child Neglect Case After Changing Pleas")
        assert all(RESOLVE(subject) is None for _, subject in phrases)

    def test_a_partial_name_match_is_refused_by_the_resolver(self) -> None:
        # The gazetteer's own search ranks partial matches, which is right for a search box and
        # wrong here: a user typing "lon" wants London offered, a post saying "Lon" does not.
        assert RESOLVE("Lon") is None
        assert RESOLVE("Utrec") is None

    def test_a_hashtag_shorter_than_three_characters_is_ignored(self) -> None:
        assert location_phrases("#uk and #a") == ()


class TestWhatIsMatched:
    """The two signals that are a deliberate statement about place."""

    @pytest.mark.parametrize(
        ("text", "phrase", "subject"),
        [
            ("Children in Gaza today", "in Gaza", "Gaza"),
            ("posted from London", "from London", "London"),
            ("somewhere near Utrecht", "near Utrecht", "Utrecht"),
        ],
    )
    def test_a_locative_preposition_carries_the_phrase(
        self, text: str, phrase: str, subject: str
    ) -> None:
        assert (phrase, subject) in location_phrases(text)

    def test_a_two_word_preposition_still_yields_a_lookable_subject(self) -> None:
        # The bug this pair exists to prevent. Deriving the subject by dropping the first word
        # leaves "in Utrecht" here, which matches no city, so every multi-word preposition in
        # the pattern silently found nothing. The phrase shown and the words looked up are two
        # different things and the regex reports both.
        found = location_phrases("arriving in Utrecht shortly")
        assert found == (("arriving in Utrecht", "Utrecht"),)
        assert RESOLVE(found[0][1]) is not None

    def test_a_hashtag_is_the_authors_own_label(self) -> None:
        found = location_phrases("Hanging out . . . #utrecht #streetphotography")
        assert ("#utrecht", "utrecht") in found

    def test_the_phrase_keeps_its_signal_so_the_card_can_show_the_derivation(self) -> None:
        # ADR 005 requires the matched phrase on the card. "in Gaza" and "#gaza" are different
        # kinds of claim, and a bare "Gaza" would hide which rule fired.
        assert location_phrases("in Gaza")[0][0] == "in Gaza"
        assert location_phrases("#gaza")[0][0] == "#gaza"

    def test_the_same_claim_twice_is_one_phrase(self) -> None:
        assert location_phrases("#utrecht again #utrecht") == (("#utrecht", "utrecht"),)

    def test_a_mention_is_not_mistaken_for_a_place(self) -> None:
        # A handle can contain anything, including a city name.
        assert location_phrases("hello @london@mas.to") == ()

    def test_a_url_is_not_mined_for_place_names(self) -> None:
        assert location_phrases("see https://example.invalid/in/London") == ()


class TestPlainText:
    """Mastodon serves HTML."""

    def test_tags_are_removed_and_entities_then_decoded(self) -> None:
        assert plain_text("<p>a &lt;b&gt; c</p>") == "a <b> c"

    def test_a_hashtag_anchor_becomes_its_word(self) -> None:
        html = '<p>hi <a href="https://mas.to/tags/utrecht">#<span>utrecht</span></a></p>'
        assert plain_text(html) == "hi # utrecht"

    def test_absent_content_is_empty(self) -> None:
        assert plain_text(None) == ""


class TestRecordedTimeline:
    """Against the bytes a real instance sent."""

    def test_two_of_forty_recorded_posts_become_posts(self) -> None:
        # Thin, and ADR 005 predicted it: "Mastodon coverage will be thin. Public timelines are
        # small, geographic mentions are rare, and the city gazetteer will miss most posts.
        # Thin is the correct outcome of not inventing precision." The number is the design
        # working. A change that makes this figure much larger has loosened the rule.
        parsed = parse_timeline(
            fixture_bytes(FIXTURE), instance="mas.to", resolve=RESOLVE, retrieved_at=WHEN
        )
        assert len(parsed.records) == 2
        assert {post.place_name for post in parsed.records} == {"Gaza", "Utrecht"}

    def test_every_mastodon_post_is_derived_and_says_so(self) -> None:
        parsed = parse_timeline(
            fixture_bytes(FIXTURE), instance="mas.to", resolve=RESOLVE, retrieved_at=WHEN
        )
        assert all(post.location_basis == "derived" for post in parsed.records)
        assert not any(post.is_observed_position for post in parsed.records)
        assert all(post.location_phrase for post in parsed.records)

    def test_the_drops_say_which_half_was_lost_and_why(self) -> None:
        parsed = parse_timeline(
            fixture_bytes(FIXTURE), instance="mas.to", resolve=RESOLVE, retrieved_at=WHEN
        )
        assert parsed.drops["no locative phrase or hashtag in the text"] == 36
        assert parsed.drops["phrases found but none is a city in the gazetteer"] == 2

    def test_the_source_is_the_instance_rather_than_the_word_mastodon(self) -> None:
        # An instance refusing us is a different fact from the layer being down, so the record
        # has to name which one it came from.
        parsed = parse_timeline(
            fixture_bytes(FIXTURE), instance="mas.to", resolve=RESOLVE, retrieved_at=WHEN
        )
        assert {post.source for post in parsed.records} == {"mas.to"}


class TestMediaIsAlwaysDropped:
    """The most surprising rule in the module, asserted so it reads as deliberate."""

    def test_an_attachment_is_dropped_because_it_carries_no_licence(self) -> None:
        # A Mastodon status has no rights field anywhere: not on the attachment, not on the
        # account. ADR 005 says an item whose licence cannot be determined is dropped and
        # counted rather than shown, so the Mastodon half of this layer is text.
        parsed = parse_timeline(
            timeline(
                status(
                    content="<p>in Utrecht</p>",
                    media_attachments=[{"type": "image"}, {"type": "video"}],
                )
            ),
            instance="mas.to",
            resolve=RESOLVE,
            retrieved_at=WHEN,
        )
        assert parsed.records[0].media == ()
        assert parsed.drops["media items dropped: no determinable licence"] == 2

    def test_the_post_itself_still_survives(self) -> None:
        # Dropping the picture is not dropping the post: the words carried the location.
        parsed = parse_timeline(
            timeline(status(content="<p>in Utrecht</p>", media_attachments=[{"type": "image"}])),
            instance="mas.to",
            resolve=RESOLVE,
            retrieved_at=WHEN,
        )
        assert len(parsed.records) == 1


class TestResolver:
    """Exact names only, and the larger city wins a tie."""

    def test_two_cities_of_the_same_name_resolve_to_the_more_populous(self) -> None:
        # London, Ontario is real and has 383,822 people. A post that names nothing else is
        # likelier to mean the one with nine million, and guessing is unavoidable here, so the
        # guess is stated rather than arbitrary.
        resolved = RESOLVE("London")
        assert resolved is not None
        assert resolved.population == 8_961_989

    def test_an_accent_or_a_case_difference_still_matches(self) -> None:
        assert (
            exact_city_resolver(lambda _: (city("Zürich", 8.55, 47.37, 400_000, 7),))("zurich")
            is not None
        )

    def test_an_empty_phrase_resolves_to_nothing(self) -> None:
        assert RESOLVE("") is None


class TestStatusDrops:
    """Statuses that cannot become posts for reasons other than location."""

    def test_a_status_with_no_timestamp_is_dropped(self) -> None:
        parsed = parse_timeline(
            timeline(status(created_at=None, content="<p>in Utrecht</p>")),
            instance="mas.to",
            resolve=RESOLVE,
            retrieved_at=WHEN,
        )
        assert parsed.drops["status carried no id or no timestamp"] == 1

    def test_a_status_with_no_link_is_dropped_because_it_cannot_be_attributed(self) -> None:
        parsed = parse_timeline(
            timeline(status(url=None, uri=None, content="<p>in Utrecht</p>")),
            instance="mas.to",
            resolve=RESOLVE,
            retrieved_at=WHEN,
        )
        assert parsed.drops["status carried no link, so it cannot be attributed"] == 1

    def test_the_handle_is_qualified_when_the_instance_qualifies_it(self) -> None:
        parsed = parse_timeline(
            timeline(status(content="<p>in Utrecht</p>", account={"acct": "a@pixelfed.social"})),
            instance="mas.to",
            resolve=RESOLVE,
            retrieved_at=WHEN,
        )
        assert parsed.records[0].author_handle == "@a@pixelfed.social"


class TestInstanceRefusal:
    """One instance refusing anonymous clients is not the feed failing."""

    @pytest.mark.parametrize("code", [401, 403, 422])
    async def test_a_refusal_drops_that_instance_and_keeps_the_rest(self, code: int) -> None:
        # 422 is the one nobody would guess, and it is what mastodon.social actually answers:
        # {"error":"This method requires an authenticated user"}. Re-verified 2026-08-23.
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "refuses.example":
                return httpx.Response(
                    code, json={"error": "This method requires an authenticated user"}
                )
            return httpx.Response(200, content=timeline(status(content="<p>in Utrecht</p>")))

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            mastodon = MastodonClient(
                client, resolve=RESOLVE, instances=("refuses.example", "serves.example")
            )
            parsed = await mastodon.recent_posts()

        assert len(parsed.records) == 1
        assert parsed.records[0].source == "serves.example"
        assert "refuses.example" in mastodon.refused
        assert str(code) in mastodon.refused["refuses.example"]

    async def test_an_instance_that_starts_serving_again_stops_being_reported(self) -> None:
        answers = iter([httpx.Response(422, json={}), httpx.Response(200, content=timeline())])

        def handler(_: httpx.Request) -> httpx.Response:
            return next(answers)

        moments = iter(
            [
                datetime(2026, 8, 23, 17, 0, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 1, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 1, tzinfo=UTC),
            ]
        )
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            mastodon = MastodonClient(
                client,
                resolve=RESOLVE,
                instances=("flaky.example",),
                clock=lambda: next(moments),
            )
            await mastodon.recent_posts()
            assert "flaky.example" in mastodon.refused
            await mastodon.recent_posts()
        # A stale refusal on the rail is a layer reporting a fault it has recovered from.
        assert mastodon.refused == {}

    def test_the_error_names_the_instance_rather_than_the_layer(self) -> None:
        error = InstanceRefusedError("mastodon.social", 422)
        assert error.source == "mastodon.social"
        assert "422" in error.detail


class TestCadence:
    """The floor comes from the provider's own cache window."""

    async def test_a_second_call_inside_the_window_is_refused_before_it_is_sent(self) -> None:
        sent: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            return httpx.Response(200, content=timeline())

        moments = iter(
            [
                datetime(2026, 8, 23, 17, 0, 0, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 0, 0, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 0, 1, tzinfo=UTC),
            ]
        )
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            mastodon = MastodonClient(
                client, resolve=RESOLVE, instances=("one.example",), clock=lambda: next(moments)
            )
            await mastodon.recent_posts()
            with pytest.raises(RateLimitedError):
                await mastodon._fetch("one.example")
        assert len(sent) == 1

    async def test_the_floor_is_per_instance(self) -> None:
        # Two instances are two providers. One being asked recently says nothing about the other.
        sent: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(request.url.host)
            return httpx.Response(200, content=timeline())

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            mastodon = MastodonClient(
                client,
                resolve=RESOLVE,
                instances=("one.example", "two.example"),
                clock=lambda: WHEN,
            )
            await mastodon.recent_posts()
        assert sent == ["one.example", "two.example"]


def test_instance_of_reads_the_host() -> None:
    assert instance_of("https://mas.to/@a/1") == "mas.to"
    assert instance_of("not a url") == ""


class TestFeedIdentity:
    """What the poller and the health output read off this client."""

    async def test_it_names_itself_and_its_floor(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        ) as client:
            mastodon = MastodonClient(client, resolve=RESOLVE)
        assert mastodon.name == "mastodon"
        assert mastodon.min_interval_seconds > 0

    async def test_a_throttling_status_carries_the_providers_own_figure(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(429, headers={"retry-after": "31"}, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            mastodon = MastodonClient(client, resolve=RESOLVE, instances=("one.example",))
            with pytest.raises(RateLimitedError) as caught:
                await mastodon._fetch("one.example")
        assert caught.value.retry_after_seconds == pytest.approx(31.0)

    async def test_drops_accumulate_on_the_client_for_health_reporting(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=timeline(status(content="<p>nothing here</p>")))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            mastodon = MastodonClient(client, resolve=RESOLVE, instances=("one.example",))
            await mastodon.recent_posts()
        assert mastodon.drops["no locative phrase or hashtag in the text"] == 1

    async def test_a_status_with_no_account_has_no_handle(self) -> None:
        for account in (None, {"acct": ""}):
            parsed = parse_timeline(
                timeline(status(content="<p>in Utrecht</p>", account=account)),
                instance="mas.to",
                resolve=RESOLVE,
                retrieved_at=WHEN,
            )
            assert parsed.records[0].author_handle is None


class TestProviderBudget:
    """The rate-limit headers are read rather than assumed."""

    @pytest.mark.parametrize("remaining", ["3", "not a number", None])
    async def test_the_call_succeeds_whatever_the_budget_header_says(
        self, remaining: str | None
    ) -> None:
        # Logged rather than acted on: the 15-second floor already keeps us two orders of
        # magnitude inside the stated 300 per five minutes, so a low figure here means
        # something else on this address is spending the budget. Worth a line, not a refusal.
        headers = {} if remaining is None else {"x-ratelimit-remaining": remaining}

        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=timeline(), headers=headers)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            mastodon = MastodonClient(client, resolve=RESOLVE, instances=("one.example",))
            parsed = await mastodon.recent_posts()
        assert parsed.records == ()
