"""One conditional bulk download, cached on disk, shared by the non-US aircraft registers.

``sources/faa_registry.py`` got here first and worked out the shape: fetch at most once a
day, keep the body on disk, keep the ``Last-Modified`` beside it because it is both the
conditional-request validator and the only extract date the file has, and enforce the floor
against the cached file's own mtime so a restart inside the window opens no socket. Transport
Canada and CASA need exactly that and nothing more, so it lives here rather than three times.

**``faa_registry.py`` is deliberately left alone.** It carries a cloudscraper fetch, a
73MB-specific timeout and a decoy-``Last-Modified`` trap on HEAD that neither of the other two
shares, and rewriting a working 316,030-row parser to share a base class buys nothing anybody
asked for. This module is what the new adapters use; that one keeps its own copy.

**Two fetch profiles, because two of these hosts refuse an honest client and one does not.**
:func:`download` sends this project's descriptive User-Agent, which is what
``wwwapps.tc.gc.ca`` answers normally. :func:`download_as_browser` sends the full browser
header set, which is the only thing ``services.casa.gov.au`` answers at all: a descriptive
User-Agent hangs until timeout with zero bytes received, so on that host a block is
indistinguishable from a network fault unless you already know. Alexander Fanthome decided on
2026-08-20 that presenting a browser header set to a CDN bot filter is permitted where the
provider itself publishes the file for download and states no prohibition, recorded as U3 in
``docs/pending-decisions.md``. It is for a bot filter and never for a stated directive.

**A body is validated before it is installed, never after.** A CDN error page served with
HTTP 200 is a usable-looking body that is not the file, and installing it first destroys the
copy on disk and gives the replacement a fresh mtime, so the daily floor then short-circuits
onto the poison for a day with no further request. That failure mode cost this project a
working gazetteer once already; see the GeoNames note in ``AGENTS.md``.
"""

import asyncio
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Final, TypeVar

import httpx

from tracker.sources.base import SourceError, describe_exception

_log = logging.getLogger(__name__)

T = TypeVar("T")

CONNECT_TIMEOUT_S: Final = 30.0
READ_TIMEOUT_S: Final = 300.0
"""Generous, because the bodies are megabytes. A 304 returns in well under a second."""

CHUNK_BYTES: Final = 1024 * 1024

_LAST_MODIFIED_SUFFIX: Final = ".last-modified"
_HTTP_OK: Final = 200
_HTTP_NOT_MODIFIED: Final = 304

BROWSER_HEADERS: Final[Mapping[str, str]] = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="127", "Not)A;Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
"""The whole set, because a bare Chrome User-Agent is measurably not enough.

Verified against ``services.casa.gov.au`` on 2026-08-24: this set over HTTP/1.1 returns HTTP
200 and 7,005,961 bytes in 3.4 seconds, where the descriptive User-Agent this project normally
sends returns nothing at all. ``cloudscraper`` returns the identical body in the identical
time, so it buys nothing here and is not used: the block is a header filter rather than a
JavaScript challenge, and a second HTTP stack for no measured gain is a dependency with
nothing behind it.
"""


@dataclass(frozen=True, slots=True)
class BulkResponse:
    """What one conditional GET reported, with the body already on disk.

    ``last_modified`` is the raw header, kept as sent so it can be echoed back verbatim in the
    next ``If-Modified-Since``. On both of these registers it is also the only extract date
    there is: nothing in either file's own data carries one.
    """

    status_code: int
    last_modified: str | None = None


BulkFetch = Callable[[str, Mapping[str, str], Path], BulkResponse]
"""One conditional GET, streaming the body to a path. The seam the tests substitute.

Narrow on purpose, exactly as ``faa_registry.ArchiveFetch`` is: everything client-shaped stays
behind it, so a test needs no response double and the product never holds the body in memory.
"""


def parse_extract_date(last_modified: str | None) -> datetime | None:
    """Turn an HTTP ``Last-Modified`` into the register's extract date.

    RFC 7231 fixdate, explicitly GMT: ``Mon, 24 Aug 2026 15:42:02 GMT``. Neither Transport
    Canada nor CASA publishes an extract date in the data, and Transport Canada's zip entry
    mtimes are an hour off its own header and inconsistent with it, so this is the only date
    available to hang an ownership claim on.

    Returns:
        An aware UTC datetime, or ``None`` when the header is missing or unparseable. A
        ``None`` here is what makes every owner address in that batch undated, and ADR 008
        then drops each one and counts it rather than asserting it undated.
    """
    if not last_modified:
        return None
    try:
        parsed = parsedate_to_datetime(last_modified)
    except (TypeError, ValueError):
        _log.warning("unparseable Last-Modified %r", last_modified)
        return None
    # A '-0000' offset parses to naive, which the domain refuses. RFC 7231 says GMT either
    # way, so UTC is attached rather than the batch being thrown away over a CDN's formatting.
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _now() -> datetime:
    """Wall clock, injectable so the refresh floor is asserted rather than slept through."""
    return datetime.now(UTC)


