"""GeoNames ``cities15000`` bulk-file adapter.

**This is a download, not a poll.** Cities do not move, so there is no poller, no TTL store
and no cadence in seconds. The whole file is fetched at most once a week, kept on disk, and
turned into an in-memory index by :mod:`tracker.services.gazetteer`. Nothing here is on the
hot path of a search.

The weekly refresh is a **conditional** request. GeoNames serves both ``ETag`` and
``Last-Modified`` on the zip (measured 2026-08-19: ``ETag: "327468-6595cb9b7a5b7"``,
``Content-Length: 3306600``), so a refresh normally answers HTTP 304 and costs the provider
nothing. The ``ETag`` is kept on disk beside the zip because a process that restarts inside
the week would otherwise have nothing to send and would re-download 3.3MB to learn that
nothing changed. Persisting it is what makes the conditional request real rather than
decorative.

**The file's own numbers, measured, not documented.** 34,099 rows, 19 tab-separated fields
on every row, no header line, valid UTF-8 with no BOM. GeoNames' readme says "ca 25.000"
rows and is wrong. Zero carriage returns and zero double-quote characters in the whole
file, so a plain split on the tab character is safe and Python's ``csv`` module is actively a
hazard here: the double quote is its default quote character.

**Decoded as UTF-8, and a decode error is an error.** ``latin-1`` would parse the whole
file without raising and mangle every non-ASCII name on the way through: ``Warīsān``
becomes ``WarÄ«sÄn`` silently. Wrong data that validates is worse than a crash.

**Dead places are dropped and counted.** 27 rows carry feature code PPLH, PPLQ or PPLW,
meaning historical, abandoned and destroyed, and every one of them carries a live-looking
population: ``Pittwater`` AU 63,482, ``Sant Martí`` ES 235,719, ``Pechersk`` UA 100,900 and
an Iraqi town destroyed in the war. This is a globe of live data and the gazetteer is what
resolves a post's words to a place, so a destroyed city in the index means the product
asserts a location that no longer exists. They do not reach the domain. PPLX is a different
question and stays: 2,376 rows are sections of a city rather than cities, but a section is a
real inhabited place and one of them is ``Londonderry County Borough`` GB with 87,153
people, so dropping the code would throw away real settlements to solve a ranking problem
that ranking already solves.

Licence: CC BY 4.0, quoted from the provider's own readme retrieved 2026-08-19. Attribution
is a licence condition rather than a courtesy, and CC BY 4.0 wants a link to the source and
a link to the licence, so the credit string is three parts and not one.
"""

import logging
import zipfile
from collections import Counter
from collections.abc import Callable
from datetime import UTC, date, datetime
from io import BytesIO
from pathlib import Path
from typing import Final

import httpx

from tracker.contracts.city import City
from tracker.contracts.geo import Point
from tracker.sources.base import ParsedRecords, SourceError, describe_exception

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "geonames"
"""Provenance for logs and for the layer's attribution."""

# R4 in docs/pending-decisions.md, unratified, and this is the only place the reading is
# acted on. download.geonames.org/robots.txt is `User-agent: *` / `Disallow: /`, every path
# and every robot, and AGENTS.md says honour robots.txt in code. The reading taken is that
# robots.txt binds crawling rather than one conditional fetch a week of a published CC BY
# 4.0 data file that GeoNames documents for exactly this use. Reversing the decision means
# deleting this constant and the class below, nothing else: no other module names this host.
DUMP_URL: Final = "https://download.geonames.org/export/dump/cities15000.zip"
"""The bulk file. Verified 2026-08-19: HTTP 200, 3,306,600 bytes, ``application/zip``."""

ARCHIVE_NAME: Final = "cities15000.zip"
"""What the cached copy is called on disk, matching the last path segment of the URL."""

MEMBER_NAME: Final = "cities15000.txt"
"""The zip's single member, 8,406,754 bytes on the 2026-08-19 capture."""

