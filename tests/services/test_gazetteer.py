"""The city index: ranking, folding, and the fact that it cannot reach the network.

Plan phase 4 acceptance 3 is the test that matters here: "London" resolves from the local
index with **zero network calls**, returns the United Kingdom city first and offers London,
Ontario below it, asserted by a test that fails if any HTTP client is touched. Two tests
cover it from different sides. One blows up if anything constructs a client or opens a
socket during a lookup. The other reads the module's own imports and fails if a network
library is even reachable from it, which is the stronger claim: the first proves this lookup
made no request, the second proves no lookup can.

There are no timing assertions. The measured figures are in the module docstring of
``services/gazetteer.py``: 1.7 microseconds for "London" against the real 34,099-row file,
372 microseconds for the pathological one-letter query. A test asserting either would be a
CI flake, not a gate.
"""

import ast
import inspect
import socket
from pathlib import Path

import httpx
import pytest

from tests.conftest import fixture_bytes
from tracker.contracts.city import City
from tracker.services.gazetteer import DEFAULT_SEARCH_LIMIT, CityIndex, fold
from tracker.sources.geonames import parse_cities

LONDON_GB_ID = 2643743
LONDON_CA_ID = 6058560
LONDONDERRY_ID = 2643734
EAST_LONDON_ID = 1006984
NEW_LONDON_ID = 4839416

SAINT_JOHNS_ID = 3576022
"""Antigua. GeoNames writes the name with a curly apostrophe and the ASCII column with a
straight one, so the two spellings fold to different keys and both are indexed."""

WARISAN_ID = 290503
"""``Warīsān`` UAE, the row the recon used to show what latin-1 does to this file."""


@pytest.fixture
def index() -> CityIndex:
    """One index over both recorded slices: 300 head rows plus the 9 London and dead rows.

    Built the way the product builds it, through the real adapter, so a change to the drop
    rules shows up here too.
    """
    payload = fixture_bytes("geonames_cities15000_extract.tsv") + fixture_bytes(
        "geonames_cities15000_london_dead_extract.tsv"
    )
    return CityIndex(parse_cities(payload).records)


# ---------------------------------------------------------------- acceptance 3


def test_london_resolves_united_kingdom_first_then_ontario(index: CityIndex) -> None:
    """The whole of plan acceptance 3's ranking clause, on the real rows.

    8,961,989 against 422,324, so population alone separates them by a factor of 21 and no
    tie-break is involved. Londonderry follows as a prefix match rather than an exact one.
    """
    results = index.search("London")
    assert [city.geonames_id for city in results[:3]] == [
        LONDON_GB_ID,
        LONDON_CA_ID,
        LONDONDERRY_ID,
    ]
    assert results[0].country_code == "GB"
    assert results[1].country_code == "CA"


