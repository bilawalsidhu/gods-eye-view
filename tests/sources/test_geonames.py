"""The GeoNames adapter: the column mapping, the dead places and the weekly conditional fetch.

No network at all. Two recorded slices of the real ``cities15000.txt`` do the work, and the
zip container around them is built here rather than committed, because a 3.3MB archive in
``tests/fixtures`` buys nothing: the bytes inside it are the verbatim upstream rows and the
container is a standard format, not the provider's data.

Two things get more attention than the rest. The weekly floor, because a fetch inside the
window must touch no socket and the ``ETag`` on disk is the only thing that makes the fetch
outside the window cheap. And the dead-place drop, because a destroyed city with a
live-looking population is the one row in this file that makes the product assert a place
that no longer exists.
"""

import inspect
import os
import zipfile
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import httpx
import pytest
import respx

from tests.conftest import fixture_bytes
from tracker.sources.base import SourceError
from tracker.sources.geonames import (
    ARCHIVE_NAME,
    DEAD_FEATURE_CODES,
    DUMP_URL,
    EXPECTED_FIELDS,
    MAX_MEMBER_BYTES,
    MEMBER_NAME,
    MIN_REFRESH_INTERVAL_S,
    GeonamesDump,
    parse_cities,
    read_member,
)

HEAD_FIXTURE = "geonames_cities15000_extract.tsv"
"""``head -300`` of the real file. Holds no London row.

It does hold two dead places, at fixture lines 67 (``Bāzār-e Yakāwlang`` AF, PPLW) and 181
(``Lumbala`` AO, PPLQ). The recon note said it held none, which is wrong: measured here.
"""

LONDON_FIXTURE = "geonames_cities15000_london_dead_extract.tsv"
"""Lines 939, 4351, 10616, 12171, 12173, 18005, 29307, 30801 and 33867, verbatim."""

HEAD_ROWS = 300
HEAD_DEAD_ROWS = 2
LONDON_FIXTURE_ROWS = 9
LONDON_FIXTURE_DEAD_ROWS = 4
"""Pittwater PPLH, Sant Martí PPLQ, one PPLW row from Iraq, Pechersk PPLH."""

LONDON_GB_ID = 2643743
LONDON_CA_ID = 6058560

NOW = datetime(2026, 8, 20, 9, 0, 0, tzinfo=UTC)
ONE_WEEK_S = 604800.0
LIVE_ETAG = '"327468-6595cb9b7a5b7"'
"""The ETag GeoNames actually served on 2026-08-19."""


def _clock() -> datetime:
    return NOW


def _zip(member_body: bytes, *, name: str = MEMBER_NAME) -> bytes:
    """Wrap real upstream rows in the same single-member zip the provider serves."""
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(name, member_body)
    return buffer.getvalue()