MIN_REFRESH_INTERVAL_S: Final = 7.0 * 24.0 * 60.0 * 60.0
"""One week, and there is no constructor argument that can lower it.

The provider publishes no numeric cap for the dump directory, so this is our own floor and
it is stricter than anything stated. A constant rather than a setting for the same reason
CelesTrak's two-hour floor is one: configuration may slow a fetch down and must never speed
it up.
"""

MAX_MEMBER_BYTES: Final = 32 * 1024 * 1024
"""Decompression ceiling, about four times the real member.

A zip is attacker-controllable in a way its ``Content-Length`` is not: 3MB of zip can
expand to gigabytes. The member is read through this cap rather than trusted.
"""

EXPECTED_FIELDS: Final = 19
"""Tab-separated fields per row. Every one of the 34,099 rows has exactly this many."""

_LAT: Final = 4
_LON: Final = 5
"""Zero-based indices of latitude and longitude, in that order: the file is latitude-first.

Named constants because this is the one thing in the file that this repo has documented
wrong twice, in a way that was wrong under both one-based and zero-based counting.
"""

DEAD_FEATURE_CODES: Final = frozenset({"PPLH", "PPLQ", "PPLW"})
"""Historical, abandoned and destroyed. Dropped and counted; see the module docstring."""

_ETAG_SUFFIX: Final = ".etag"


def _now() -> datetime:
    """Wall clock, injectable so the weekly floor is asserted rather than slept through."""
    return datetime.now(UTC)


def _optional_int(value: str) -> int | None:
    """An empty cell means absent, not zero. Elevation is empty on 29,612 of 34,099 rows."""
    return int(value) if value else None


def _to_domain(fields: list[str]) -> City:
    """Map one row to the domain contract, or raise for the caller to count.

    Latitude is column 5 and longitude is column 6, one-based, so the pair is swapped here
    into this project's ``[longitude, latitude]`` order. That swap is the whole reason this
    function exists rather than a dict comprehension.
    """
    return City(
        geonames_id=int(fields[0]),
        name=fields[1],
        ascii_name=fields[2],
        point=Point(lon=float(fields[_LON]), lat=float(fields[_LAT])),
        feature_code=fields[7],
        country_code=fields[8],
        admin1_code=fields[10] or None,
        population=int(fields[14]),
        timezone=fields[17],
        elevation_m=_optional_int(fields[15]),
        modification_date=date.fromisoformat(fields[18]),
    )


def parse_cities(payload: bytes) -> ParsedRecords[City]:
    """Parse the tab-separated ``cities15000.txt`` body into domain cities.

    Every row that will not map is dropped with a reason, so a poll that loses records says
    which ones and why. A body that produces nothing at all raises instead: an empty result
    would blank the whole city layer behind an apparently successful refresh, and the file
    has never had fewer than 34,099 rows.

    Args:
        payload: The raw member bytes, exactly as they came out of the zip.

    Raises:
        SourceError: The body is not UTF-8, or not one usable row survived it.
    """
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        # Deliberately fatal. Decoding as latin-1 instead would succeed on any byte
        # sequence and silently corrupt every non-ASCII place name in the file.
        raise SourceError(SOURCE_NAME, f"{MEMBER_NAME} is not UTF-8: {exc}") from exc

    cities: list[City] = []
    drops: Counter[str] = Counter()
    for line in text.splitlines():
        if not line:
            continue
        fields = line.split("\t")
        if len(fields) != EXPECTED_FIELDS:
            drops[f"row has {len(fields)} fields, expected {EXPECTED_FIELDS}"] += 1
            continue
        if fields[7] in DEAD_FEATURE_CODES:
            drops[f"feature code {fields[7]} is a dead place"] += 1
            continue
        try:
            cities.append(_to_domain(fields))
        except (ValueError, TypeError) as exc:
            drops["row does not satisfy the City contract"] += 1
            _log.debug("dropping unmappable GeoNames row %r: %s", fields[0], exc)

    if not cities:
        raise SourceError(
            SOURCE_NAME,
            f"no usable rows in {MEMBER_NAME} ({sum(drops.values())} dropped); treating as "
            "an upstream shape change, not as an empty world",
        )
    if drops:
        _log.info(
            "%s: kept %d cities, dropped %d %r",
            SOURCE_NAME,
            len(cities),
            sum(drops.values()),
            dict(drops),
        )
    return ParsedRecords(records=tuple(cities), drops=drops)


