"""earth-search: the keyless STAC catalogue in front of the public Sentinel-2 archive.

Element 84 runs ``earth-search.aws.element84.com`` over the ``sentinel-cogs`` bucket on the
AWS Registry of Open Data. No key, no account, no terms to sign, and the pixels are Copernicus
Sentinel data, which is free and full and open for commercial use provided the source is
credited. That last point is what rules the obvious alternative out: EOX publishes a finished
global cloudless Sentinel-2 mosaic at ``tiles.maps.eox.at`` that would have saved every line
below, and its WMTS capabilities declare it **CC BY-NC-SA 4.0**. Verified 2026-08-24 by
reading the ``ows:Abstract`` off the live document. NonCommercial is a licence this project
cannot take, so the mosaic is built here from the primary archive instead.

**Everything below was measured against the live service on 2026-08-24.**

*Filter with the legacy ``query`` extension, never CQL2.* earth-search's ``conformsTo`` list
carries no CQL2 class and it **silently discards a ``filter-lang: cql2-json`` body and answers
HTTP 200**, so a cloud-cover filter sent that way returns the unfiltered set. A London query
sent as CQL2 returned 174 matches whose first five were at 100% cloud; the same filter as
``{"query": {"eo:cloud_cover": {"lt": 5}}}`` returned 634 matches with the best three at
0.33%, 0.02% and 1.20%. Getting this wrong produces white rectangles, not an error.

*``limit`` is bounded by the size of the response, not by a documented number.* ``limit=500``
answered **HTTP 502 ``{"message": "Internal server error"}``** on a full item body, and the
identical query with a ``fields`` block trimming the response answered 200 with 400 items.
So this module always sends ``fields``, and :data:`PAGE_LIMIT` sits at 400. The trim is worth
having on its own: a full Sentinel-2 item carries 36 assets, of which one is read.

*The properties that georeference a granule are not all there.* ``proj:epsg`` is, and
``grid:code``, and ``s2:nodata_pixel_percentage``. ``proj:bbox`` and ``proj:transform`` are
**not**, so the granule's corner in UTM metres cannot be read off the item and is derived
here from the MGRS tile code instead. See :func:`granule_origin` for how far that is from the
provider's own answer, which was measured rather than assumed.

*The preview asset is named ``thumbnail`` and the file behind it is not always called that.*
A 2026 item points at ``preview.jpg`` and a 2020 item at ``thumbnail.jpg``, same asset key.
Measured: 343 by 343 pixels, 38,234 bytes, ``image/jpeg``. Over a 109,800m granule that is
320.1m per pixel, which is the resolution the mosaic is built at and roughly twice the
611m/pixel the NASA GIBS basemap it replaces tops out at. The alternative was the ``visual``
Cloud-Optimised GeoTIFF: **298,041,665 bytes** for one granule, with an internal pyramid whose
smallest level is 687 by 687. A ranged request against it does answer HTTP 206, so that route
is real and would double the linear resolution for four times the disk; it also needs a TIFF
tile decoder written by hand. The preview is what ships.

*Sorting by cloud cover and sorting by date are different products.* Sorted by cloud ascending,
London's best scene is dated **2020**. The instruction was the latest near-zero-cloud image, so
this sorts by ``datetime`` descending under a cloud ceiling and takes the first scene seen for
each grid code. A granule with no scene under the ceiling in the window simply has no Sentinel
coverage, and the basemap underneath shows through.
"""

import logging
from collections import Counter
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from typing import Any, Final

import httpx
from pydantic import HttpUrl, ValidationError

from tracker.contracts.base import WireModel
from tracker.contracts.geo import BoundingBox
from tracker.contracts.imagery import GRANULE_SIDE_M, Granule
from tracker.sources.base import ParsedRecords, SourceError, describe_exception

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "earth-search"

BASE_URL: Final = "https://earth-search.aws.element84.com/v1"

COLLECTION: Final = "sentinel-2-l2a"

#: Items per page. 500 answers HTTP 502 even with the response trimmed; 400 answers 200.
PAGE_LIMIT: Final = 400

