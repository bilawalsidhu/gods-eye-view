"""The media proxy: bytes reach a browser from us, never from the provider.

ADR 005 requires media proxied and cached rather than hot-linked, and this is that route.
:attr:`~tracker.contracts.social.PostMedia.url` is the provider's own address, this fetches it
once, keeps it, and serves it.

**Why proxy at all, when the provider allows a direct fetch.** Wikimedia sends
``access-control-allow-origin: *`` on its media, so a browser could load it directly and the
requirement would look like ceremony. It is not. Hot-linking makes every viewer a client of the
provider, so their rate limit is spent by people we cannot see and cannot slow down, and one
popular card becomes a hundred requests we never made. Proxying keeps the provider's cadence
ours to manage, which is the same argument as every other floor in this project. It also stops
a viewer's browser telling Wikimedia which photograph on our globe they looked at.

**Licences are decided before a URL gets here, and this route must never become a way round
that.** ADR 005 drops an item whose licence cannot be determined, and
:class:`~tracker.contracts.social.MediaLicence` makes an unlicensed item unrepresentable, so by
the time a URL exists in a `PostMedia` its licence is established. This route therefore does
not check licences and must not be given a way to fetch something a contract has not already
approved: what stops it is :data:`ALLOWED_HOSTS`, not good intentions. A caller cannot ask it
for an arbitrary address.

**Everything below was verified against the live provider on 2026-08-23.**

*The media host is `upload.wikimedia.org`, and only that.* Both ``url`` and ``thumburl`` on a
Commons file point there. It is the only entry in the allowlist.

*A `thumburl` on `commons.wikimedia.org` is not a thumbnail.* Two of four files in the recorded
fixture, both ``application/ogg``, carry
``https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png``, which is
the wiki's own static UI icon for media it cannot render a preview of. Proxying it would cache a
generic file-type icon and present it as the item's own picture. Excluding that host from the
allowlist is half the fix; the other half is in ``sources/commons.py``, which no longer offers a
preview URL that is not a rendition of the item.

*A non-standard width is HTTP 400 with an HTML body.* Wikimedia renders to its own standard
widths only, and ``512px-`` answered **400 with 2,010 bytes of `text/html`** where ``500px-``
and ``250px-`` both answered 200 with real JPEG. So this route **never constructs a URL**: it
fetches the one the record carries, verbatim but for the tracking parameters below. And because
a 400 can carry a body that a careless cache would keep, the bytes are checked against their
declared type before anything is written. That is the GeoNames lesson: an error page cached
before it is validated is worse than a failure, because it survives.

*Wikimedia appends its own analytics to the URLs it hands out.* Real value:
``?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail``. Stripping
them was verified to return byte-identical content, 38,279 bytes either way. They are stripped
for two reasons: the same image arriving with three different ``utm_content`` values would
otherwise occupy three cache entries, and passing a provider's campaign tracking back to it on
every fetch is not something to do by accident.

**Bytes live in files, metadata lives in the cache.** ``cache.py`` stores text, and base64 in a
SQLite column would inflate every image by a third to hold it in a store that was built for
rate-limit state. So the bytes go to one file per item under ``cache_dir``, which is exactly
what ``sources/geonames.py`` already does with its zip, and ``cache.py`` holds the content type
alongside the fetch time it tracks anyway. A metadata entry whose file has gone is treated as a
miss rather than an error, so the two cannot disagree for longer than one request.

**There is an eviction path, and that is not optional.** AGENTS.md's rule from the adsbdb owner
cache: a cache of something a removal can delete needs a way in, or the removal reports success
while the value is still served. Media can be a photograph of a person under ADR 013, so
:meth:`MediaStore.forget` and :meth:`MediaStore.forget_all` exist and both delete the file as
well as the row. A removal that cleared the metadata and left the bytes on disk would be worse
than no removal at all, because it would look like it had worked.
"""

import hashlib
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Response, status

from tracker.api.state import SettingsDep, StateDep
from tracker.cache import DiskCache, key

_log = logging.getLogger(__name__)

MEDIA_PATH: Final = "/api/media"

ALLOWED_HOSTS: Final = frozenset({"upload.wikimedia.org"})
"""Hosts this proxy will fetch from, and nothing else.

An allowlist rather than a blocklist, because a proxy that takes any address is an open proxy
and ours would be reachable by anyone who can reach the API. Every entry has been fetched
successfully and recorded in ``docs/data-sources.md``.

``commons.wikimedia.org`` is deliberately absent even though it appears in real ``thumburl``
values: what it serves there is the wiki's static file-type icon rather than a rendition of the
item. See the module docstring.
"""

MAX_BYTES: Final = 8 * 1024 * 1024
"""Ceiling on one item, enforced while reading rather than from the header.

A ``Content-Length`` is a claim. This is the cap that actually holds, so a provider that sends
more than it promised fills a buffer we chose rather than the disk. Eight megabytes is
comfortably above a 500-pixel rendition, measured at 38KB, and below the 3MB originals a
Commons file can carry, so an original is served rather than refused.
"""

