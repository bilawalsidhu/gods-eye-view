"""The Commons geosearch adapter.

Two kinds of test here. The first runs the parser over a recorded response and asserts what
came out, which is the only way to know the mapping matches what the API actually sends. The
second builds one page at a time to reach the cases a real response does not contain: a file
with no licence, a coordinate on another planet, an error inside a 200.

Every trap asserted below was measured against the live API on 2026-08-23, and the reason each
one matters is in the module docstring of the adapter rather than repeated here.
"""

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from tests.conftest import fixture_bytes, fixture_json
from tracker.contracts.base import ContractViolationError
from tracker.contracts.geo import Point
from tracker.sources.base import RateLimitedError
from tracker.sources.commons import (
    EXTMETADATA_FIELDS,
    PREVIEW_WIDTH,
    RADIUS_MAX_M,
    RADIUS_MIN_M,
    RESULT_LIMIT,
    RESULT_LIMIT_MAX,
    SHARED_COORDINATE_MIN,
    CommonsClient,
    CommonsLaggingError,
    _rendition,
    mark_shared_coordinates,
    parse_posts,
    strip_markup,
)

FIXTURE = "commons_geosearch_generator_live.json"
FILTERED_FIXTURE = "commons_geosearch_filtered_live.json"
"""Recorded 2026-08-24 under the parameters this adapter now sends: no ``iiurlwidth``, and
``iiextmetadatafilter`` set to the six keys it reads. ``FIXTURE`` above predates both."""
WHEN = datetime(2026, 8, 23, 17, 0, tzinfo=UTC)


def page(**overrides: Any) -> dict[str, Any]:
    """One page in the shape ``generator=geosearch`` returns, with the parts under test."""
    base: dict[str, Any] = {
        "pageid": 1,
        "ns": 6,
        "title": "File:Example.jpg",
        "imagerepository": "local",
        "imageinfo": [
            {
                "timestamp": "2019-06-02T23:28:55Z",
                "user": "Testuploader1",
                "url": "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg",
                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Example.jpg",
                "mime": "image/jpeg",
                "width": 3458,
                "height": 2113,
                "extmetadata": {
                    "LicenseShortName": {"value": "CC BY-SA 4.0"},
                    "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"},
                    "Artist": {"value": "Synthetic Author"},
                    "AttributionRequired": {"value": "true"},
                    "ImageDescription": {"value": "A description"},
                },
            }
        ],
        "coordinates": [{"lat": 51.5074, "lon": -0.1278, "primary": True, "globe": "earth"}],
    }
    return base | overrides


def envelope(*pages: dict[str, Any], **extra: Any) -> bytes:
    """The response body around a set of pages."""
    return json.dumps({"batchcomplete": True, "query": {"pages": list(pages)}} | extra).encode()


class TestRecordedResponse:
    """Against the bytes the API actually sent."""

    def test_every_recorded_page_maps(self) -> None:
        parsed = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN)
        recorded = len(fixture_json(FIXTURE)["query"]["pages"])
        assert len(parsed.records) == recorded
        assert parsed.dropped == 0

    def test_a_commons_post_is_an_upstream_position(self) -> None:
        # The whole reason Commons is allowed on this layer: the coordinate is the provider's,
        # about the subject of the photograph, so nothing is derived and no phrase is invented.
        post = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN).records[0]
        assert post.location_basis == "upstream"
        assert post.is_observed_position is True
        assert post.location_phrase is None
        assert post.place_name is None

    def test_the_post_is_dated_to_the_upload_and_not_to_the_fetch(self) -> None:
        post = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN).records[0]
        assert post.posted_at < post.retrieved_at
        assert post.retrieved_at == WHEN

    def test_audio_arrives_with_no_dimensions_rather_than_nought_by_nought(self) -> None:
        # Measured: application/ogg items come back with width 0 and height 0, three of fifty
        # in a London query. A contract field with gt=0 and no mapping drops every one of them,
        # which is a geosearch returning fifty records and drawing forty-seven in silence.
        parsed = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN)
        audio = [p for p in parsed.records if p.media[0].mime == "application/ogg"]
        assert audio, "the fixture is meant to carry the zero-dimension case"
        assert all(item.media[0].width is None for item in audio)
        assert all(item.media[0].height is None for item in audio)

    def test_every_record_carries_its_own_licence(self) -> None:
        # Per item, not per source. This is what makes the layer's licence rule enforceable.
        parsed = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN)
        assert all(post.media[0].licence.name for post in parsed.records)

    def test_the_author_is_not_html(self) -> None:
        # The hidden-span duplicate is in the fixture on purpose. A card is not a browser.
        parsed = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN)
        authors = [post.media[0].licence.author for post in parsed.records]
        assert all(author is None or "<" not in author for author in authors)
        assert all(author is None or "display" not in author for author in authors)