#: The credit the Copernicus licence requires, and the year is part of it.
#:
#: The Copernicus Sentinel Data Terms ask for "Contains modified Copernicus Sentinel data
#: [Year]". The mosaic spans whichever years its granules came from, so the builder fills the
#: range in rather than this module guessing one.
CREDIT_TEMPLATE: Final = "Contains modified Copernicus Sentinel data {years}"

#: MGRS 100km column letters by zone set. Zone modulo 3 picks the row: 1 is A-H, 2 is J-R,
#: 0 is S-Z. I and O are absent throughout MGRS, which is why these are spelled out.
_COLUMN_SETS: Final = ("STUVWXYZ", "ABCDEFGH", "JKLMNOPQR".replace("O", ""))

#: MGRS 100km row letters, 20 per 2,000,000m cycle. I and O absent again.
_ROW_LETTERS: Final = "ABCDEFGHJKLMNPQRSTUV"

#: Northing cycle of the MGRS row letters, metres.
_ROW_CYCLE_M: Final = 2_000_000.0

#: Odd-numbered zones start their row letters at A, even-numbered zones at F, which is an
#: offset of five letters, or 500,000m.
_ODD_ZONE_ROW_OFFSET_M: Final = 500_000.0

#: Latitude band letters, C to X, 8 degrees each from -80, with I and O absent and X running
#: 12 degrees to 84. Used to lift the row letter out of its 2,000km ambiguity.
_MIN_MGRS_BODY_LEN: Final = 4
"""Zone digits plus band, column and row. Shorter than this is not an MGRS grid code."""

_MIN_UTM_ZONE: Final = 1
_MAX_UTM_ZONE: Final = 60
"""UTM divides the earth into 60 zones of six degrees. A zone outside these is a parse error."""

_BAND_LETTERS: Final = "CDEFGHJKLMNPQRSTUVWX"

_BAND_HEIGHT_DEG: Final = 8.0
_BAND_BASE_LAT: Final = -80.0

#: Metres per degree of latitude, near enough for picking which 2,000km cycle a row is in.
_M_PER_DEG_LAT: Final = 111_320.0


class _WireAsset(WireModel):
    """One STAC asset. Only the address is read."""

    href: str


class _WireItem(WireModel):
    """One STAC item, as permissive as the wire is.

    ``bbox`` is a plain list here rather than a :class:`BoundingBox` because the provider is
    entitled to send four or six elements, and because a record that will not map is dropped
    and counted rather than raising out of the parse.
    """

    id: str
    bbox: list[float] | None = None
    properties: dict[str, Any] = {}  # noqa: RUF012 -- pydantic copies defaults per instance.
    assets: dict[str, _WireAsset] = {}  # noqa: RUF012


class _WirePage(WireModel):
    """One page of a STAC item collection."""

    features: list[_WireItem] = []  # noqa: RUF012
    links: list[dict[str, Any]] = []  # noqa: RUF012


