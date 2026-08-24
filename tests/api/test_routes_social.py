"""The social post read route.

Two things here are worth more than the rest.

**Every post that leaves this route says how it was placed.** ADR 005's whole design rests on a
client never having to infer whether a pin is a coordinate a provider gave us or a city we
resolved from a sentence, so there is a test that reads the serialised JSON and checks the field
is on every record rather than trusting the contract to have carried it.

**A wide viewport is answered honestly rather than tiled.** The provider caps a geosearch at
10km, so a box wider than that is only searched in the middle, and the response says so. The
tests assert the numbers and the notice, because a client that ignored them would render partial
coverage as a thin scatter and nobody would know why.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI

from tests.conftest import fixture_bytes
from tracker.api import routes_social
from tracker.api.routes_media import MEDIA_PATH
from tracker.api.routes_social import SOCIAL_PATH, proxied
from tracker.api.state import get_state
from tracker.contracts.city import City
from tracker.contracts.geo import Point
from tracker.contracts.social import MediaLicence, PostMedia, SocialPost
from tracker.services.gazetteer import CityIndex
from tracker.services.social import SocialClients
from tracker.sources import commons, mastodon

COMMONS_FIXTURE = "commons_geosearch_generator_live.json"
WHEN = datetime(2026, 8, 23, 17, 0, tzinfo=UTC)
# The London box the recorded Commons response was captured for.
LONDON_BOX = {"west": -0.2, "south": 51.45, "east": -0.05, "north": 51.56}

UTRECHT = City(
    geonames_id=2745912,
    name="Utrecht",
    ascii_name="Utrecht",
    point=Point(lon=5.12, lat=52.09),
    feature_code="PPLA",
    country_code="NL",
    population=357_179,
    timezone="Europe/Amsterdam",
    elevation_m=None,
    modification_date=datetime(2026, 1, 1, tzinfo=UTC).date(),
)
LONDON = City(
    geonames_id=2643743,
    name="London",
    ascii_name="London",
    point=Point(lon=-0.1278, lat=51.5074),
    feature_code="PPLC",
    country_code="GB",
    population=8_961_989,
    timezone="Europe/London",
    elevation_m=None,
    modification_date=datetime(2026, 1, 1, tzinfo=UTC).date(),
)


def timeline(*contents: str) -> bytes:
    """A Mastodon page whose statuses carry the given text."""
    return json.dumps(
        [
            {
                "id": str(100 + index),
                "url": f"https://mas.to/@someone/{100 + index}",
                "uri": f"https://mas.to/users/someone/statuses/{100 + index}",
                "created_at": "2026-08-23T16:40:00.000Z",
                "content": f"<p>{text}</p>",
                "language": "en",
                "account": {"acct": "someone"},
                "media_attachments": [],
            }
            for index, text in enumerate(contents)
        ]
    ).encode()


@dataclass
class FakeState:
    """Only what this route reads, which since the clients moved is one field.

    The route no longer builds anything: it reads the pair the state built. So a test gets a
    fresh pair per app rather than resetting a process-wide singleton either side of itself,
    which is what the autouse fixture here used to be for.
    """

    social: SocialClients


def fake_social(http: httpx.AsyncClient, cities: tuple[City, ...]) -> SocialClients:
    """The pair, built the way ``AppState.__post_init__`` builds it."""
    index = CityIndex(cities)
    return SocialClients(
        commons_client=commons.CommonsClient(http),
        mastodon_client=mastodon.MastodonClient(
            http, resolve=mastodon.exact_city_resolver(index.search)
        ),
    )


def build(
    commons_body: bytes | None = None,
    mastodon_body: bytes | None = None,
    *,
    commons_status: int = 200,
    cities: tuple[City, ...] = (LONDON, UTRECHT),
) -> tuple[FastAPI, list[httpx.Request]]:
    """An app carrying only this router, plus the two providers it talks to."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "commons.wikimedia.org":
            if commons_body is None:
                return httpx.Response(
                    commons_status, json={"batchcomplete": True, "query": {"pages": []}}
                )
            return httpx.Response(commons_status, content=commons_body)
        return httpx.Response(200, content=mastodon_body if mastodon_body is not None else b"[]")

    app = FastAPI()
    app.include_router(routes_social.router)
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    # One state for the app, not one per request. Two of these tests make a second call inside
    # the fifteen-second floor and assert the held page answered it, so a lambda building a
    # fresh pair each time would pass a fresh cache off as a held one.
    state = FakeState(fake_social(upstream, cities))
    app.dependency_overrides[get_state] = lambda: state
    return app, calls