class TestStripMarkup:
    """The metadata values Commons sends as HTML."""

    def test_a_hidden_span_duplicate_is_not_rendered_twice(self) -> None:
        # The real Artist value from a real file. A browser shows the name once; a naive tag
        # stripper shows it twice, which was the first version of this function.
        raw = 'Unknown author<span style="display: none;">Unknown author</span>'
        assert strip_markup(raw) == "Unknown author"

    def test_an_escaped_tag_the_author_meant_to_be_visible_survives(self) -> None:
        # Entities are decoded after tags are stripped, not before. The other order deletes
        # text the author escaped on purpose, which the first version of this function did.
        assert strip_markup("a &lt;b&gt; b <i>c</i>") == "a <b> b c"

    def test_an_anchor_becomes_its_text(self) -> None:
        raw = '<a rel="nofollow" href="https://example.invalid/x">https://example.invalid/x</a>'
        assert strip_markup(raw) == "https://example.invalid/x"

    def test_absent_is_empty_rather_than_none(self) -> None:
        assert strip_markup(None) == ""


class TestDropRules:
    """What does not become a post, and the reason each one is counted."""

    def test_missing_true_is_not_a_drop_when_the_licence_is_there(self) -> None:
        # The trap AGENTS.md records and this reproduces. A Commons file reached through a
        # local wiki answers missing true, imagerepository shared, and a complete imageinfo
        # block with its licence. Dropping on `missing` throws away a fully licensed file and
        # reports it as unlicensable. The drop condition is the absence of imageinfo.
        parsed = parse_posts(
            envelope(page(missing=True, imagerepository="shared")), retrieved_at=WHEN
        )
        assert len(parsed.records) == 1
        assert parsed.dropped == 0

    def test_a_page_with_no_imageinfo_is_dropped_and_counted(self) -> None:
        parsed = parse_posts(envelope(page(imageinfo=None)), retrieved_at=WHEN)
        assert parsed.records == ()
        assert parsed.drops["no imageinfo, so no licence and no media URL"] == 1

    def test_an_item_whose_licence_cannot_be_determined_is_dropped(self) -> None:
        # ADR 005: dropped and counted, never shown. The contract makes it unrepresentable, so
        # this is where the rule is actually enforced.
        info = page()["imageinfo"][0] | {"extmetadata": {"Artist": {"value": "Someone"}}}
        parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
        assert parsed.records == ()
        assert parsed.drops["licence could not be determined"] == 1

    def test_usage_terms_stands_in_when_the_short_name_is_absent(self) -> None:
        # Not every file carries LicenseShortName. UsageTerms is the fuller sentence and is
        # better than dropping a file we can in fact licence.
        info = page()["imageinfo"][0] | {
            "extmetadata": {"UsageTerms": {"value": "Creative Commons Attribution 4.0"}}
        }
        parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
        assert parsed.records[0].media[0].licence.name == "Creative Commons Attribution 4.0"

    def test_a_coordinate_on_another_planet_is_dropped(self) -> None:
        # MediaWiki stores coordinates on the Moon and Mars. Reading one as a latitude and a
        # longitude puts a lunar crater on the Earth, and nothing else would notice.
        moon = page(coordinates=[{"lat": 51.5, "lon": -0.12, "primary": True, "globe": "moon"}])
        parsed = parse_posts(envelope(moon), retrieved_at=WHEN)
        assert parsed.records == ()
        assert parsed.drops["no coordinate on this planet"] == 1

    def test_the_earth_coordinate_is_picked_by_globe_not_by_position(self) -> None:
        # A page may carry more than one coordinate, and the first is not guaranteed to be the
        # one on this planet.
        both = page(
            coordinates=[
                {"lat": 10.0, "lon": 20.0, "primary": True, "globe": "mars"},
                {"lat": 51.5074, "lon": -0.1278, "primary": False, "globe": "earth"},
            ]
        )
        post = parse_posts(envelope(both), retrieved_at=WHEN).records[0]
        assert post.point == Point(lon=-0.1278, lat=51.5074)

    def test_a_page_with_no_coordinate_at_all_is_dropped(self) -> None:
        parsed = parse_posts(envelope(page(coordinates=None)), retrieved_at=WHEN)
        assert parsed.drops["no coordinate on this planet"] == 1

    def test_attribution_required_is_read_as_a_string(self) -> None:
        # 'false' is truthy. This is the TfL `available` trap in a different payload, and the
        # consequence of getting it wrong is crediting nobody where a licence demands it, or
        # crediting where it does not.
        for sent, expected in (("true", True), ("false", False), ("", False)):
            info = page()["imageinfo"][0]
            info["extmetadata"] = info["extmetadata"] | {"AttributionRequired": {"value": sent}}
            parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
            assert parsed.records[0].media[0].licence.attribution_required is expected