STRIPPED_PARAMETERS: Final = ("utm_source", "utm_campaign", "utm_content", "utm_medium")
"""Provider analytics, removed before the fetch and before the cache key is taken."""

CACHE_NAMESPACE: Final = "media"
MEDIA_DIRECTORY: Final = "media"

CACHE_TTL_SECONDS: Final = 30 * 24 * 60 * 60
"""How long a cached item is served without re-checking, in seconds: thirty days.

Long, on purpose. A photograph does not change, so the only reason to re-fetch is that the
provider replaced the file, which for Commons means a new URL. The removal path is what handles
the case where an item must stop being served, not a short expiry.
"""

MAGIC: Final = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
    "image/tiff": (b"II*\x00", b"MM\x00*"),
    "audio/ogg": (b"OggS",),
    "video/ogg": (b"OggS",),
    "application/ogg": (b"OggS",),
    "video/mp4": (b"\x00\x00\x00",),
    "audio/mpeg": (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"),
}
"""What each accepted type has to start with, so a body is checked rather than believed.

The declared type is a header and a header is a claim. Wikimedia answers a bad width with a 400
carrying 2,010 bytes of HTML, and a cache that wrote that under ``image/jpeg`` would serve an
error page as a photograph for thirty days.

**SVG is deliberately absent, and it is the one refusal here that is about safety rather than
correctness.** An SVG is a document, it can carry script and external references, and a browser
renders it as one. Serving it from our own origin would put a provider's markup inside our
security context. Commons holds a great many SVGs and this route will not serve one.
"""