def read_member(archive: bytes) -> bytes:
    """Pull ``cities15000.txt`` out of the downloaded zip, through a size ceiling.

    Raises:
        SourceError: Not a zip, the member is missing, or it exceeds
            :data:`MAX_MEMBER_BYTES` decompressed.
    """
    try:
        with zipfile.ZipFile(BytesIO(archive)) as bundle, bundle.open(MEMBER_NAME) as member:
            declared = bundle.getinfo(MEMBER_NAME).file_size
            body = member.read(MAX_MEMBER_BYTES + 1)
    except (zipfile.BadZipFile, KeyError) as exc:
        raise SourceError(SOURCE_NAME, f"downloaded dump is not readable: {exc!r}") from exc
    # Both halves are needed. The declared size is a header field a hostile zip can lie
    # about, and reading one byte past the ceiling is what catches the lie.
    if declared > MAX_MEMBER_BYTES or len(body) > MAX_MEMBER_BYTES:
        raise SourceError(
            SOURCE_NAME,
            f"{MEMBER_NAME} declares {declared} bytes and exceeded the {MAX_MEMBER_BYTES} "
            "byte decompression ceiling",
        )
    return body


class GeonamesDump:
    """The weekly conditional download, and the disk copy the floor is enforced against.

    Holds no parsed city and answers no search: that is
    :class:`~tracker.services.gazetteer.CityIndex`, which takes cities and never takes an
    HTTP client. Keeping the two apart is what makes "a city lookup issues zero requests" a
    structural fact rather than a test that has to be remembered.

    One process owns one of these. It reads and writes two files under ``cache_dir``: the
    zip as served, and the ``ETag`` that came with it.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        cache_dir: Path,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._path = cache_dir / ARCHIVE_NAME
        self._etag_path = self._path.with_suffix(self._path.suffix + _ETAG_SUFFIX)
        self._clock = clock
        self._last_error: str | None = None

    @property
    def last_error(self) -> str | None:
        """Why the last refresh failed, or ``None``.

        Set alongside a successful answer when a refresh failed but a disk copy was served
        instead. A week-old gazetteer is worth far more than an empty one, so the failure is
        reported rather than raised, and the caller can say "cities are from a copy taken on
        X" instead of dropping the layer.
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

    async def cities(self) -> ParsedRecords[City]:
        """Every city in the current dump, refreshing at most once a week.

        Inside the week this touches no socket at all. Outside it, one conditional request
        goes out and a 304 is success with no work.

        Raises:
            SourceError: There is no disk copy and the download failed, or the body that
                arrived is unusable.
        """
        archive = self._read_disk()
        confirmed_at = self.refreshed_at
        if archive is not None and confirmed_at is not None:
            age = (self._clock() - confirmed_at).total_seconds()
            if age < MIN_REFRESH_INTERVAL_S:
                return self._parse(archive)

        fetched = await self._fetch(archive)
        return self._parse(fetched)

    def _parse(self, archive: bytes) -> ParsedRecords[City]:
        """Parse an archive, recording the reason if those bytes turn out to be unusable.

        Without this the reason is thrown away: a copy on disk that will not open raises past
        the supervised refresh, ``last_error`` stays ``None``, and ``/api/capabilities`` then
        reports that the weekly dump has not been read yet when it was read and failed.
        """
        try:
            return parse_cities(read_member(archive))
        except SourceError as exc:
            self._last_error = exc.detail
            raise

    async def _fetch(self, cached: bytes | None) -> bytes:
        """One conditional request, falling back to the disk copy on any failure."""
        etag = self._read_etag()
        # Only when there is something to validate. An ETag file that outlived its zip (a tmp
        # reaper, a manual delete, a truncated write) would otherwise ask the provider to
        # confirm a file we do not hold, and the 304 that comes back is unusable, so the
        # layer stays empty until the upstream zip happens to change.
        headers = {"If-None-Match": etag} if etag and cached is not None else {}
        try:
            response = await self._client.get(DUMP_URL, headers=headers)
        except httpx.HTTPError as exc:
            # describe_exception, not the exception: httpx timeouts stringify to nothing and
            # this text is what a person reads on the layer rail.
            return self._degrade(f"unreachable: {describe_exception(exc)}", cached)

        if response.status_code == httpx.codes.NOT_MODIFIED:
            if cached is None:
                # We sent no ETag, or an ETag for a file we no longer hold. Either way a 304
                # is unusable and asking again immediately is the wrong move, so this is an
                # error rather than a silent empty layer.
                return self._degrade("HTTP 304 but no cached dump to serve", None)
            self._touch()
            self._last_error = None
            _log.info("%s: dump unchanged (HTTP 304), serving the copy on disk", SOURCE_NAME)
            return cached

        if response.status_code != httpx.codes.OK:
            return self._degrade(f"HTTP {response.status_code} for the dump", cached)

        body = response.content
        # Checked before it is cached, never after. A CDN or proxy error page served with
        # HTTP 200 is a usable-looking body that is not a zip, and writing it first destroys
        # the copy on disk and gives the replacement a fresh mtime, so the weekly floor then
        # short-circuits onto the poison for a week with no further request. An outright 503
        # is strictly kinder than that, which is the wrong way round. Costs one extra
        # decompression a week.
        try:
            read_member(body)
        except SourceError as exc:
            return self._degrade(f"HTTP 200 but {exc.detail}", cached)

        self._write_disk(body, response.headers.get("etag"))
        self._last_error = None
        _log.info("%s: downloaded %d bytes of %s", SOURCE_NAME, len(body), MEMBER_NAME)
        return body

    def _degrade(self, reason: str, cached: bytes | None) -> bytes:
        """Record a failed refresh, serving the disk copy if there is one."""
        self._last_error = reason
        if cached is None:
            raise SourceError(SOURCE_NAME, f"{reason}; no cached dump to fall back on")
        _log.warning("%s: refresh failed (%s); serving the copy on disk", SOURCE_NAME, reason)
        return cached

    def _read_disk(self) -> bytes | None:
        """The zip as last served, or ``None`` when there is no usable copy."""
        try:
            return self._path.read_bytes()
        except OSError:
            return None

    def _read_etag(self) -> str | None:
        """The ``ETag`` that came with the copy on disk, or ``None``."""
        try:
            value = self._etag_path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    def _write_disk(self, body: bytes, etag: str | None) -> None:
        """Store the zip and its ``ETag``. A cache we cannot write is a warning, not a fault."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_bytes(body)
            if etag:
                self._etag_path.write_text(etag, encoding="utf-8")
            else:
                self._etag_path.unlink(missing_ok=True)
        except OSError as exc:
            # The dump is already in hand, so the layer works this run. Only the next
            # restart pays, by re-downloading rather than sending If-None-Match.
            _log.warning("%s: could not cache the dump at %s: %s", SOURCE_NAME, self._path, exc)

    def _touch(self) -> None:
        """Restart the week after a 304, without rewriting 3.3MB."""
        try:
            self._path.touch()
        except OSError as exc:
            _log.warning("%s: could not restamp %s: %s", SOURCE_NAME, self._path, exc)