class TestErrorsInsideATwoHundred:
    """The action API puts its failures in the body."""

    def test_a_parameter_error_is_a_contract_violation(self) -> None:
        body = json.dumps(
            {
                "error": {
                    "code": "outofrange",
                    "info": 'The value "50000" must be between 10 and 10,000.',
                }
            }
        ).encode()
        with pytest.raises(ContractViolationError, match="outofrange"):
            parse_posts(body, retrieved_at=WHEN)

    def test_a_lag_refusal_is_a_backoff_rather_than_a_violation(self) -> None:
        # The two error codes need opposite handling: one is our bug and no amount of waiting
        # fixes it, the other is the databases being behind and clears in seconds.
        body = json.dumps(
            {
                "error": {
                    "code": "maxlag",
                    "info": "Waiting for 10.64.32.58: 0.7 seconds lagged.",
                    "lag": 0.7,
                }
            }
        ).encode()
        with pytest.raises(CommonsLaggingError) as caught:
            parse_posts(body, retrieved_at=WHEN)
        assert caught.value.lag_seconds == pytest.approx(0.7)
        assert caught.value.retry_after_seconds > 0

    def test_a_body_with_neither_an_error_nor_a_query_is_a_violation(self) -> None:
        with pytest.raises(ContractViolationError, match="neither an error nor a query"):
            parse_posts(b'{"batchcomplete": true}', retrieved_at=WHEN)

    def test_a_warnings_block_does_not_stop_the_parse(self) -> None:
        # An over-limit ggslimit warns and silently returns a different count. The records are
        # real and usable; the warning is logged so a mystery about missing posts has an answer.
        body = envelope(page(), warnings={"geosearch": {"warnings": "must be between 1 and 500"}})
        parsed = parse_posts(body, retrieved_at=WHEN)
        assert len(parsed.records) == 1


