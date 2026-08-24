"""The media proxy.

Most of this file is about what the route refuses, because a proxy is a hole in a wall and the
refusals are the wall. The URL rules, the size cap and the body check are each here for a
specific failure this project has already met somewhere else, and the comments say which.

The route reads exactly two things off the application state, an HTTP client and the disk
cache, so the tests supply exactly those two rather than assembling a fifteen-field
:class:`~tracker.api.state.AppState`. That is a statement about the route's dependencies as
much as a convenience: if it ever needs more, this stops compiling and someone has to say why.
"""

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from tracker.api import routes_media
from tracker.api.routes_media import (
    ALLOWED_HOSTS,
    CACHE_NAMESPACE,
    MAX_BYTES,
    MEDIA_DIRECTORY,
    MEDIA_PATH,
    MediaStore,
    body_matches_type,
    cache_name,
    normalise,
)
from tracker.api.state import get_settings_dep, get_state
from tracker.cache import DiskCache, key

HOST = "upload.wikimedia.org"
MEDIA_URL = f"https://{HOST}/wikipedia/commons/thumb/9/94/Example.jpg/500px-Example.jpg"
JPEG = b"\xff\xd8\xff\xe2" + b"payload" * 8
HTML_ERROR = b'<!DOCTYPE html>\n<html lang="en">\n<title>Wikimedia Error</title>'


@dataclass
class FakeSettings:
    """Only what the route reads."""

    cache_dir: Path


@dataclass
class FakeState:
    """Only what the route reads. See the module docstring."""

    http: httpx.AsyncClient
    cache: DiskCache


def store(tmp_path: Path, handler: Any) -> MediaStore:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return MediaStore(client, DiskCache(tmp_path), tmp_path / MEDIA_DIRECTORY)


def ok(_: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})


class TestNormalise:
    """Which URLs the proxy is willing to fetch at all."""

    def test_the_allowlist_is_the_media_host_and_only_that(self) -> None:
        # Named rather than derived, so widening the allowlist is a decision someone has to
        # come here and make rather than a side effect of editing a set.
        assert frozenset({HOST}) == ALLOWED_HOSTS

    def test_an_allowlisted_https_url_passes(self) -> None:
        assert normalise(MEDIA_URL) == MEDIA_URL

    def test_a_host_outside_the_allowlist_is_refused(self) -> None:
        # Without this the route is an open proxy carrying our IP address and our origin.
        assert normalise("https://example.invalid/x.jpg") is None
        # The wiki's own host is refused too, deliberately: what it serves in a thumburl is a
        # static file-type icon rather than a rendition of the item.
        assert normalise("https://commons.wikimedia.org/w/resources/x.png") is None

    def test_plain_http_is_refused(self) -> None:
        assert normalise(f"http://{HOST}/x.jpg") is None

    def test_a_url_carrying_credentials_is_refused_outright(self) -> None:
        # Refused rather than sanitised, and this is the rule with a real precedent behind it:
        # AGENTS.md records eleven records in a live public camera feed shipping plaintext
        # basic-auth credentials over plain HTTP. A proxy that stripped them would still have
        # had them in memory and one careless log line away from disk.
        assert normalise(f"https://user:secret@{HOST}/x.jpg") is None
        assert normalise(f"https://user@{HOST}/x.jpg") is None

    def test_the_providers_own_tracking_is_stripped(self) -> None:
        # Real value from a real imageinfo response. Stripping was verified to return
        # byte-identical content, and it stops one image occupying three cache entries.
        tracked = (
            f"{MEDIA_URL}?utm_source=commons.wikimedia.org"
            "&utm_campaign=imageinfo&utm_content=thumbnail"
        )
        assert normalise(tracked) == MEDIA_URL

    def test_a_parameter_that_is_not_tracking_survives(self) -> None:
        assert normalise(f"{MEDIA_URL}?page=2") == f"{MEDIA_URL}?page=2"

    def test_rubbish_is_refused_rather_than_raising(self) -> None:
        for raw in ("", "not a url", "//host/x", "javascript:alert(1)"):
            assert normalise(raw) is None

    def test_a_url_python_itself_cannot_parse_is_refused_rather_than_raising(self) -> None:
        # `urlsplit` raises on a malformed IPv6 literal. A caller-supplied string reaching a
        # traceback is a 500 where a 400 is the truth, so the parse is guarded.
        assert normalise("https://[oops/x.jpg") is None


