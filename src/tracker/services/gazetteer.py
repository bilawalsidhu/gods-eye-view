"""The in-memory city index. No network, no store, no poller.

**This object cannot make an HTTP request.** It takes cities and holds cities. There is no
client, no URL and no coroutine anywhere in it, so "a city lookup issues zero requests" is a
structural fact about the type rather than a rule somebody has to remember. The download
lives in :mod:`tracker.sources.geonames` and hands its records over once at startup.

**Not an ``EntityStore``.** Every other layer here is a TTL store fed by a poller, because
aircraft move and stop reporting. Cities do not move and never expire, so a TTL store would
be actively wrong: it would drop London 90 seconds after startup unless something kept
writing London back, and the thing keeping London alive would be a poller hitting a bulk
file that changes once a week.

Storage, chosen deliberately for 34,072 rows:

- ``dict[int, City]`` keyed on the GeoNames id, for the direct lookup a search result or a
  URL fragment needs.
- Two parallel lists, one of fold keys sorted lexicographically and one of the matching
  cities, searched with :func:`bisect.bisect_left`. A prefix is a contiguous run in a sorted
  list, so the bisect finds the run's start in about 16 comparisons and the scan walks only
  the matches.

Nothing more than that. **No search library and no trie.** Measured on the real 34,099-row
file on 2026-08-20: ``"London"`` resolves in **1.7 microseconds** median, 1.8 at p95, and the
worst case in the whole design, the one-letter query ``"l"`` that matches thousands of rows,
takes 372 microseconds median. The plan asks for under 300 milliseconds. A trie would cost
more memory than the strings it indexes to win back microseconds nobody can perceive. The
parallel lists are what a sorted index is when nobody dresses it up.

The index containers cost 3.8MB on top of the cities themselves, which cost 74MB as pydantic
models, so the whole gazetteer is about 78MB resident. That is the honest number and it is
almost entirely the 34,072 frozen models rather than anything here. If it ever matters, the
fix is the record type and not the index: a slotted dataclass or a columnar layout would cut
it hard. It does not matter on a laptop today.

Every city is indexed under both its ``name`` and its ``ascii_name``. Those differ on 7,085
rows, but folding strips accents and most of the difference is accents alone (``Zürich`` and
``Zurich`` both fold to ``zurich``), so only 967 rows produce a genuinely second key and the
index holds 35,039 keys for 34,072 cities. ``Köln`` answers to ``köln``, ``koln`` and
``koeln``, the last because GeoNames' own ASCII column transliterates rather than folds.
Duplicates collapse on the GeoNames id before ranking, so a match on both spellings is still
one result.

Ranking, and the reason it is two keys rather than one:

1. An exact name match beats a longer prefix match. Type a city's full name and you get that
   city, whatever lives further down the alphabet.
2. Then population, descending. ``London`` GB has 8,961,989 people against ``London`` CA's
   422,324, so the English one leads by a factor of 21 with no tie-break logic, and Ontario
   is offered directly below it.
3. Then the GeoNames id, so the order is total and a test can assert it.

Population alone would very nearly do, and it is not enough on its own: it puts a
high-population longer name above an exact match, and 1,307 names in the file appear more
than once (Victoria nine times, Richmond nine) so a name is never a key.
"""

import unicodedata
from bisect import bisect_left
from collections.abc import Iterable
from heapq import nlargest
from typing import Final

from tracker.contracts.city import City

DEFAULT_SEARCH_LIMIT: Final = 10
"""How many cities a search returns unless the caller says otherwise."""


def fold(value: str) -> str:
    """Normalise a name or a query into the index's key form.

    Accents are decomposed and their combining marks dropped, case is folded, and runs of
    whitespace collapse to one space. So ``  KÖLN `` and ``koln`` produce the same key.

    Accent stripping matters more than it looks: 7,085 rows carry a non-ASCII name, and
    GeoNames' own ASCII column is a transliteration rather than a fold (``Köln`` becomes
    ``Koeln``), so without this a user typing unaccented Latin finds neither spelling.
    """
    decomposed = unicodedata.normalize("NFKD", value)
    unmarked = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(unmarked.casefold().split())


class CityIndex:
    """A read-only index over the GeoNames city dump.

    Built once from :func:`tracker.sources.geonames.parse_cities` output and then only read.
    ``__slots__`` because one of these holds three containers over tens of thousands of rows
    and a per-instance ``__dict__`` is pure waste on an object there is exactly one of.
    """

    __slots__ = ("_by_id", "_cities", "_keys")

    def __init__(self, cities: Iterable[City]) -> None:
        by_id: dict[int, City] = {}
        pairs: list[tuple[str, City]] = []
        for city in cities:
            # Last write wins on a repeated id, which cannot happen in the real file and is
            # not worth a raise: the id is GeoNames' primary key.
            by_id[city.geonames_id] = city
            keys = {fold(city.name), fold(city.ascii_name)}
            pairs.extend((key, city) for key in keys if key)
        pairs.sort(key=lambda pair: pair[0])
        self._by_id = by_id
        # Parallel lists rather than a list of tuples: bisect walks the keys and never needs
        # to unpack, and 35,039 surviving tuple objects is memory spent for nothing.
        self._keys: list[str] = [key for key, _ in pairs]
        self._cities: list[City] = [city for _, city in pairs]

    def __len__(self) -> int:
        """How many distinct cities are in the index."""
        return len(self._by_id)

    def get(self, geonames_id: int) -> City | None:
        """One city by its GeoNames id, or ``None``."""
        return self._by_id.get(geonames_id)

    def search(self, query: str, *, limit: int = DEFAULT_SEARCH_LIMIT) -> tuple[City, ...]:
        """Cities whose name or ASCII name starts with ``query``, best first.

        Prefix matching, not substring. Substring was the other option and it makes the
        ranking worse rather than better: searching ``london`` would pull in ``East London``
        ZA at 478,676 people, which sits between the two Londons and pushes Ontario down a
        place for no reason a user could explain.

        An empty or whitespace-only query returns nothing rather than the whole file.
        """
        key = fold(query)
        if not key:
            return ()

        candidates: dict[int, City] = {}
        exact: set[int] = set()
        index = bisect_left(self._keys, key)
        while index < len(self._keys) and self._keys[index].startswith(key):
            city = self._cities[index]
            candidates[city.geonames_id] = city
            if self._keys[index] == key:
                exact.add(city.geonames_id)
            index += 1

        def rank(city: City) -> tuple[bool, int, int]:
            return (city.geonames_id in exact, city.population, -city.geonames_id)

        # nlargest rather than a full sort: a one-letter query matches thousands of rows and
        # only the top handful is ever returned.
        return tuple(nlargest(limit, candidates.values(), key=rank))