class TestRequestShape:
    """What goes out on the wire."""

    async def _capture(self, **kwargs: Any) -> httpx.QueryParams:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"batchcomplete": True, "query": {"pages": []}})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            await CommonsClient(client).posts_near(Point(lon=-0.1278, lat=51.5074), **kwargs)
        return seen[0].url.params

    async def test_latitude_goes_first_because_the_provider_wants_it_that_way(self) -> None:
        # Our contracts are longitude first, GeoJSON style. This provider is the other way
        # round, and the swap belongs at the boundary. Getting it wrong returns a valid answer
        # about the wrong place, which nobody notices.
        params = await self._capture()
        assert params["ggscoord"] == "51.5074|-0.1278"

    async def test_formatversion_two_is_always_sent(self) -> None:
        # Without it, booleans arrive as empty strings and pages come back keyed by pageid
        # rather than as a list. Mandatory in practice rather than optional.
        assert (await self._capture())["formatversion"] == "2"

    async def test_maxlag_is_always_sent(self) -> None:
        # API:Etiquette asks a non-interactive client to send it. A poller that omits it is
        # asking to be throttled by something less polite.
        assert int((await self._capture())["maxlag"]) > 0

    async def test_the_globe_is_named_rather_than_defaulted(self) -> None:
        assert (await self._capture())["ggsglobe"] == "earth"

    async def test_the_radius_is_clamped_to_what_the_provider_accepts(self) -> None:
        # Out of range is an error in a 200 body, so a caller asking for 50km would get no
        # posts and an exception. Clamping returns real posts from a smaller circle instead.
        assert (await self._capture(radius_m=50_000))["ggsradius"] == str(RADIUS_MAX_M)
        assert (await self._capture(radius_m=1))["ggsradius"] == str(RADIUS_MIN_M)

    async def test_the_limit_is_clamped_because_over_limit_is_only_a_warning(self) -> None:
        # ggslimit=600 answered 200, warned, and returned 64 results. Not 600, not 500, and no
        # error to branch on, so the clamp has to happen here.
        assert (await self._capture(limit=600))["ggslimit"] == str(RESULT_LIMIT_MAX)

    async def test_no_thumbnail_is_asked_for(self) -> None:
        # The one that matters most in this class. `iiurlwidth` caps `prop=imageinfo` at 50
        # titles however large `ggslimit` is: 500 pages, 50 with imageinfo, `batchcomplete`
        # absent, and our own drop rule then discards the other 450 as unlicensable. So sending
        # it silently undoes the limit below, and nothing in the response says so.
        params = await self._capture()
        assert "iiurlwidth" not in params
        assert params["ggslimit"] == str(RESULT_LIMIT) == "500"

    async def test_extmetadata_is_filtered_to_what_is_read(self) -> None:
        # 64% of the body is licence boilerplate and descriptions in languages nobody asked
        # for: 2,081KB to 743KB for a byte-identical parse.
        sent = (await self._capture())["iiextmetadatafilter"].split("|")
        assert set(sent) == set(EXTMETADATA_FIELDS)