def _seed(cache_dir: Path, archive: bytes, *, age_s: float, etag: str | None = None) -> Path:
    """Put a dump on disk as if it had been downloaded ``age_s`` ago."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / ARCHIVE_NAME
    path.write_bytes(archive)
    stamp = (NOW - timedelta(seconds=age_s)).timestamp()
    os.utime(path, (stamp, stamp))
    if etag is not None:
        path.with_suffix(path.suffix + ".etag").write_text(etag, encoding="utf-8")
    return path


@pytest.fixture
def london_rows() -> bytes:
    return fixture_bytes(LONDON_FIXTURE)


@pytest.fixture
def london_archive(london_rows: bytes) -> bytes:
    return _zip(london_rows)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    """A real client. respx intercepts at the transport, so nothing leaves the process."""
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def dump(http: httpx.AsyncClient, tmp_path: Path) -> GeonamesDump:
    return GeonamesDump(http, cache_dir=tmp_path, clock=_clock)


@pytest.fixture
def no_network() -> Iterator[respx.MockRouter]:
    """Every request is a failure. A route that is never called is the assertion."""
    with respx.mock(assert_all_called=False) as router:
        yield router


# ---------------------------------------------------------------- the column mapping


def test_the_head_slice_maps_every_live_row() -> None:
    """300 verbatim rows in, 298 cities out, and the only two losses are dead places."""
    parsed = parse_cities(fixture_bytes(HEAD_FIXTURE))
    assert len(parsed.records) == HEAD_ROWS - HEAD_DEAD_ROWS
    assert parsed.dropped == HEAD_DEAD_ROWS
    assert parsed.drops["feature code PPLW is a dead place"] == 1
    assert parsed.drops["feature code PPLQ is a dead place"] == 1


def test_expected_field_count_is_nineteen() -> None:
    assert EXPECTED_FIELDS == 19


def test_latitude_is_column_five_and_longitude_is_column_six(london_rows: bytes) -> None:
    """The real London GB row. Swap the pair and it lands 51 degrees east of Africa."""
    by_id = {city.geonames_id: city for city in parse_cities(london_rows).records}
    london = by_id[LONDON_GB_ID]
    assert london.point.lon == pytest.approx(-0.12574)
    assert london.point.lat == pytest.approx(51.50853)
    assert london.name == "London"
    assert london.country_code == "GB"
    assert london.admin1_code == "ENG"
    assert london.population == 8961989
    assert london.timezone == "Europe/London"
    assert london.feature_code == "PPLC"
    assert london.modification_date.isoformat() == "2026-08-17"


def test_elevation_is_absent_rather_than_borrowed_from_dem(london_rows: bytes) -> None:
    """Neither London row carries an elevation, and both carry a dem the parser ignores.

    London CA's row reads ``...\t422324\t\t252\t...``: column 16 empty, column 17 dem 252.
    Reading dem as elevation would look like free coverage and be a fabricated value. 58 rows
    in the full file carry dem ``-9999``, which is a no-data sentinel wearing an elevation's
    clothes.
    """
    by_id = {city.geonames_id: city for city in parse_cities(london_rows).records}
    assert by_id[LONDON_GB_ID].elevation_m is None
    assert by_id[LONDON_CA_ID].elevation_m is None
    assert b"\t422324\t\t252\t" in london_rows


def test_non_ascii_names_survive_as_utf8() -> None:
    """Decoded as UTF-8. latin-1 would produce mojibake without raising anything."""
    names = {city.name for city in parse_cities(fixture_bytes(HEAD_FIXTURE)).records}
    assert "Warīsān" in names
    mangled = fixture_bytes(HEAD_FIXTURE).decode("latin-1")
    assert "WarÄ«sÄ\u0081n" in mangled, "latin-1 corrupts silently, which is the point"
    assert "Warīsān" not in mangled


def test_a_body_that_is_not_utf8_is_an_error() -> None:
    with pytest.raises(SourceError, match="not UTF-8"):
        parse_cities(b"\xff\xfe not text at all")


def test_a_row_with_the_wrong_field_count_is_dropped_and_counted() -> None:
    payload = fixture_bytes(LONDON_FIXTURE) + b"\n1\ttoo\tshort\n"
    parsed = parse_cities(payload)
    assert parsed.drops["row has 3 fields, expected 19"] == 1


def test_a_row_that_fails_the_contract_is_dropped_and_counted(london_rows: bytes) -> None:
    """A lowercase country code is real-shaped and still wrong. It must not reach the domain."""
    broken = london_rows.replace(b"\tGB\t", b"\tgb\t")
    parsed = parse_cities(broken)
    assert parsed.drops["row does not satisfy the City contract"] == 2
    assert all(city.country_code != "gb" for city in parsed.records)


def test_a_body_with_no_usable_row_raises_rather_than_emptying_the_layer() -> None:
    with pytest.raises(SourceError, match="no usable rows"):
        parse_cities(b"1\ttoo\tshort\n2\talso\tshort\n")


def test_blank_lines_are_skipped_silently() -> None:
    """A trailing newline is not a dropped record and must not be counted as one."""
    parsed = parse_cities(fixture_bytes(LONDON_FIXTURE) + b"\n\n")
    assert parsed.dropped == LONDON_FIXTURE_DEAD_ROWS


# ---------------------------------------------------------------- dead places


def test_dead_feature_codes_are_the_three_that_mean_gone() -> None:
    assert sorted(DEAD_FEATURE_CODES) == ["PPLH", "PPLQ", "PPLW"]


def test_dead_places_are_dropped_and_counted(london_rows: bytes) -> None:
    """A destroyed city carrying 19,719 people would resolve a post to a place that is gone."""
    parsed = parse_cities(london_rows)
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert parsed.dropped == LONDON_FIXTURE_DEAD_ROWS
    assert parsed.drops["feature code PPLH is a dead place"] == 2
    assert parsed.drops["feature code PPLQ is a dead place"] == 1
    assert parsed.drops["feature code PPLW is a dead place"] == 1
    assert not [c for c in parsed.records if c.feature_code in DEAD_FEATURE_CODES]


def test_city_sections_are_kept(london_rows: bytes) -> None:
    """PPLX is a section of a city, not a dead one. Londonderry County Borough is real."""
    names = {city.name for city in parse_cities(london_rows).records}
    assert "Londonderry County Borough" in names


# ---------------------------------------------------------------- the zip


def test_read_member_returns_the_rows_verbatim(london_rows: bytes) -> None:
    assert read_member(_zip(london_rows)) == london_rows


def test_a_body_that_is_not_a_zip_is_an_error() -> None:
    with pytest.raises(SourceError, match="not readable"):
        read_member(b"not a zip at all")


def test_a_zip_without_the_expected_member_is_an_error(london_rows: bytes) -> None:
    with pytest.raises(SourceError, match="not readable"):
        read_member(_zip(london_rows, name="something_else.txt"))


def test_an_oversized_member_is_refused(
    london_rows: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ceiling is lowered rather than a 32MB archive being built, but the path is the real one.

    3MB of zip can expand to gigabytes, so the member is read through a cap instead of
    trusted.
    """
    monkeypatch.setattr("tracker.sources.geonames.MAX_MEMBER_BYTES", 10)
    with pytest.raises(SourceError, match="decompression ceiling"):
        read_member(_zip(london_rows))