async def get(app: FastAPI, **params: Any) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://tests.invalid"
    ) as client:
        return await client.get(SOCIAL_PATH, params=params)


def media_item(url: str, preview: str | None = None) -> PostMedia:
    return PostMedia(
        url=url,
        preview_url=preview,
        mime="image/jpeg",
        licence=MediaLicence(name="CC BY-SA 4.0", attribution_required=True),
    )


def upstream_post(**overrides: Any) -> SocialPost:
    fields: dict[str, Any] = {
        "source": "commons",
        "post_id": "1",
        "url": "https://commons.wikimedia.org/wiki/File:A.jpg",
        "posted_at": WHEN,
        "text": "a photograph",
        "point": Point(lon=-0.1278, lat=51.5074),
        "location_basis": "upstream",
        "media": (media_item("https://upload.wikimedia.org/wikipedia/commons/9/94/A.jpg"),),
        "retrieved_at": WHEN,
    }
    return SocialPost(**(fields | overrides))


class TestProxied:
    """Media leaves this route as our address, never the provider's."""

    def test_a_media_url_becomes_a_proxy_url(self) -> None:
        # ADR 005's no-hot-linking rule, closed at the boundary rather than trusted to a client
        # that would have to know about Wikimedia to honour it.
        item = proxied(upstream_post()).media[0]
        assert item.url.startswith(f"{MEDIA_PATH}?url=")
        assert "upload.wikimedia.org" not in item.url.split("?")[0]

    def test_a_preview_url_is_proxied_too_and_absence_survives(self) -> None:
        with_preview = upstream_post(
            media=(
                media_item(
                    "https://upload.wikimedia.org/wikipedia/commons/9/94/A.jpg",
                    "https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/A.jpg/500px-A.jpg",
                ),
            )
        )
        assert (proxied(with_preview).media[0].preview_url or "").startswith(MEDIA_PATH)
        assert proxied(upstream_post()).media[0].preview_url is None

    def test_a_url_the_proxy_would_refuse_is_left_alone(self) -> None:
        # Dressing it up as a proxy address would promise a fetch that 400s. A caller holding a
        # provider URL can decide not to show it; a caller holding a broken proxy URL cannot.
        refused = upstream_post(media=(media_item("https://example.invalid/x.jpg"),))
        assert proxied(refused).media[0].url == "https://example.invalid/x.jpg"

    def test_nothing_else_about_the_post_changes(self) -> None:
        before = upstream_post()
        after = proxied(before)
        assert after.location_basis == before.location_basis
        assert after.media[0].licence == before.media[0].licence
        assert after.posted_at == before.posted_at
        assert after.media[0].mime == before.media[0].mime

    def test_a_post_with_no_media_is_returned_unchanged(self) -> None:
        # Which is every Mastodon post: a status carries no rights field, so the adapter drops
        # its attachments. An empty tuple is what a derived post has.
        bare = upstream_post(media=())
        assert proxied(bare) is bare


class TestTheBox:
    """A place is required, because this route has to ask a provider about one."""

    async def test_a_missing_edge_is_a_422(self) -> None:
        app, _ = build()
        response = await get(app, west=-0.2, south=51.45, east=-0.05)
        assert response.status_code == 422

    async def test_an_inverted_box_is_a_422_rather_than_a_500(self) -> None:
        # The caller's mistake, so it must not read as a server fault.
        app, _ = build()
        response = await get(app, west=-0.2, south=51.56, east=-0.05, north=51.45)
        assert response.status_code == 422

    async def test_a_box_crossing_the_antimeridian_is_legitimate(self) -> None:
        # west greater than east is the wrap convention, not an error.
        app, _ = build()
        response = await get(app, west=170.0, south=-10.0, east=-170.0, north=10.0)
        assert response.status_code == 200