class TestCadence:
    """Our own floor, because the provider publishes none for reads."""

    async def test_a_second_call_inside_the_floor_is_refused_before_it_is_sent(self) -> None:
        sent: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            return httpx.Response(200, json={"batchcomplete": True, "query": {"pages": []}})

        moments = iter(
            [
                datetime(2026, 8, 23, 17, 0, 0, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 0, 0, tzinfo=UTC),
                datetime(2026, 8, 23, 17, 0, 0, 500_000, tzinfo=UTC),
            ]
        )
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            commons = CommonsClient(client, clock=lambda: next(moments))
            await commons.posts_near(Point(lon=0.0, lat=51.0))
            with pytest.raises(RateLimitedError):
                await commons.posts_near(Point(lon=0.0, lat=51.0))
        # Refused before the network, not after: one request went out, not two.
        assert len(sent) == 1

    async def test_a_throttling_status_carries_the_providers_own_figure(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(429, headers={"retry-after": "42"}, json={})

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(RateLimitedError) as caught:
                await CommonsClient(client).posts_near(Point(lon=0.0, lat=51.0))
        assert caught.value.retry_after_seconds == pytest.approx(42.0)


class TestRemainingDropPaths:
    """The rest of the mapping's refusals, each of which loses a record silently otherwise."""

    def test_a_page_with_no_title_or_id_is_dropped(self) -> None:
        parsed = parse_posts(envelope(page(pageid=None)), retrieved_at=WHEN)
        assert parsed.drops["page carried no title or id"] == 1

    def test_imageinfo_missing_a_url_or_a_time_is_dropped(self) -> None:
        # A licence without a URL to fetch, or without an upload time to date the post to, is
        # not a post. Both are separately optional on the wire model, deliberately, so that
        # this is a counted drop rather than a validation error that loses the whole poll.
        for missing in ("url", "mime", "timestamp"):
            info = {k: v for k, v in page()["imageinfo"][0].items() if k != missing}
            parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
            assert parsed.drops["imageinfo lacked a URL, a media type or an upload time"] == 1

    def test_a_metadata_wrapper_with_a_null_value_is_ignored(self) -> None:
        # The wrapper is present and its value is null, which is not the same as the key being
        # absent and would otherwise stringify to "None" on a card.
        info = page()["imageinfo"][0] | {
            "extmetadata": {
                "LicenseShortName": {"value": "CC0"},
                "Artist": {"value": None},
            }
        }
        parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
        assert parsed.records[0].media[0].licence.author is None

    def test_a_metadata_entry_that_is_not_a_wrapper_is_ignored(self) -> None:
        # extmetadata values are {"value": ...} wrappers. A bare string where a wrapper belongs
        # is not something to crash on: the licence is simply not determinable.
        info = page()["imageinfo"][0] | {"extmetadata": {"LicenseShortName": "CC0"}}
        parsed = parse_posts(envelope(page(imageinfo=[info])), retrieved_at=WHEN)
        assert parsed.drops["licence could not be determined"] == 1

    def test_a_coordinate_entry_with_no_numbers_is_skipped(self) -> None:
        both = page(
            coordinates=[
                {"lat": None, "lon": None, "globe": "earth"},
                {"lat": 51.5074, "lon": -0.1278, "globe": "earth"},
            ]
        )
        assert parse_posts(envelope(both), retrieved_at=WHEN).records[0].point.lat == 51.5074


class TestFeedIdentity:
    """What the poller and the health output read off this client."""

    async def test_it_names_itself_and_its_floor(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        ) as client:
            commons = CommonsClient(client)
        assert commons.name == "commons"
        assert commons.min_interval_seconds > 0

    async def test_drops_accumulate_on_the_client_for_health_reporting(self) -> None:
        # /api/layers reports these. A parse that keeps its count to itself leaves the wiring
        # nothing to serve, which is the state this repo was in on 2026-08-20.
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=envelope(page(imageinfo=None)))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            commons = CommonsClient(client)
            await commons.posts_near(Point(lon=0.0, lat=51.0))
        assert commons.drops["no imageinfo, so no licence and no media URL"] == 1