class TestCacheName:
    """The key, and why it is a hash."""

    def test_it_is_stable_and_per_url(self) -> None:
        assert cache_name(MEDIA_URL) == cache_name(MEDIA_URL)
        assert cache_name(MEDIA_URL) != cache_name(MEDIA_URL + "x")

    def test_it_is_a_file_name_rather_than_a_path(self) -> None:
        # A Commons path has slashes, percent escapes and non-ASCII in it, none of which
        # belongs in a file name.
        name = cache_name(MEDIA_URL)
        assert name == hashlib.sha256(MEDIA_URL.encode()).hexdigest()
        assert "/" not in name

    def test_tracking_parameters_do_not_fragment_the_cache(self) -> None:
        tracked = f"{MEDIA_URL}?utm_content=thumbnail"
        assert cache_name(normalise(tracked) or "") == cache_name(MEDIA_URL)


class TestBodyMatchesType:
    """A declared type is a claim about the body. This is the body."""

    @pytest.mark.parametrize(
        ("declared", "head"),
        [
            ("image/jpeg", b"\xff\xd8\xff\xe0"),
            ("image/jpeg; charset=binary", b"\xff\xd8\xff\xe2"),
            ("IMAGE/PNG", b"\x89PNG\r\n\x1a\n"),
            ("image/gif", b"GIF89a"),
            ("application/ogg", b"OggS\x00\x02"),
        ],
    )
    def test_real_media_is_accepted(self, declared: str, head: bytes) -> None:
        assert body_matches_type(declared, head) is True

    def test_an_html_error_page_calling_itself_a_jpeg_is_refused(self) -> None:
        # The exact case: Wikimedia answers a non-standard width with 400 and 2,010 bytes of
        # HTML. Cached under image/jpeg it would serve an error page as a photograph for a
        # month. This is the GeoNames lesson in a different payload.
        assert body_matches_type("image/jpeg", HTML_ERROR[:16]) is False

    def test_svg_is_refused_even_when_the_bytes_are_real(self) -> None:
        # The one refusal here that is about safety rather than correctness. An SVG is a
        # document that a browser will execute script from, and serving it from our own origin
        # would put a provider's markup inside our security context.
        assert body_matches_type("image/svg+xml", b"<svg xmlns=") is False

    def test_a_type_we_do_not_serve_is_refused(self) -> None:
        assert body_matches_type("application/pdf", b"%PDF-1.7") is False
        assert body_matches_type("", b"\xff\xd8\xff") is False


