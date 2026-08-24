"""The city domain contract.

Modelled from the real ``cities15000.txt`` inside ``download.geonames.org``'s
``cities15000.zip``, measured column by column on 2026-08-19, not from documentation.
GeoNames' own readme says "ca 25.000" rows and is wrong: the file has **34,099 rows, 19
tab-separated fields on every one of them, and no header line**. Row 1 is data.

Which measured column each field came from, one-based as the readme numbers them, with how
many of the 34,099 rows carry a value:

======================  ======  ====================================  ==============
Field                   Column  GeoNames name                         Rows populated
======================  ======  ====================================  ==============
``geonames_id``              1  ``geonameid``                         34,099
``name``                     2  ``name``                              34,099
``ascii_name``               3  ``asciiname``                         34,099
``point.lat``                5  ``latitude``                          34,099
``point.lon``                6  ``longitude``                         34,099
``feature_code``             8  ``feature code``                      34,099
``country_code``             9  ``country code``                      34,099
``admin1_code``             11  ``admin1 code``                       34,074
``population``              15  ``population``                        34,099
``elevation_m``             16  ``elevation``                          4,487
``timezone``                18  ``timezone``                          34,099
``modification_date``       19  ``modification date``                 34,099
======================  ======  ====================================  ==============

So ``admin1_code`` and ``elevation_m`` are the only two optional fields, and elevation is
absent on 29,612 rows, which is 87% of the file. Everything else is required because the
provider fills it on every row.

**Latitude is column 5 and longitude is column 6**, so the file is latitude-first and the
adapter swaps into our ``[longitude, latitude]`` order. Measured proof over the whole file:
column 5 ranges -54.81084 to 78.22334 with zero values above 90 in magnitude, column 6
ranges -176.17453 to 179.36451 with 9,075 values above 90. Reading the pair in the other
order fails validation on 9,075 rows and quietly mirrors the rest.

Four columns are deliberately not carried.

``alternatenames`` (column 4) is 4.7MB of comma-joined transliterations across the file,
up to 10,000 characters on one row. Search indexes ``name`` and ``ascii_name`` instead,
which costs nothing extra and still ranks London correctly: the two ``London`` rows are the
only rows in the file whose alternate names hold a standalone ``London`` token, so the
column would not widen the result set. It does hold English exonyms for a minority of
places, so "Cologne" does not currently find ``Köln``. Add the column when a missed search
is measured, not before.

``feature class`` (column 7) is the single character ``P`` on all 34,099 rows of this
extract, so it carries no information here. Every distinction lives in ``feature code``.

``cc2``, ``admin2``, ``admin3`` and ``admin4`` (columns 10 to 14) are empty on 34,078,
5,115, 19,234 and 31,012 rows. One administrative division is what a card shows and what
search disambiguates on.

``dem`` (column 17) is populated on all 34,099 rows and would look like a free elevation
fallback. It is not the place's elevation: it is the average of a 90m or 900m terrain cell
from SRTM3 or GTOPO30. Serving it as a city's elevation would be a fabricated value dressed
as a measured one, and 58 rows carry a ``dem`` of ``-9999``, which is a no-data sentinel
that would validate cleanly as a depth of ten kilometres.

Two things that are not on this contract and belong nowhere near it. There is no per-record
``source``: every row comes from one file from one provider, so provenance is the layer's
attribution (CC BY 4.0, which requires a link to the source and a link to the licence) plus
the dump's own ``ETag``, both held once by the index rather than 34,099 times. And there is
no ``fetched_at``: cities do not move, the record has the provider's own
``modification_date``, and stamping a fetch time onto every frozen row would mean rebuilding
the whole index to change one timestamp.
"""

from datetime import date
from typing import Literal

from pydantic import Field

from tracker.contracts.base import StrictModel
from tracker.contracts.geo import Point


class City(StrictModel):
    """One populated place from the GeoNames ``cities15000`` bulk file.

    Immutable, like every other domain contract here, and for a stronger reason: the whole
    file is loaded once into a read-only in-memory index that answers search with zero
    network calls, and a mutable row would let a caller edit the index underneath the next
    reader.
    """

    kind: Literal["city"] = "city"

    geonames_id: int = Field(
        ge=1,
        description="GeoNames' own integer id, the merge key. Catalogue numbers have run "
        "past seven digits: the recorded Pechersk row is 13535745.",
    )
    name: str = Field(
        min_length=1,
        max_length=200,
        description="The place name as GeoNames publishes it, UTF-8. Longest in the file "
        "is 57 characters; the bound is the provider's own varchar(200). Already the "
        "English name for most large cities (Munich, Rome, Tokyo, Moscow) but not all "
        "(Köln stays Köln).",
    )
    ascii_name: str = Field(
        min_length=1,
        max_length=200,
        description="The same name transliterated to ASCII by GeoNames. Differs from "
        "name on 7,085 rows, and it is the provider's transliteration rather than a "
        "mechanical one: Köln becomes Koeln, not Koln. Indexed alongside name so both "
        "spellings resolve.",
    )

    point: Point = Field(
        description="City centre, longitude first. altitude_m is left unset: elevation "
        "below is metres above mean sea level as the provider gives it, and this "
        "project's altitudes are metres above the WGS84 ellipsoid. The two differ by up "
        "to about 100 metres, so copying one into the other would be a quiet lie. Cesium "
        "clamps the label to terrain anyway."
    )

    feature_code: str = Field(
        min_length=1,
        max_length=10,
        description="GeoNames feature code, e.g. PPLC for a national capital, PPL for a "
        "plain populated place, PPLA2 for a second-order administrative seat. 17 distinct "
        "values in the file and one of them is STLMT rather than PPL-prefixed, so this is "
        "not pattern-constrained. PPLH, PPLQ and PPLW mean historical, abandoned and "
        "destroyed; those 27 rows never reach this contract, see sources/geonames.py.",
    )
    country_code: str = Field(
        pattern=r"^[A-Z]{2}$",
        description="ISO 3166-1 alpha-2, present on every row.",
    )
    admin1_code: str | None = Field(
        default=None,
        max_length=20,
        description="First-order administrative division, empty on 25 rows. A code, not a "
        "display name, and not always a FIPS code either: the US, Switzerland, Belgium "
        "and Montenegro use ISO codes, and the UK and Greece insert an extra level, so "
        "London GB carries ENG. Rendering it as a region name needs GeoNames' separate "
        "admin1Codes.txt, which this project does not fetch.",
    )
    population: int = Field(
        ge=0,
        description="The provider's figure, and the search ranking key. Never empty, but "
        "3 rows report 0 and 45 rows sit below the file's own 15,000 threshold because "
        "capitals are included regardless of size. Largest in the file is 24,874,500.",
    )
    timezone: str = Field(
        min_length=1,
        max_length=40,
        description="IANA timezone id, present on every row. 356 distinct values, all "
        "containing a slash.",
    )
    elevation_m: int | None = Field(
        default=None,
        ge=-500,
        le=9_000,
        description="Metres above mean sea level, the provider's own integer, absent on "
        "29,612 of 34,099 rows. Measured range in the file is -34 to 3,831. Absent means "
        "absent: there is no fallback, see the module docstring on dem.",
    )
    modification_date: date = Field(
        description="When GeoNames last changed the row. A bare date, not a timestamp: "
        "there is no time and no zone anywhere in the file, so this is a date rather than "
        "a UtcDatetime and no midnight is invented. Range across the file is 2006-01-15 "
        "to 2026-08-18.",
    )