class TestPreviewIsDerived:
    """The preview address is worked out from the original, and it has to match the provider.

    Asking for it with ``iiurlwidth`` is what capped the whole query at 50 records, so it is
    derived instead. Derived is only acceptable while it agrees with the provider, and the first
    test here is what holds that: a recorded response from when we *did* ask carries the API's
    own ``thumburl``, so it can be compared against what this adapter now builds. It is the one
    test that would catch Wikimedia changing its layout.
    """

    def test_the_derived_url_is_the_one_the_api_itself_returned(self) -> None:
        recorded = json.loads(fixture_bytes(FIXTURE))
        compared = 0
        for entry in recorded["query"]["pages"]:
            info = (entry.get("imageinfo") or [{}])[0]
            if info.get("mime") not in {"image/jpeg", "image/png", "image/gif"}:
                continue
            compared += 1
            derived = _rendition(info["url"], info["mime"])
            # The recorded `url` carries `utm_*` tracking parameters and the recorded
            # `thumburl` does not, so the comparison is on the address rather than the query.
            assert derived is not None
            assert derived.split("?")[0] == info["thumburl"].split("?")[0]
        assert compared, "the fixture carries no raster file, so this proves nothing"

    def test_a_type_with_no_still_gets_no_preview(self) -> None:
        # Audio has no thumbnail and a derived one answers HTTP 400, verified live. Before this
        # was derived the API offered its own static UI icon here
        # (`/w/resources/assets/file-type-icons/fileicon-ogg.png`), which was refused on the
        # host; now there is nothing to refuse because nothing is built.
        assert (
            _rendition("https://upload.wikimedia.org/wikipedia/commons/9/9e/A.ogg", "audio/ogg")
            is None
        )
        assert (
            _rendition("https://upload.wikimedia.org/wikipedia/commons/9/9e/A.webm", "video/webm")
            is None
        )
        assert (
            _rendition("https://upload.wikimedia.org/wikipedia/commons/9/9e/A.tif", "image/tiff")
            is None
        )

    def test_every_type_with_a_still_derives_one(self) -> None:
        # 99.86% of a 4,000-record census across ten viewports, and one of each was fetched.
        for mime, suffix in (("image/jpeg", "jpg"), ("image/png", "png"), ("image/gif", "gif")):
            url = f"https://upload.wikimedia.org/wikipedia/commons/1/1a/A.{suffix}"
            assert _rendition(url, mime) == (
                f"https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/A.{suffix}"
                f"/{PREVIEW_WIDTH}px-A.{suffix}"
            )

    def test_an_unexpected_host_derives_nothing_rather_than_something(self) -> None:
        # The safe direction. A URL from somewhere this does not recognise must not become a
        # fabricated address on our media host, which the proxy would then be asked to fetch.
        assert (
            _rendition("https://example.invalid/wikipedia/commons/1/1a/A.jpg", "image/jpeg") is None
        )

    def test_a_path_without_the_shard_pair_derives_nothing(self) -> None:
        # The layout is what makes this derivable: one hex character, then that character plus
        # one. Anything else is a layout this adapter has not seen, so it declines rather than
        # guessing and putting a broken picture on a card.
        for path in (
            "https://upload.wikimedia.org/example.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/aa/a9/Example.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/b/a9/Example.jpg",
        ):
            assert _rendition(path, "image/jpeg") is None

    def test_the_recorded_audio_items_carry_no_preview(self) -> None:
        parsed = parse_posts(fixture_bytes(FIXTURE), retrieved_at=WHEN)
        audio = [p for p in parsed.records if p.media[0].mime == "application/ogg"]
        assert audio
        assert all(item.media[0].preview_url is None for item in audio)


class TestTheFilteredResponse:
    """A payload recorded under the parameters we actually send now.

    The other fixture was recorded while we asked for a thumbnail and for every ``extmetadata``
    key there is, so parsing it proves nothing about the filtered request: it carries a superset.
    The risk this closes is a key that is read but not requested, which arrives absent and drops
    the record as unlicensable, so getting it wrong shows up as a layer with nothing on it.
    """

    def test_it_carries_no_thumbnail_and_still_previews(self) -> None:
        recorded = json.loads(fixture_bytes(FILTERED_FIXTURE))
        assert not any(
            "thumburl" in (entry.get("imageinfo") or [{}])[0]
            for entry in recorded["query"]["pages"]
        )
        parsed = parse_posts(fixture_bytes(FILTERED_FIXTURE), retrieved_at=WHEN)
        rasters = [p for p in parsed.records if p.media[0].mime in {"image/jpeg", "image/png"}]
        assert rasters
        assert all(post.media[0].preview_url for post in rasters)

    def test_the_filter_keeps_every_field_the_adapter_reads(self) -> None:
        parsed = parse_posts(fixture_bytes(FILTERED_FIXTURE), retrieved_at=WHEN)
        assert not parsed.drops
        assert parsed.records
        assert all(post.media[0].licence.name for post in parsed.records)
        assert any(post.media[0].licence.author for post in parsed.records)
        assert any(post.text for post in parsed.records)

    def test_the_recorded_response_carries_only_the_filtered_keys(self) -> None:
        # If this fails, the filter and the fixture have drifted apart and the fixture is no
        # longer evidence about the request we send.
        recorded = json.loads(fixture_bytes(FILTERED_FIXTURE))
        seen = {
            key
            for entry in recorded["query"]["pages"]
            for key in ((entry.get("imageinfo") or [{}])[0].get("extmetadata") or {})
        }
        assert seen <= set(EXTMETADATA_FIELDS)