class TestMediaStore:
    """Fetch once, keep, serve."""

    async def test_the_provider_is_asked_once_and_the_bytes_are_kept(self, tmp_path: Path) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            return ok(request)

        media = store(tmp_path, handler)
        first = await media.fetch(MEDIA_URL)
        second = await media.fetch(MEDIA_URL)

        assert first is not None
        assert first.body == JPEG
        assert first.content_type == "image/jpeg"
        assert second is not None
        assert second.body == JPEG
        # The whole point of the route: one provider request however many viewers ask.
        assert len(calls) == 1

    async def test_the_bytes_land_in_a_file_and_the_type_in_the_cache(self, tmp_path: Path) -> None:
        # Two stores on purpose: cache.py holds text, so base64 in a SQLite column would
        # inflate every image by a third to keep it in a store built for rate-limit state.
        media = store(tmp_path, ok)
        await media.fetch(MEDIA_URL)

        name = cache_name(MEDIA_URL)
        assert (tmp_path / MEDIA_DIRECTORY / name).read_bytes() == JPEG
        entry = DiskCache(tmp_path).get(key(CACHE_NAMESPACE, name))
        assert entry is not None
        assert entry.value == "image/jpeg"

    async def test_a_row_whose_file_has_gone_is_a_miss_rather_than_an_error(
        self, tmp_path: Path
    ) -> None:
        # The two stores can be made inconsistent by anything that touches the directory.
        # Treating that as a miss costs one fetch; treating it as a fault costs the card.
        media = store(tmp_path, ok)
        await media.fetch(MEDIA_URL)
        (tmp_path / MEDIA_DIRECTORY / cache_name(MEDIA_URL)).unlink()

        assert media.cached(MEDIA_URL) is None
        again = await media.fetch(MEDIA_URL)
        assert again is not None

    async def test_a_provider_error_is_not_cached(self, tmp_path: Path) -> None:
        # A cached failure outlives the failure, which is the whole reason this is checked
        # before anything is written.
        media = store(tmp_path, lambda _: httpx.Response(400, content=HTML_ERROR))
        assert await media.fetch(MEDIA_URL) is None
        assert media.cached(MEDIA_URL) is None
        assert not (tmp_path / MEDIA_DIRECTORY / cache_name(MEDIA_URL)).exists()

    async def test_a_two_hundred_carrying_an_error_page_is_not_cached(self, tmp_path: Path) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=HTML_ERROR, headers={"content-type": "image/jpeg"})

        media = store(tmp_path, handler)
        assert await media.fetch(MEDIA_URL) is None
        assert media.cached(MEDIA_URL) is None

    async def test_a_body_over_the_cap_is_refused_and_not_cached(self, tmp_path: Path) -> None:
        # Enforced while reading rather than from Content-Length, because a header is a claim.
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=b"\xff\xd8\xff" + b"x" * (MAX_BYTES + 1),
                headers={"content-type": "image/jpeg"},
            )

        media = store(tmp_path, handler)
        assert await media.fetch(MEDIA_URL) is None
        assert media.cached(MEDIA_URL) is None

    async def test_a_transport_failure_is_refused_rather_than_raised(self, tmp_path: Path) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("")

        media = store(tmp_path, handler)
        assert await media.fetch(MEDIA_URL) is None


class TestRemoval:
    """The ADR 008 path, and it has to reach the bytes."""

    async def test_forget_deletes_the_file_as_well_as_the_row(self, tmp_path: Path) -> None:
        # AGENTS.md's adsbdb rule: a cache of something a removal can delete needs a way in,
        # or the removal reports success while the value is still served. Media can be a
        # photograph of a person under ADR 013, so leaving the bytes readable on disk while
        # clearing the metadata would be worse than not removing at all: it would look done.
        media = store(tmp_path, ok)
        await media.fetch(MEDIA_URL)
        path = tmp_path / MEDIA_DIRECTORY / cache_name(MEDIA_URL)
        assert path.is_file()

        assert media.forget(MEDIA_URL) is True

        assert not path.exists()
        assert media.cached(MEDIA_URL) is None
        assert DiskCache(tmp_path).get(key(CACHE_NAMESPACE, cache_name(MEDIA_URL))) is None

    async def test_forgetting_something_we_never_held_says_so(self, tmp_path: Path) -> None:
        assert store(tmp_path, ok).forget(MEDIA_URL) is False

    async def test_forget_all_on_an_empty_store_is_not_an_error(self, tmp_path: Path) -> None:
        # The directory does not exist until the first fetch writes to it, and a removal that
        # ran before anything was cached must not be the thing that fails.
        assert store(tmp_path, ok).forget_all() == 0

    async def test_forget_all_leaves_a_subdirectory_alone(self, tmp_path: Path) -> None:
        # It sweeps files, not the tree. Anything else in there is not ours to delete.
        media = store(tmp_path, ok)
        await media.fetch(MEDIA_URL)
        (tmp_path / MEDIA_DIRECTORY / "not-ours").mkdir()

        media.forget_all()

        assert (tmp_path / MEDIA_DIRECTORY / "not-ours").is_dir()

    async def test_forget_all_sweeps_every_item(self, tmp_path: Path) -> None:
        # A removal cannot know which URLs it needs to reach, because the join from a person to
        # a photograph lives outside this store. So there has to be a sweep.
        media = store(tmp_path, ok)
        await media.fetch(MEDIA_URL)
        await media.fetch(MEDIA_URL + "?page=2")
        directory = tmp_path / MEDIA_DIRECTORY
        assert len(list(directory.iterdir())) == 2

        assert media.forget_all() == 2

        assert list(directory.iterdir()) == []
        assert media.cached(MEDIA_URL) is None