def granule_origin(grid_code: str) -> tuple[float, float] | None:
    """North-west corner of a Sentinel-2 granule in its own UTM zone, metres.

    The provider does not send it. ``proj:bbox`` and ``proj:transform`` are absent from the
    item, and the only place the true origin appears is a second file,
    ``tileinfo_metadata.json``, one per granule. Fetching twenty thousand of those to learn a
    number that is already implied by the tile's name is the same mistake as testing FAA
    freshness with a HEAD, so it is derived here.

    **How far off that is, measured rather than assumed.** The Sentinel-2 tiling grid is the
    MGRS 100km grid with each square grown by 4,900m on every side to 109,800m, but the grown
    squares are then snapped to the product's own 10m pixel grid, so the corner is near the
    MGRS corner and not always on it. Checked against the provider's ``tileinfo_metadata.json``
    on 2026-08-24: granule 30UXC reports easting 600,000 against a derived 600,000, exact;
    granule 30UYB reports 699,960 against a derived 700,000, **40 metres out**. At the
    320.1m pixels this mosaic is built from, 40m is an eighth of a pixel. A test holds this to
    :data:`ORIGIN_TOLERANCE_M` so that a wrong scheme, which would be out by a whole 100km
    square, cannot pass as rounding.

    Returns ``None`` for a code that does not decode, which is the drop-and-count path.
    """
    body = grid_code.removeprefix("MGRS-")
    zone_digits = body[:-3]
    if not zone_digits.isdigit() or len(body) < _MIN_MGRS_BODY_LEN:
        return None
    zone = int(zone_digits)
    band, column, row = body[-3], body[-2], body[-1]
    if not _MIN_UTM_ZONE <= zone <= _MAX_UTM_ZONE or band not in _BAND_LETTERS:
        return None

    columns = _COLUMN_SETS[zone % 3]
    if column not in columns or row not in _ROW_LETTERS:
        return None
    # The MGRS square's own south-west corner, then grown to the granule footprint. Easting is
    # unambiguous: the column letter names one of eight 100km bands across the zone.
    square_easting = (columns.index(column) + 1) * 100_000.0

    # Northing repeats every 2,000km, so the row letter alone names twenty candidates. The
    # latitude band picks one: take the band's own southern edge in metres and choose the
    # candidate nearest to it.
    row_index = _ROW_LETTERS.index(row)
    offset = 0.0 if zone % 2 == 1 else _ODD_ZONE_ROW_OFFSET_M
    base = (row_index * 100_000.0 + offset) % _ROW_CYCLE_M
    band_lat = _BAND_BASE_LAT + _BAND_LETTERS.index(band) * _BAND_HEIGHT_DEG
    # Southern-hemisphere zones carry a 10,000km false northing, so the target is measured in
    # the same frame the answer is returned in.
    target = band_lat * _M_PER_DEG_LAT + (0.0 if band_lat >= 0 else 10_000_000.0)
    cycles = round((target - base) / _ROW_CYCLE_M)
    square_northing = base + cycles * _ROW_CYCLE_M

    # The granule is the 100km square grown by 4,900m on each side; its north-west corner is
    # therefore 4,900m west of and 104,900m north of the square's south-west corner.
    grow = (GRANULE_SIDE_M - 100_000.0) / 2.0
    return square_easting - grow, square_northing + 100_000.0 + grow


#: How far the derived origin may sit from the provider's own, in metres. An eighth of a
#: mosaic pixel. A scheme error would be out by 100,000.
ORIGIN_TOLERANCE_M: Final = 100.0


def parse_items(payload: object) -> ParsedRecords[Granule]:
    """Map one page of STAC items onto granules, dropping and counting what will not map."""
    try:
        page = _WirePage.model_validate(payload)
    except ValidationError as exc:
        raise SourceError(SOURCE_NAME, f"page did not parse: {exc.error_count()} errors") from exc

    kept: list[Granule] = []
    drops: Counter[str] = Counter()
    for item in page.features:
        granule = _to_granule(item)
        if granule is None:
            # One reason rather than a total: `_to_granule` refuses an item missing a usable
            # asset, a capture time or a footprint, and a bare count would leave the rail with
            # nothing to say about which. Widen this if the reasons ever need telling apart.
            drops["item carried no usable visual asset, capture time or footprint"] += 1
            continue
        kept.append(granule)
    return ParsedRecords(records=tuple(kept), drops=drops)


def _to_granule(item: _WireItem) -> Granule | None:
    """One STAC item to one granule, or ``None`` if anything needed is missing or unusable."""
    props = item.properties
    grid_code = props.get("grid:code")
    epsg = props.get("proj:epsg")
    asset = item.assets.get("thumbnail")
    if not isinstance(grid_code, str) or not isinstance(epsg, int) or asset is None:
        return None

    origin = granule_origin(grid_code)
    if origin is None:
        return None

    captured = _parse_datetime(props.get("datetime"))
    if captured is None:
        return None

    bounds = _to_bounds(item.bbox)
    if bounds is None:
        return None

    try:
        return Granule(
            grid_code=grid_code,
            epsg=epsg,
            origin_easting_m=origin[0],
            origin_northing_m=origin[1],
            captured_at=captured,
            cloud_cover=_percent(props.get("eo:cloud_cover")),
            nodata_percent=_percent(props.get("s2:nodata_pixel_percentage")),
            preview_url=HttpUrl(asset.href),
            bounds=bounds,
        )
    except ValidationError:
        return None