class TestSharedCoordinates:
    """A provider coordinate several files share was copied, not observed.

    The bug this closes: within 10km of Charing Cross, a 50-file response put **all fifty** on
    one coordinate to seven decimal places, and the files are bulk Unsplash imports called
    "Rustic stovetop" and "Binoculars". Left as `upstream` the globe would draw fifty pins each
    asserting an observed position, through the very field ADR 005 uses to prevent that.
    """

    def at(self, lon: float, lat: float, post_id: str = "1") -> Any:
        return parse_posts(
            envelope(
                page(
                    pageid=int(post_id),
                    coordinates=[{"lat": lat, "lon": lon, "primary": True, "globe": "earth"}],
                )
            ),
            retrieved_at=WHEN,
        ).records[0]

    def test_a_coordinate_two_files_share_becomes_derived(self) -> None:
        # Two is the threshold and it comes from physics rather than from a distribution: the
        # provider quotes six to seven decimals, which is centimetres, and no two independent
        # photographs have fixes that agree to a centimetre.
        posts = (self.at(-0.1277583, 51.5073509, "1"), self.at(-0.1277583, 51.5073509, "2"))
        marked, count = mark_shared_coordinates(posts)

        assert count == 2
        assert [post.location_basis for post in marked] == ["derived", "derived"]
        assert [post.coordinate_shared_by for post in marked] == [2, 2]
        assert not any(post.is_observed_position for post in marked)

    def test_a_coordinate_one_file_carries_stays_upstream(self) -> None:
        # The majority case everywhere except the placeholder-dominated cities: 32 of 50 in
        # Midtown Manhattan, 21 of 50 in Reykjavik. These are real photographs of real places
        # and reclassifying them would throw away the only genuine upstream half this layer has.
        posts = (self.at(-73.985514, 40.75804611, "1"), self.at(-73.9855, 40.758, "2"))
        marked, count = mark_shared_coordinates(posts)

        assert count == 0
        assert [post.location_basis for post in marked] == ["upstream", "upstream"]
        assert all(post.coordinate_shared_by is None for post in marked)

    def test_grouping_is_on_the_unrounded_value(self) -> None:
        # Reykjavik really has two copied batches four metres apart, at 64.146397 and
        # 64.146434. Rounding first would merge them and start inventing agreement rather than
        # detecting it.
        posts = (self.at(-21.94283, 64.146397, "1"), self.at(-21.942754, 64.146434, "2"))
        _, count = mark_shared_coordinates(posts)
        assert count == 0

    def test_the_threshold_is_two(self) -> None:
        assert SHARED_COORDINATE_MIN == 2

    def test_an_already_derived_post_is_left_alone(self) -> None:
        # Nothing in this adapter produces one today, but a second pass over its own output
        # must be a no-op rather than something that rewrites its own evidence.
        posts, _ = mark_shared_coordinates(
            (self.at(-0.1277583, 51.5073509, "1"), self.at(-0.1277583, 51.5073509, "2"))
        )
        again, count = mark_shared_coordinates(posts)
        assert count == 0
        assert [post.coordinate_shared_by for post in again] == [2, 2]

    def test_an_empty_response_reclassifies_nothing(self) -> None:
        assert mark_shared_coordinates(()) == ((), 0)

    async def test_the_client_counts_what_it_reclassified(self) -> None:
        # A derivation nobody can see is a derivation nobody can audit, so the figure is on the
        # client beside the drop counts, for the same reason those are.
        shared = [{"lat": 51.5073509, "lon": -0.1277583, "primary": True, "globe": "earth"}]

        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=envelope(
                    page(pageid=1, coordinates=shared), page(pageid=2, coordinates=shared)
                ),
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            commons = CommonsClient(client)
            parsed = await commons.posts_near(Point(lon=-0.1278, lat=51.5074))

        assert commons.reclassified == 2
        assert all(post.location_basis == "derived" for post in parsed.records)