@pytest.fixture
def media_app(tmp_path: Path) -> tuple[FastAPI, list[httpx.Request]]:
    """An app carrying only this router, because `app.py` does not register it yet.

    Hands back the list of requests that reached the provider, so a test can assert that the
    second viewer of a card cost nobody a fetch.
    """
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if "missing" in request.url.path:
            return httpx.Response(404, content=HTML_ERROR)
        return ok(request)

    app = FastAPI()
    app.include_router(routes_media.router)
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.dependency_overrides[get_state] = lambda: FakeState(
        http=upstream, cache=DiskCache(tmp_path)
    )
    app.dependency_overrides[get_settings_dep] = lambda: FakeSettings(cache_dir=tmp_path)
    return app, calls


async def call(app: FastAPI, url: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://tests.invalid"
    ) as client:
        return await client.get(MEDIA_PATH, params={"url": url})


def test_the_advertised_types_are_the_ones_it_will_serve() -> None:
    # For the capability endpoint to publish, so a frontend does not have to guess. SVG must
    # not appear in it, for the reason in the module docstring.
    advertised = list(routes_media.accepted_types())
    assert advertised == sorted(routes_media.MAGIC)
    assert not any("svg" in name for name in advertised)


class TestRoute:
    """What a browser gets."""

    async def test_it_serves_the_bytes_with_the_providers_type(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        app, _ = media_app
        response = await call(app, MEDIA_URL)

        assert response.status_code == 200
        assert response.content == JPEG
        assert response.headers["content-type"] == "image/jpeg"

    async def test_it_tells_the_browser_to_keep_it(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        # These bytes cannot change: a replaced Commons file arrives under a new URL. So the
        # browser is told immutable rather than merely cacheable and stops revalidating.
        app, _ = media_app
        headers = (await call(app, MEDIA_URL)).headers
        assert "immutable" in headers["cache-control"]
        assert headers["x-content-type-options"] == "nosniff"
        # Belt and braces on the SVG refusal: even a document type reaching here cannot run.
        assert "sandbox" in headers["content-security-policy"]

    async def test_a_url_it_will_not_fetch_is_a_four_hundred(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        app, _ = media_app
        response = await call(app, "https://example.invalid/x.jpg")
        assert response.status_code == 400

    async def test_the_rejected_url_is_not_echoed_back(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        # It could carry a credential somebody pasted, and reflecting caller input into a
        # response body is its own bad habit.
        app, _ = media_app
        response = await call(app, f"https://user:secret@{HOST}/x.jpg")
        assert response.status_code == 400
        assert "secret" not in response.text

    async def test_a_provider_failure_is_a_five_oh_two_rather_than_a_four_oh_four(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        # Different codes on purpose: 400 is the caller's problem and 502 is not, and one code
        # for both would send someone looking in the wrong place.
        app, _ = media_app
        response = await call(app, f"https://{HOST}/missing/x.jpg")
        assert response.status_code == 502

    async def test_a_second_request_does_not_reach_the_provider(
        self, media_app: tuple[FastAPI, list[httpx.Request]]
    ) -> None:
        # The requirement, asserted end to end: the browser asks us, we ask the provider once,
        # however many viewers open the card.
        app, calls = media_app
        first = await call(app, MEDIA_URL)
        second = await call(app, MEDIA_URL)
        assert (first.status_code, second.status_code) == (200, 200)
        assert first.content == second.content == JPEG
        assert len(calls) == 1