def a_full_page(count: int = commons.RESULT_LIMIT) -> bytes:
    """A geosearch response carrying the provider's maximum, each file on its own point.

    Distinct coordinates on purpose: this is about the count being a ceiling, and a shared
    coordinate would drag the reclassification into a test that is not about it.
    """
    pages = [
        {
            "pageid": index + 1,
            "ns": 6,
            "title": f"File:Full{index}.jpg",
            "imagerepository": "local",
            "imageinfo": [
                {
                    "timestamp": "2019-06-02T23:28:55Z",
                    "user": "Testuploader1",
                    "url": f"https://upload.wikimedia.org/wikipedia/commons/a/a9/Full{index}.jpg",
                    "descriptionurl": f"https://commons.wikimedia.org/wiki/File:Full{index}.jpg",
                    "mime": "image/jpeg",
                    "width": 800,
                    "height": 600,
                    "extmetadata": {"LicenseShortName": {"value": "CC BY-SA 4.0"}},
                }
            ],
            "coordinates": [
                {
                    "lat": 51.50 + index * 0.00002,
                    "lon": -0.12 + index * 0.00002,
                    "globe": "earth",
                    "primary": True,
                }
            ],
        }
        for index in range(count)
    ]
    return json.dumps({"batchcomplete": True, "query": {"pages": pages}}).encode()


class TestCoverageIsStated:
    """The pair of radii, and the notice that goes with them."""

    async def test_a_wide_box_is_searched_in_the_middle_and_says_so(self) -> None:
        app, _ = build()
        body = (await get(app, west=-10.0, south=45.0, east=10.0, north=55.0)).json()

        assert body["searched_radius_m"] == commons.RADIUS_MAX_M
        assert body["box_radius_m"] > body["searched_radius_m"]
        assert any("10km of the centre" in notice for notice in body["notices"])

    async def test_a_box_inside_the_cap_is_searched_whole_and_says_nothing(self) -> None:
        app, _ = build()
        body = (await get(app, **LONDON_BOX)).json()

        assert body["searched_radius_m"] == body["box_radius_m"]
        assert not any("centre of this view" in notice for notice in body["notices"])

    async def test_a_full_page_says_the_count_is_a_ceiling_rather_than_a_total(self) -> None:
        # Measured live: central London returns a full 500 files even inside a 359m circle, so
        # a client reading `count` as "how many photographs are here" is wrong about every
        # dense place. Same honesty as `searched_radius_m`, on the other axis.
        app, _ = build(commons_body=a_full_page())
        body = (await get(app, **LONDON_BOX)).json()

        assert any("maximum of 500 files" in notice for notice in body["notices"])

    async def test_a_short_page_says_nothing_about_a_maximum(self) -> None:
        app, _ = build(commons_body=a_full_page(commons.RESULT_LIMIT - 1))
        body = (await get(app, **LONDON_BOX)).json()

        assert not any("maximum of" in notice for notice in body["notices"])

    async def test_a_dropped_file_does_not_hide_the_truncation(self) -> None:
        # Counted on what the provider sent rather than on what mapped. A page of 500 with one
        # unlicensable file parses to 499 records, and reading that as "not truncated" is how
        # the ceiling would go unreported at exactly the places it bites.
        full = json.loads(a_full_page())
        full["query"]["pages"][0]["imageinfo"][0]["extmetadata"] = {}
        app, _ = build(commons_body=json.dumps(full).encode())
        body = (await get(app, **LONDON_BOX)).json()

        assert body["count"] == commons.RESULT_LIMIT - 1
        assert any("maximum of 500 files" in notice for notice in body["notices"])

    async def test_the_provider_is_asked_at_the_centre_of_the_box(self) -> None:
        # Latitude first, because that is what the provider wants and the adapter swaps at its
        # boundary. A wrong order here returns a valid answer about the wrong place.
        app, calls = build()
        await get(app, **LONDON_BOX)
        geosearch = [c for c in calls if c.url.host == "commons.wikimedia.org"]
        assert geosearch
        assert geosearch[0].url.params["ggscoord"].startswith("51.5")