def test_the_real_ceiling_is_generous_enough_for_the_real_file() -> None:
    """The member was 8,406,754 bytes on the 2026-08-19 capture."""
    assert MAX_MEMBER_BYTES > 8_406_754


# ---------------------------------------------------------------- the weekly floor


def test_the_floor_is_one_week_and_lives_in_code() -> None:
    assert MIN_REFRESH_INTERVAL_S == ONE_WEEK_S


def test_configuration_cannot_lower_the_floor() -> None:
    """Not that the default is a week. That nothing can change it."""
    parameters = set(inspect.signature(GeonamesDump.__init__).parameters)
    assert not parameters & {
        "interval",
        "interval_seconds",
        "min_interval",
        "min_interval_seconds",
        "refresh_seconds",
        "poll_seconds",
        "cadence",
        "cadence_seconds",
        "ttl",
        "ttl_seconds",
        "floor",
        "floor_seconds",
        "settings",
    }


async def test_a_fetch_inside_the_week_makes_no_request_at_all(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path, no_network: respx.MockRouter
) -> None:
    """Not merely no unconditional request: no request. The disk copy answers.

    ``no_network`` registers no route, so respx raises on any call that gets through.
    """
    _seed(tmp_path, london_archive, age_s=ONE_WEEK_S - 1.0, etag=LIVE_ETAG)
    parsed = await dump.cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert not no_network.calls
    assert dump.last_error is None


async def test_the_week_is_measured_from_the_copy_on_disk(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    """One second past the week and the conditional request goes out."""
    _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)
    with respx.mock(assert_all_called=True) as router:
        route = router.get(DUMP_URL).respond(304)
        await dump.cities()
    assert route.calls[0].request.headers["if-none-match"] == LIVE_ETAG


async def test_304_is_success_with_no_work_and_restarts_the_week(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    path = _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)
    before = path.stat().st_mtime
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(304)
        parsed = await dump.cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert path.stat().st_mtime > before, "a 304 must restamp, or the next call refetches"
    assert path.read_bytes() == london_archive
    assert dump.last_error is None