def normalise(raw: str) -> str | None:
    """The URL this proxy is willing to fetch, or None if it will not.

    Four refusals, and the middle two are the ones that matter.

    Not HTTPS: a plaintext fetch is a plaintext fetch whoever asked for it.

    **Any userinfo at all.** A URL of the form ``https://user:pass@host/path`` is refused
    outright rather than having its credentials dropped. AGENTS.md's New York 511 finding is the
    worked example of why this is not theoretical: eleven records in a real public feed shipped
    plaintext basic-auth credentials to a directly addressable camera. A proxy that accepted
    them and stripped them would still have logged them somewhere, so the whole URL is refused
    and nothing about it is written to a log.

    **A host outside the allowlist.** Otherwise this is an open proxy with our IP address.

    Then the tracking parameters come off, so the cache is keyed on the image rather than on the
    campaign that referred us to it.
    """
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme != "https" or not parts.hostname:
        return None
    # Refused, not sanitised. See the docstring: a credential we have seen is a credential we
    # have to be sure we never wrote down.
    if parts.username or parts.password or "@" in parts.netloc:
        return None
    if parts.hostname not in ALLOWED_HOSTS:
        return None
    kept = [
        (name, value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
        if name not in STRIPPED_PARAMETERS
    ]
    return urlunsplit((parts.scheme, parts.hostname, parts.path, urlencode(kept), ""))


def cache_name(url: str) -> str:
    """The file name and cache key for one normalised URL.

    A hash rather than the URL itself, because a Commons path contains slashes, percent escapes
    and non-ASCII, and none of that belongs in a file name.
    """
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def body_matches_type(content_type: str, head: bytes) -> bool:
    """Whether these bytes really are what the header said they are."""
    prefixes = MAGIC.get(content_type.split(";", maxsplit=1)[0].strip().lower())
    if prefixes is None:
        return False
    return any(head.startswith(prefix) for prefix in prefixes)


@dataclass(frozen=True, slots=True)
class Media:
    """One cached item: the bytes and the type to serve them as."""

    content_type: str
    body: bytes


class MediaStore:
    """Fetch once, keep on disk, serve from there.

    One instance per process, like every other thing here that owns a cache.
    """

    def __init__(self, client: httpx.AsyncClient, cache: DiskCache, directory: Path) -> None:
        self._client = client
        self._cache = cache
        self._directory = directory

    @property
    def name(self) -> str:
        """What a removal calls this cache when reporting what it reached."""
        return "media proxy"

    def _file(self, name: str) -> Path:
        return self._directory / name

    def cached(self, url: str) -> Media | None:
        """What we already hold for this URL, or None.

        A metadata row whose file has gone counts as nothing rather than as an error. The two
        stores can be made inconsistent by anything that touches the directory, and treating
        that as a miss costs one fetch where treating it as a fault costs the whole card.
        """
        name = cache_name(url)
        entry = self._cache.get(key(CACHE_NAMESPACE, name), ttl_seconds=CACHE_TTL_SECONDS)
        if entry is None:
            return None
        path = self._file(name)
        if not path.is_file():
            return None
        return Media(content_type=entry.value, body=path.read_bytes())

    async def fetch(self, url: str) -> Media | None:
        """This item, from the cache when we have it and from the provider when we do not.

        Returns None when the provider refused, sent more than :data:`MAX_BYTES`, or sent
        something that is not the type it claimed. Nothing is written in any of those cases,
        which is the point: a cached error page outlives the error.
        """
        held = self.cached(url)
        if held is not None:
            return held
        fetched = await self._download(url)
        if fetched is None:
            return None
        name = cache_name(url)
        self._directory.mkdir(parents=True, exist_ok=True)
        self._file(name).write_bytes(fetched.body)
        self._cache.set(key(CACHE_NAMESPACE, name), fetched.content_type)
        return fetched

    async def _download(self, url: str) -> Media | None:
        """One provider fetch, capped and validated, or None.

        The cap is applied while reading rather than to ``Content-Length``, because a header is
        a claim about the body and this is the body.
        """
        try:
            async with self._client.stream("GET", url) as response:
                if response.status_code != status.HTTP_200_OK:
                    # The URL is not logged. It is allowlisted so it holds no credential, but
                    # "we only log the safe ones" is a rule that decays; the host is enough to
                    # tell a provider outage from our own bug.
                    _log.info(
                        "media proxy: %s answered HTTP %d",
                        urlsplit(url).hostname,
                        response.status_code,
                    )
                    return None
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        _log.info(
                            "media proxy: %s sent more than the %d byte cap",
                            urlsplit(url).hostname,
                            MAX_BYTES,
                        )
                        return None
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            _log.info("media proxy: %s failed: %s", urlsplit(url).hostname, type(exc).__name__)
            return None
        body = b"".join(chunks)
        declared = response.headers.get("content-type", "")
        if not body_matches_type(declared, body[:16]):
            # A 200 carrying an HTML error page is the case this catches, and caching it would
            # serve an error as a photograph for a month.
            _log.info(
                "media proxy: %s declared %r and sent something else",
                urlsplit(url).hostname,
                declared[:40],
            )
            return None
        return Media(content_type=declared.split(";")[0].strip().lower(), body=body)

    def forget(self, url: str) -> bool:
        """Stop serving one item, bytes and all.

        Half of the ADR 008 path. Deleting the row and leaving the file would leave the bytes
        readable to anything that walks the directory, and would report success.
        """
        name = cache_name(url)
        removed = self._cache.delete(key(CACHE_NAMESPACE, name)) > 0
        path = self._file(name)
        if path.is_file():
            path.unlink()
            removed = True
        return removed

    def forget_all(self) -> int:
        """Stop serving everything, and say how much went.

        The other half. A removal cannot know which URLs it needs to reach, because the join
        from a person to a photograph lives outside this store, so there has to be a sweep.
        """
        gone = self._cache.delete_prefix(key(CACHE_NAMESPACE, ""))
        if self._directory.is_dir():
            for path in self._directory.iterdir():
                if path.is_file():
                    path.unlink()
        return gone


router = APIRouter()


@router.get(MEDIA_PATH, response_class=Response)
async def media(
    state: StateDep,
    settings: SettingsDep,
    url: Annotated[str, Query(max_length=2048, description="Provider media URL, allowlisted.")],
) -> Response:
    """Serve one provider media item from our own origin.

    Raises:
        HTTPException: 400 when the URL is not one this proxy will fetch, and 502 when the
            provider refused it or sent something that was not what it claimed. Deliberately
            different codes: the first is the caller's problem and the second is not, and a
            single 404 for both would send someone looking in the wrong place.
    """
    normalised = normalise(url)
    if normalised is None:
        # The rejected URL is not echoed back. It could contain a credential someone pasted,
        # and reflecting caller input into a response body is its own bad habit.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="url must be https, carry no credentials, and be on an allowlisted host",
        )
    store = MediaStore(state.http, state.cache, settings.cache_dir / MEDIA_DIRECTORY)
    item = await store.fetch(normalised)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="the provider did not return usable media",
        )
    return Response(
        content=item.body,
        media_type=item.content_type,
        headers={
            # A month, matching the store's own TTL, because these bytes do not change: a
            # replaced Commons file arrives under a new URL. Immutable rather than merely
            # cacheable, so a browser does not revalidate what cannot have moved.
            "cache-control": f"public, max-age={CACHE_TTL_SECONDS}, immutable",
            # Belt and braces on the SVG refusal above: even if something reached this route
            # with a document type, the browser will not treat it as one.
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
        },
    )


def proxy_url(provider_url: str) -> str:
    """The address a browser should ask for, given the address the provider serves from.

    Lives here rather than in the route that calls it, so the path and the parameter name have
    one definition. A caller that built this string itself would keep working until this route
    moved, and then fail at the one thing nobody tests: an image tag.

    Returns the provider URL unchanged when this proxy would refuse it. That is deliberate and
    it is not a hole: the refusal has already happened, so handing back a proxy address would
    promise a fetch that will 400. A caller holding a provider URL can decide not to show it,
    which is what the adapter's own licence and rendition checks are for.
    """
    if normalise(provider_url) is None:
        return provider_url
    return f"{MEDIA_PATH}?{urlencode({'url': provider_url})}"


def accepted_types() -> Iterable[str]:
    """The media types this proxy will serve, for the capability endpoint to advertise."""
    return sorted(MAGIC)