class TestPosts:
    """What comes back."""

    async def test_recorded_commons_posts_reach_the_client(self) -> None:
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX)).json()

        assert body["count"] > 0
        assert {post["source"] for post in body["posts"]} == {"commons"}
        # Both classifications are present, which is the point of the recorded response.
        assert {post["location_basis"] for post in body["posts"]} == {"upstream", "derived"}

    async def test_every_post_states_how_it_was_placed(self) -> None:
        # The ADR 005 guarantee, read off the wire rather than off the contract. A client must
        # never have to infer whether a pin was reported or worked out.
        app, _ = build(
            commons_body=fixture_bytes(COMMONS_FIXTURE),
            mastodon_body=timeline("walking in London today"),
        )
        body = (await get(app, **LONDON_BOX)).json()

        assert body["posts"]
        for post in body["posts"]:
            assert post["location_basis"] in {"upstream", "derived"}

    async def test_a_copied_provider_coordinate_reaches_the_client_as_derived(self) -> None:
        # The bug this closes, asserted where the globe will see it. The recorded response is
        # its own demonstration: three of its four files share 51.5074, -0.1278, the canonical
        # London coordinate to four decimals, while the fourth carries 51.507433, -0.127737 to
        # six. The three were copied and the one was measured, and only the one is an
        # observation. Left unclassified the globe would draw three pins on Charing Cross each
        # asserting a position nobody recorded.
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX)).json()

        by_basis: dict[str, list[dict[str, Any]]] = {}
        for post in body["posts"]:
            by_basis.setdefault(post["location_basis"], []).append(post)

        assert len(by_basis["derived"]) == 3
        assert len(by_basis["upstream"]) == 1
        assert {post["coordinate_shared_by"] for post in by_basis["derived"]} == {3}
        # And the one real photograph keeps its classification and carries no false evidence.
        assert by_basis["upstream"][0]["coordinate_shared_by"] is None
        assert by_basis["upstream"][0]["location_phrase"] is None

    async def test_a_derived_post_carries_the_phrase_it_came_from(self) -> None:
        app, _ = build(mastodon_body=timeline("walking in London today"))
        body = (await get(app, **LONDON_BOX)).json()

        derived = [post for post in body["posts"] if post["location_basis"] == "derived"]
        assert derived
        assert derived[0]["location_phrase"] == "in London"
        assert derived[0]["place_name"] == "London"
        # And no media, because a Mastodon attachment cannot be licensed.
        assert derived[0]["media"] == []

    async def test_a_derived_post_outside_the_box_is_not_returned(self) -> None:
        # The Mastodon half is a firehose with no geographic query, so filtering is ours to do.
        # A post that resolved to Utrecht has no business in a London answer.
        app, _ = build(mastodon_body=timeline("cycling in Utrecht"))
        body = (await get(app, **LONDON_BOX)).json()
        assert body["count"] == 0

    async def test_media_reaches_the_client_as_our_own_address(self) -> None:
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX)).json()

        served = [item for post in body["posts"] for item in post["media"]]
        assert served
        assert all(item["url"].startswith(MEDIA_PATH) for item in served)

    async def test_the_newest_post_comes_first(self) -> None:
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX)).json()
        stamps = [post["posted_at"] for post in body["posts"]]
        assert stamps == sorted(stamps, reverse=True)

    async def test_the_limit_is_honoured(self) -> None:
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX, limit=1)).json()
        assert body["count"] == 1
        assert len(body["posts"]) == 1

    async def test_the_count_matches_what_was_returned(self) -> None:
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        body = (await get(app, **LONDON_BOX)).json()
        assert body["count"] == len(body["posts"])