async def test_a_first_run_sends_no_if_none_match_and_caches_what_arrives(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    with respx.mock(assert_all_called=True) as router:
        route = router.get(DUMP_URL).respond(
            200, content=london_archive, headers={"ETag": LIVE_ETAG}
        )
        parsed = await dump.cities()
    assert "if-none-match" not in route.calls[0].request.headers
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert (tmp_path / ARCHIVE_NAME).read_bytes() == london_archive
    assert (tmp_path / f"{ARCHIVE_NAME}.etag").read_text(encoding="utf-8") == LIVE_ETAG
    assert dump.refreshed_at is not None


async def test_a_200_without_an_etag_clears_a_stale_one(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    """Sending last week's ETag for this week's file would get a wrong 304."""
    _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(200, content=london_archive)
        await dump.cities()
    assert not (tmp_path / f"{ARCHIVE_NAME}.etag").exists()


async def test_304_with_nothing_cached_is_an_error(dump: GeonamesDump, tmp_path: Path) -> None:
    """A server answering 304 to an unconditional request is broken. We say so, not loop."""
    (tmp_path / f"{ARCHIVE_NAME}.etag").write_text(LIVE_ETAG, encoding="utf-8")
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(304)
        with pytest.raises(SourceError, match="no cached dump"):
            await dump.cities()


async def test_an_etag_that_outlived_its_zip_still_recovers(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    """No validator is sent for a file we do not hold, so a real server answers 200.

    An ETag file survives a tmp reaper, a manual delete or a truncated write to the zip alone.
    Sending it anyway asks GeoNames to confirm a copy we cannot serve, the 304 that comes back
    is unusable by construction, and nothing clears the ETag: the gazetteer then stays empty
    until the upstream zip happens to change.
    """
    (tmp_path / f"{ARCHIVE_NAME}.etag").write_text(LIVE_ETAG, encoding="utf-8")
    sent: list[str | None] = []

    def answer(request: httpx.Request) -> httpx.Response:
        validator = request.headers.get("if-none-match")
        sent.append(validator)
        if validator is not None:
            return httpx.Response(304)
        return httpx.Response(200, content=london_archive, headers={"etag": LIVE_ETAG})

    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).mock(side_effect=answer)
        parsed = await dump.cities()

    assert sent == [None], "a validator was sent for a file we do not hold"
    assert LONDON_GB_ID in {city.geonames_id for city in parsed.records}
    assert dump.last_error is None


async def test_an_error_page_served_with_200_never_replaces_the_copy_on_disk(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    """A CDN error page is a usable-looking body that is not a zip, and it is checked first.

    Writing it first is strictly worse than an outright outage: it destroys a working
    gazetteer, gives the replacement a fresh mtime so the weekly floor short-circuits onto the
    poison with no further request, and reports ``last_error`` as ``None`` so the product says
    the refresh never ran.
    """
    path = _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(200, html="<html><body>503 Service Unavailable</body></html>")
        parsed = await dump.cities()

    assert LONDON_GB_ID in {city.geonames_id for city in parsed.records}
    assert path.read_bytes() == london_archive, "the working dump was overwritten"
    assert dump.last_error is not None
    assert "not readable" in dump.last_error


async def test_an_unreadable_copy_on_disk_says_why(
    dump: GeonamesDump, tmp_path: Path, no_network: respx.MockRouter
) -> None:
    """The reason has to survive into ``/api/capabilities``, or it reads as "never ran"."""
    _seed(tmp_path, b"<html>not a zip at all</html>", age_s=1.0)

    with pytest.raises(SourceError):
        await dump.cities()

    assert dump.last_error is not None
    assert "not readable" in dump.last_error
    assert not no_network.calls, "the weekly floor still holds inside the week"


# ---------------------------------------------------------------- failure behaviour


async def test_a_failed_refresh_serves_the_copy_on_disk(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path
) -> None:
    """Cities do not move, so a week-old gazetteer beats an empty one. The failure is reported."""
    _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(503)
        parsed = await dump.cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert dump.last_error == "HTTP 503 for the dump"


async def test_a_failed_refresh_with_no_copy_raises(dump: GeonamesDump) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(403)
        with pytest.raises(SourceError, match="no cached dump to fall back on"):
            await dump.cities()
    assert dump.last_error == "HTTP 403 for the dump"


async def test_an_unreachable_host_reports_a_readable_reason(dump: GeonamesDump) -> None:
    """httpx timeouts stringify to nothing, and this text goes in front of a person."""
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).mock(side_effect=httpx.ConnectTimeout)
        with pytest.raises(SourceError, match="ConnectTimeout"):
            await dump.cities()
    assert dump.last_error is not None
    assert dump.last_error.startswith("unreachable: ConnectTimeout")


async def test_refreshed_at_is_none_before_anything_is_downloaded(dump: GeonamesDump) -> None:
    assert dump.refreshed_at is None
    assert dump.last_error is None


async def test_an_unwritable_cache_still_serves_the_layer(
    http: httpx.AsyncClient, london_archive: bytes, tmp_path: Path
) -> None:
    """A cache we cannot write costs the next restart a download. It does not cost this run."""
    blocked = tmp_path / "blocked"
    blocked.write_text("this is a file, not a directory", encoding="utf-8")
    dump = GeonamesDump(http, cache_dir=blocked, clock=_clock)
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(200, content=london_archive, headers={"ETag": LIVE_ETAG})
        parsed = await dump.cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS


async def test_a_restamp_that_cannot_be_written_is_survivable(
    dump: GeonamesDump, london_archive: bytes, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A read-only cache directory must not turn a 304 into an outage."""
    _seed(tmp_path, london_archive, age_s=ONE_WEEK_S + 1.0, etag=LIVE_ETAG)

    def _refuse(*_: object, **__: object) -> None:
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "touch", _refuse)
    with respx.mock(assert_all_called=True) as router:
        router.get(DUMP_URL).respond(304)
        parsed = await dump.cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS


# ---------------------------------------------------------------- provenance


def test_the_adapter_names_the_unratified_decision_it_rests_on() -> None:
    """R4 is unratified. Reversing it must be a grep, not an excavation.

    ``download.geonames.org/robots.txt`` is ``Disallow: /`` for every robot and AGENTS.md
    says honour robots.txt in code. The reading taken lives beside the URL, and this test
    fails if the reference is edited out.
    """
    source = Path(inspect.getfile(GeonamesDump)).read_text(encoding="utf-8")
    assert "R4" in source
    assert "docs/pending-decisions.md" in source
    assert "robots.txt" in source


def test_only_this_module_can_fetch_the_dump() -> None:
    """One place to change if R4 is reversed, and provider quirks stay out of services/.

    Two claims. The URL exists exactly once in ``src``, so reversing R4 is a single edit. And
    no module under ``services/`` or ``api/`` names the provider at all, which is the
    architectural rule that keeps the index unable to fetch anything.
    """
    package = Path(inspect.getfile(GeonamesDump)).parents[1]
    holders = [
        path.relative_to(package).as_posix()
        for path in package.rglob("*.py")
        if DUMP_URL in path.read_text(encoding="utf-8")
    ]
    assert holders == ["sources/geonames.py"]

    leaks = [
        path.relative_to(package).as_posix()
        for folder in ("services", "api")
        for path in (package / folder).rglob("*.py")
        if "geonames.org" in path.read_text(encoding="utf-8")
    ]
    assert not leaks, f"the provider host leaked into {leaks}"


def test_a_clean_body_reports_no_drops(london_rows: bytes) -> None:
    """The London GB line on its own: one row in, one city out, nothing counted."""
    only_london = london_rows.splitlines()[4]
    parsed = parse_cities(only_london)
    assert [city.geonames_id for city in parsed.records] == [LONDON_GB_ID]
    assert parsed.dropped == 0
    assert not parsed.drops


async def test_the_default_clock_is_the_wall_clock(
    http: httpx.AsyncClient, london_archive: bytes, tmp_path: Path, no_network: respx.MockRouter
) -> None:
    """No injected clock, a copy written now, and still no request. The floor is real."""
    (tmp_path / ARCHIVE_NAME).write_bytes(london_archive)
    parsed = await GeonamesDump(http, cache_dir=tmp_path).cities()
    assert len(parsed.records) == LONDON_FIXTURE_ROWS - LONDON_FIXTURE_DEAD_ROWS
    assert not no_network.calls