def test_a_lookup_constructs_no_client_and_opens_no_socket(
    index: CityIndex, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fails if anything on the lookup path touches an HTTP client or the network."""

    def _boom(*_: object, **__: object) -> None:
        raise AssertionError("a city lookup must not touch the network")

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _boom)
    monkeypatch.setattr(httpx.Client, "__init__", _boom)
    monkeypatch.setattr(socket.socket, "connect", _boom)
    monkeypatch.setattr(socket, "create_connection", _boom)

    assert index.search("London")[0].geonames_id == LONDON_GB_ID
    assert index.get(LONDON_GB_ID) is not None


def test_the_index_module_cannot_reach_a_network_library() -> None:
    """The structural half: no lookup can make a request, not just this one.

    Reads the module's own imports rather than trusting a runtime spy, because a runtime spy
    only proves the path that ran was clean.
    """
    source = Path(inspect.getfile(CityIndex)).read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)

    banned = (
        "httpx",
        "http",
        "socket",
        "ssl",
        "urllib",
        "requests",
        "aiohttp",
        "asyncio",
        "websockets",
        "tracker.sources",
    )
    offenders = {name for name in imported for prefix in banned if name.startswith(prefix)}
    assert not offenders, f"the index can reach {offenders}"
    assert "async def" not in source, "nothing here awaits anything, so nothing here can fetch"


# ---------------------------------------------------------------- ranking


def test_an_exact_name_beats_a_longer_prefix(index: CityIndex) -> None:
    """Population alone is not the rule. An exact match wins its slot outright."""
    inflated = index.get(LONDONDERRY_ID)
    assert inflated is not None
    swollen = inflated.model_copy(update={"population": 99_000_000})
    rebuilt = CityIndex([swollen, *(c for c in _all(index) if c.geonames_id != LONDONDERRY_ID)])
    assert rebuilt.search("London")[0].geonames_id == LONDON_GB_ID


def test_ties_break_on_the_lowest_geonames_id(index: CityIndex) -> None:
    """The order has to be total, or a test asserting it is a coin toss."""
    original = index.get(LONDON_CA_ID)
    assert original is not None
    twin = original.model_copy(update={"geonames_id": LONDON_CA_ID + 1})
    rebuilt = CityIndex([*_all(index), twin])
    ontarios = [c for c in rebuilt.search("London") if c.population == original.population]
    assert [c.geonames_id for c in ontarios] == [LONDON_CA_ID, LONDON_CA_ID + 1]


def test_prefix_matching_not_substring(index: CityIndex) -> None:
    """Substring would slot East London ZA between the two Londons for no stateable reason."""
    ids = {city.geonames_id for city in index.search("London", limit=50)}
    assert EAST_LONDON_ID not in ids
    assert NEW_LONDON_ID not in ids
    assert index.search("ondon") == ()


def test_the_limit_is_honoured(index: CityIndex) -> None:
    assert len(index.search("l", limit=2)) == 2
    assert len(index.search("London", limit=1)) == 1
    assert DEFAULT_SEARCH_LIMIT == 10


# ---------------------------------------------------------------- folding


def test_accents_and_case_fold_out() -> None:
    assert fold("  KÖLN ") == fold("koln") == "koln"
    assert fold("Warīsān") == "warisan"
    assert fold("New   London") == "new london"
    assert fold("   ") == ""


def test_an_accented_name_answers_to_unaccented_input(index: CityIndex) -> None:
    """7,085 rows carry a non-ASCII name. Typing plain Latin has to find them."""
    assert [c.geonames_id for c in index.search("warisan")] == [WARISAN_ID]
    assert [c.geonames_id for c in index.search("Warīsān")] == [WARISAN_ID]


def test_both_spellings_are_indexed_and_collapse_to_one_result(index: CityIndex) -> None:
    """Saint John's is written with a curly apostrophe and transliterated with a straight one.

    Two keys, one city, one result. A caller must never see the same place twice because we
    indexed it twice.
    """
    curly = index.search("Saint John\u2019s")
    straight = index.search("Saint John's")
    assert [c.geonames_id for c in curly] == [SAINT_JOHNS_ID]
    assert [c.geonames_id for c in straight] == [SAINT_JOHNS_ID]
    assert len(index.search("saint john")) == 1


def test_an_empty_query_returns_nothing_rather_than_everything(index: CityIndex) -> None:
    assert index.search("") == ()
    assert index.search("   ") == ()
    assert index.search("zzzznowhere") == ()


# ---------------------------------------------------------------- shape


def test_get_answers_by_geonames_id(index: CityIndex) -> None:
    london = index.get(LONDON_GB_ID)
    assert london is not None
    assert london.name == "London"
    assert index.get(1) is None


def test_the_index_counts_cities_and_not_spellings(index: CityIndex) -> None:
    """A city indexed under two spellings is still one city."""
    assert len(index) == 303


def test_dead_places_never_reach_the_index(index: CityIndex) -> None:
    """End to end: the adapter drops them, so the gazetteer cannot resolve one.

    Pittwater AU is PPLH and carries 63,482 people. It is a suburb that stopped existing
    under that name, and resolving a post to it would be the product asserting a place that
    is gone.
    """
    for gone in ("Pittwater", "Sant Marti", "Pechersk", "Lumbala"):
        assert index.search(gone) == (), f"{gone} is a dead place and must not resolve"
    assert not [c for c in _all(index) if c.feature_code in {"PPLH", "PPLQ", "PPLW"}]


def test_a_repeated_geonames_id_collapses_to_one_city(index: CityIndex) -> None:
    """The id is GeoNames' primary key. A duplicate is one city, never two."""
    london = index.get(LONDON_GB_ID)
    assert london is not None
    rebuilt = CityIndex([london, london])
    assert len(rebuilt) == 1
    assert rebuilt.search("London") == (london,)


def _all(index: CityIndex) -> list[City]:
    """Every city in an index, for rebuilding a variant of it."""
    return [city for city in (index.get(i) for i in _ids(index)) if city is not None]


def _ids(index: CityIndex) -> list[int]:
    return [city.geonames_id for city in index._by_id.values()]