class TestOneProviderFailing:
    """A read route does not 500 because an upstream did."""

    async def test_a_provider_error_becomes_a_notice(self) -> None:
        app, _ = build(commons_status=500)
        response = await get(app, **LONDON_BOX)

        assert response.status_code == 200
        assert any("photograph search unavailable" in n for n in response.json()["notices"])

    async def test_asking_again_inside_the_floor_is_a_notice_rather_than_an_error(self) -> None:
        # Our own one-per-second floor. Saying so beats an empty answer that reads as "no
        # photographs here", which is a different statement.
        app, _ = build(commons_body=fixture_bytes(COMMONS_FIXTURE))
        first = await get(app, **LONDON_BOX)
        second = await get(app, **LONDON_BOX)

        assert (first.status_code, second.status_code) == (200, 200)
        assert any("one-second floor" in n for n in second.json()["notices"])

    async def test_the_derived_half_survives_the_upstream_half_failing(self) -> None:
        app, _ = build(commons_status=500, mastodon_body=timeline("walking in London today"))
        body = (await get(app, **LONDON_BOX)).json()

        assert [post["location_basis"] for post in body["posts"]] == ["derived"]
        assert body["derived_as_of"] is not None

    async def test_a_mastodon_transport_failure_becomes_a_notice(self) -> None:
        # The derived half failing must not take the upstream half down with it, and must not
        # 500 the route. Distinct from a refusal: an instance that cannot be reached is a
        # different fact from one that will not serve anonymous clients.
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "commons.wikimedia.org":
                return httpx.Response(200, content=fixture_bytes(COMMONS_FIXTURE))
            raise httpx.ConnectTimeout("")

        app = FastAPI()
        app.include_router(routes_social.router)
        upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        state = FakeState(fake_social(upstream, (LONDON,)))
        app.dependency_overrides[get_state] = lambda: state
        response = await get(app, **LONDON_BOX)
        body = response.json()

        assert response.status_code == 200
        assert any("Mastodon unavailable" in notice for notice in body["notices"])
        # An empty message on a ConnectTimeout is the httpx trap AGENTS.md records, so the
        # notice has to name the type rather than render a dangling colon.
        assert any("ConnectTimeout" in notice for notice in body["notices"])
        # And the upstream half still answered.
        assert body["count"] > 0

    async def test_an_instance_refusing_anonymous_access_is_named(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "commons.wikimedia.org":
                return httpx.Response(200, json={"batchcomplete": True, "query": {"pages": []}})
            # What mastodon.social actually answers, re-verified 2026-08-23.
            return httpx.Response(422, json={"error": "This method requires an authenticated user"})

        app = FastAPI()
        app.include_router(routes_social.router)
        upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        state = FakeState(fake_social(upstream, (LONDON,)))
        app.dependency_overrides[get_state] = lambda: state
        body = (await get(app, **LONDON_BOX)).json()

        assert any("refused anonymous access" in notice for notice in body["notices"])
        assert body["derived_as_of"] is None


class TestDerivedPageIsHeld:
    """The polled half has to answer between polls."""

    async def test_the_page_survives_a_request_inside_the_floor(self) -> None:
        # Fifteen seconds is the provider's own cache window, so most requests land inside it.
        # Being told there are no derived posts then is a different statement from "the last
        # page had none", and it would make the layer flicker between empty and not.
        app, calls = build(mastodon_body=timeline("walking in London today"))
        first = (await get(app, **LONDON_BOX)).json()
        second = (await get(app, **LONDON_BOX)).json()

        assert [p["location_basis"] for p in first["posts"]] == ["derived"]
        assert [p["location_basis"] for p in second["posts"]] == ["derived"]
        # One timeline fetch, two answers.
        assert len([c for c in calls if c.url.host == "mas.to"]) == 1
        assert first["derived_as_of"] == second["derived_as_of"]