def _percent(value: object) -> float:
    """A percentage that the provider sends as ``int`` or ``float`` in the same response.

    ``eo:cloud_cover`` arrives both ways, which a ``strict=True`` float field rejects. Absent
    reads as the worst case rather than as zero: a scene with no cloud score is not a clear one.
    """
    if isinstance(value, bool):
        return 100.0
    if isinstance(value, int | float):
        return min(100.0, max(0.0, float(value)))
    return 100.0


def _parse_datetime(value: object) -> datetime | None:
    """The item's own capture time, made timezone-aware.

    STAC sends ``2026-08-13T11:17:01.975000Z``. ``fromisoformat`` handles the trailing ``Z``
    from Python 3.11 on, and the result is checked for awareness rather than assumed, because
    the project's contracts reject a naive datetime and the failure would otherwise surface as
    a validation error three frames away.
    """
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _to_bounds(bbox: list[float] | None) -> BoundingBox | None:
    """A STAC ``bbox`` to our own, tolerating the six-element form.

    STAC allows ``[west, south, min_z, east, north, max_z]``, and the USGS earthquake feed in
    this project already sends that shape with depth interleaved, so element 2 is not always a
    latitude. Sentinel-2 items send four, but reading positionally without checking the length
    is the exact mistake ``docs`` records against ``bbox[2]``.
    """
    if bbox is None:
        return None
    if len(bbox) == 6:  # noqa: PLR2004 -- the STAC three-dimensional form, named in the docstring.
        west, south, east, north = bbox[0], bbox[1], bbox[3], bbox[4]
    elif len(bbox) == 4:  # noqa: PLR2004 -- the ordinary two-dimensional form.
        west, south, east, north = bbox
    else:
        return None
    try:
        return BoundingBox(west=west, south=south, east=east, north=north)
    except ValidationError:
        return None


def search_body(
    bounds: BoundingBox,
    *,
    max_cloud: float,
    since: datetime,
    page: int = 1,
) -> dict[str, Any]:
    """The request body for one page of a granule search.

    ``fields`` is not an optimisation. Without it the provider answers HTTP 502 at
    :data:`PAGE_LIMIT`, because a full Sentinel-2 item carries 36 assets and 40-odd properties
    and 400 of them exceed whatever the gateway will return.
    """
    return {
        "collections": [COLLECTION],
        "bbox": [bounds.west, bounds.south, bounds.east, bounds.north],
        "datetime": f"{since.astimezone(UTC).isoformat().replace('+00:00', 'Z')}/..",
        # The legacy query extension. CQL2 is silently discarded here; see the module docstring.
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
        "limit": PAGE_LIMIT,
        "page": page,
        "fields": {
            "include": [
                "id",
                "bbox",
                "properties.datetime",
                "properties.eo:cloud_cover",
                "properties.grid:code",
                "properties.proj:epsg",
                "properties.s2:nodata_pixel_percentage",
                "assets.thumbnail",
            ],
            "exclude": ["geometry", "links", "stac_extensions", "collection"],
        },
    }


def newest_per_grid_code(granules: Iterable[Granule]) -> Iterator[Granule]:
    """Keep one granule per MGRS tile: the first seen, which is the newest.

    Depends on the caller having sorted by ``datetime`` descending, which
    :func:`search_body` does. Kept as its own function so the dependency is stated once and
    tested once, rather than being an implicit property of a loop somewhere.
    """
    seen: set[str] = set()
    for granule in granules:
        if granule.grid_code in seen:
            continue
        seen.add(granule.grid_code)
        yield granule


class EarthSearchClient:
    """Talks to earth-search. Holds no state: the sweep is a script, not a poller.

    Nothing in this project polls Sentinel-2. The archive is rebuilt on demand by
    ``scripts/build_basemap.py`` and the result is a directory of tiles, so there is no
    cadence to keep and no cooldown to persist. That is the difference between this and every
    other adapter under ``sources/``.
    """

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def search(
        self,
        bounds: BoundingBox,
        *,
        max_cloud: float,
        since: datetime,
        page: int = 1,
    ) -> ParsedRecords[Granule]:
        """One page of granules inside ``bounds``, newest first, under the cloud ceiling."""
        body = search_body(bounds, max_cloud=max_cloud, since=since, page=page)
        try:
            response = await self._client.post(f"{BASE_URL}/search", json=body)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise SourceError(SOURCE_NAME, describe_exception(exc)) from exc
        return parse_items(payload)