def _stream(
    url: str, headers: Mapping[str, str], destination: Path, *, follow_redirects: bool = True
) -> BulkResponse:
    """The conditional GET both profiles share, streamed straight to ``destination``.

    GET and never HEAD. The FAA taught this project that a HEAD freshness check can answer 503
    with a decoy ``Last-Modified``, reporting a healthy source as down every day, and there is
    no reason to find out whether these two hosts do the same when a conditional GET already
    answers the question for zero bytes on a 304.

    Nothing is written to ``destination`` on a 304, because a 304 has no body.
    """
    with (
        httpx.Client(
            timeout=httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
            follow_redirects=follow_redirects,
        ) as client,
        client.stream("GET", url, headers=dict(headers)) as response,
    ):
        status = int(response.status_code)
        last_modified = response.headers.get("Last-Modified")
        if status == _HTTP_OK:
            with destination.open("wb") as sink:
                for chunk in response.iter_bytes(CHUNK_BYTES):
                    sink.write(chunk)
        else:
            response.close()
    return BulkResponse(status_code=status, last_modified=last_modified)


def download(url: str, headers: Mapping[str, str], destination: Path) -> BulkResponse:
    """Fetch with this project's own descriptive User-Agent, which is the default posture.

    Used for Transport Canada, which serves it normally and needs no workaround of any kind.
    The caller supplies the User-Agent in ``headers`` alongside any ``If-Modified-Since``.
    """
    return _stream(url, headers, destination)


def download_as_browser(url: str, headers: Mapping[str, str], destination: Path) -> BulkResponse:
    """Fetch with the full browser header set, for a host whose CDN refuses an honest client.

    Used for CASA only. See :data:`BROWSER_HEADERS` for the measurement and the module
    docstring for the decision that permits it. The caller's ``headers`` win, so an
    ``If-Modified-Since`` still gets through.
    """
    return _stream(url, {**BROWSER_HEADERS, **headers}, destination)


class BulkFile[T]:
    """One bulk file: the refresh floor, the copy on disk, and the index parsed from it.

    Owns the network and the disk and nothing else. The lookup lives on whatever ``parse``
    returns, which holds no client, so resolving an owner issues zero requests at request
    time. That is a structural fact rather than a rule somebody has to remember, and it is the
    single most important thing this shape buys.

    :meth:`load` is what a caller schedules and it never raises for an upstream fault alone: a
    day-old register is worth far more than an empty one, so a failed refresh is recorded on
    :attr:`last_error` and the copy on disk is parsed instead.
    """

    __slots__ = (
        "_clock",
        "_extract_date",
        "_fetch",
        "_header_path",
        "_headers",
        "_index",
        "_last_error",
        "_min_interval_s",
        "_parse",
        "_path",
        "_source",
        "_url",
    )

    def __init__(
        self,
        *,
        source: str,
        url: str,
        path: Path,
        min_interval_s: float,
        parse: Callable[[Path, datetime | None], T],
        headers: Mapping[str, str] | None = None,
        fetch: BulkFetch = download,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._source = source
        self._url = url
        self._path = path
        self._header_path = path.with_suffix(path.suffix + _LAST_MODIFIED_SUFFIX)
        self._min_interval_s = min_interval_s
        self._parse = parse
        self._headers = dict(headers or {})
        self._fetch = fetch
        self._clock = clock
        self._index: T | None = None
        self._last_error: str | None = None
        self._extract_date: datetime | None = None

    @property
    def source(self) -> str:
        """Provenance on the card and the key this register's drops are counted under."""
        return self._source

    @property
    def index(self) -> T | None:
        """The current index, or ``None`` before the first successful load."""
        return self._index

    @property
    def extract_date(self) -> datetime | None:
        """When the provider built the copy we hold, from its HTTP ``Last-Modified``."""
        return self._extract_date

    @property
    def last_error(self) -> str | None:
        """Why the last refresh failed, or ``None``.

        Set alongside a successful load when the refresh failed and the disk copy was parsed
        instead, so a card can say which extract it is quoting and why it is not newer.
        """
        return self._last_error

    @property
    def refreshed_at(self) -> datetime | None:
        """When the disk copy was last confirmed current, or ``None`` if there is none.

        A 304 counts as confirmation: the file we hold is the file the provider has.
        """
        try:
            stat = self._path.stat()
        except OSError:
            return None
        return datetime.fromtimestamp(stat.st_mtime, tz=UTC)

    def next_refresh_after(self, confirmed_at: datetime) -> datetime:
        """The earliest legitimate next fetch, so a caller schedules against the floor."""
        return confirmed_at + timedelta(seconds=self._min_interval_s)

    async def load(self) -> T:
        """Refresh at most once per floor, then build and keep the index.

        Inside the window this touches no socket. Outside it, one conditional GET goes out and
        a 304 costs nothing but a restamp. Both the download and the parse run on a worker
        thread: the fetch is synchronous and a multi-megabyte CSV parse on the event loop
        stalls every other layer in the process.

        Raises:
            SourceError: There is no disk copy and the download failed, or the body that
                arrived is unusable and there is nothing to fall back on.
        """
        confirmed_at = self.refreshed_at
        if confirmed_at is not None:
            age = (self._clock() - confirmed_at).total_seconds()
            if age < self._min_interval_s:
                if self._index is not None:
                    return self._index
                return await asyncio.to_thread(self._reindex)
        return await asyncio.to_thread(self._refresh)

    def _reindex(self) -> T:
        """Parse the copy on disk without asking the network anything.

        The restart path. Inside the window the file on disk is the current extract by
        definition, so a process that comes back up re-reads it and sends no request.
        """
        return self._parse_held(self._read_header())

    def _refresh(self) -> T:
        """The blocking half of :meth:`load`, run on a worker thread."""
        held = self._read_header()
        temporary = self._path.with_suffix(self._path.suffix + ".part")
        request_headers = dict(self._headers)
        if held and self._path.exists():
            request_headers["If-Modified-Since"] = held
        try:
            response = self._fetch(self._url, request_headers, temporary)
        except Exception as exc:  # noqa: BLE001 - httpx, ssl and the filesystem all land here
            temporary.unlink(missing_ok=True)
            return self._degrade(f"unreachable: {describe_exception(exc)}", held)

        if response.status_code == _HTTP_NOT_MODIFIED:
            temporary.unlink(missing_ok=True)
            if not self._path.exists():
                # We sent a validator for a file we no longer hold, so the 304 is unusable.
                return self._degrade("HTTP 304 but no cached copy to serve", held)
            self._touch()
            self._last_error = None
            _log.info("%s: unchanged (HTTP 304), serving the copy on disk", self._source)
            return self._parse_held(held)

        if response.status_code != _HTTP_OK:
            temporary.unlink(missing_ok=True)
            return self._degrade(f"HTTP {response.status_code} for the download", held)

        return self._install(temporary, response.last_modified, held)

    def _install(self, temporary: Path, last_modified: str | None, held: str | None) -> T:
        """Validate what arrived, then let it replace the copy on disk. Never the other way."""
        extract_date = parse_extract_date(last_modified)
        if extract_date is None:
            _log.warning(
                "%s: no usable Last-Modified; every owner address in this extract will be "
                "dropped and counted as undated",
                self._source,
            )
        try:
            index = self._parse(temporary, extract_date)
        except SourceError as exc:
            temporary.unlink(missing_ok=True)
            return self._degrade(f"HTTP 200 but {exc.detail}", held)
        try:
            temporary.replace(self._path)
            self._write_header(last_modified)
        except OSError as exc:
            # The index is already built, so this run works. Only the next restart pays, by
            # re-downloading rather than sending If-Modified-Since.
            _log.warning(
                "%s: could not cache the download at %s: %s", self._source, self._path, exc
            )
        self._index = index
        self._extract_date = extract_date
        self._last_error = None
        _log.info(
            "%s: installed extract dated %s",
            self._source,
            extract_date.isoformat() if extract_date else "unknown",
        )
        return index

    def _parse_held(self, held: str | None) -> T:
        """Parse the disk copy, recording the reason if those bytes turn out unusable.

        Without this the reason is thrown away: a copy on disk that will not open raises past
        the caller, ``last_error`` stays ``None``, and the layer then reports that the register
        has not been read when it was read and failed.
        """
        extract_date = parse_extract_date(held)
        try:
            index = self._parse(self._path, extract_date)
        except SourceError as exc:
            self._last_error = exc.detail
            raise
        self._index = index
        self._extract_date = extract_date
        return index

    def _degrade(self, reason: str, held: str | None) -> T:
        """Record a failed refresh, serving the copy on disk if there is one."""
        self._last_error = reason
        if self._index is not None:
            _log.warning("%s: refresh failed (%s); keeping the index in hand", self._source, reason)
            return self._index
        if not self._path.exists():
            raise SourceError(self._source, f"{reason}; no cached copy to fall back on")
        _log.warning("%s: refresh failed (%s); parsing the copy on disk", self._source, reason)
        try:
            return self._parse_held(held)
        except SourceError as exc:
            raise SourceError(self._source, f"{reason}; and {exc.detail}") from exc

    def _read_header(self) -> str | None:
        """The ``Last-Modified`` that came with the copy on disk, or ``None``."""
        try:
            value = self._header_path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    def _write_header(self, last_modified: str | None) -> None:
        """Persist the validator, or clear a stale one when the response carried none."""
        self._header_path.parent.mkdir(parents=True, exist_ok=True)
        if last_modified:
            self._header_path.write_text(last_modified, encoding="utf-8")
        else:
            self._header_path.unlink(missing_ok=True)

    def _touch(self) -> None:
        """Restart the window after a 304, without rewriting the body."""
        try:
            self._path.touch()
        except OSError as exc:
            _log.warning("%s: could not restamp %s: %s", self._source, self._path, exc)
