"""What one Sentinel-2 granule is, once an adapter has finished with it.

A granule is a fixed square of ground in one UTM zone, photographed on one date. It is not a
mover, it has no identity to merge on across providers, and it never expires: the pixels do
not change after the pass. So it carries none of the recency machinery the live layers need,
and everything here is what the mosaic builder has to know to place the picture on the earth.

**The georeference is UTM metres, not degrees, and that is deliberate.** Sentinel-2 products
are delivered on the MGRS grid in the granule's own UTM zone, and the preview image is an
exact, axis-aligned window of that grid. Converting the corners to degrees at ingest and
storing a lat/lon rectangle would be wrong, because the square is not a rectangle in degrees:
its sides bow, and the error at the corners of a 110km granule reaches a few hundred metres.
The mosaic projects each output pixel into the granule's zone instead, which is exact.

Degrees appear once, as :attr:`Granule.bounds`, and only as an index: it is the envelope the
mosaic uses to decide which granules can possibly touch an output tile, never the placement.
"""

from typing import Annotated, Final, Self

from pydantic import Field, HttpUrl, model_validator

from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.contracts.geo import BoundingBox

#: The side of a Sentinel-2 granule in metres, 10,980 pixels at the 10m bands.
#:
#: Fixed by the product rather than by us, and verified against the provider's own
#: ``tileinfo_metadata.json`` on 2026-08-24: granule 30UXC reports a ``tileGeometry`` running
#: 600,000 to 709,800 easting and 5,690,220 to 5,800,020 northing, which is 109,800m square.
GRANULE_SIDE_M: Final = 109_800.0

#: Lowest and highest EPSG codes for a WGS84 UTM zone: 326xx north, 327xx south.
_UTM_NORTH_BASE: Final = 32_600
_UTM_SOUTH_BASE: Final = 32_700
_MAX_ZONE: Final = 60


class Granule(StrictModel):
    """One Sentinel-2 scene, reduced to what it takes to draw it.

    Constructed only by :mod:`tracker.sources.earthsearch`, which maps the provider's STAC
    item onto it and drops anything that will not map.
    """

    #: The MGRS tile this granule covers, provider-formatted, for example ``MGRS-30UXC``.
    #: One granule per code is what the mosaic keeps, so this is the deduplication key.
    grid_code: Annotated[str, Field(min_length=5, max_length=16)]

    #: EPSG code of the granule's UTM zone. 326xx northern, 327xx southern.
    epsg: Annotated[int, Field(ge=_UTM_NORTH_BASE + 1, le=_UTM_SOUTH_BASE + _MAX_ZONE)]

    #: Easting of the granule's north-west corner, metres in :attr:`epsg`.
    origin_easting_m: float

    #: Northing of the granule's north-west corner, metres in :attr:`epsg`.
    origin_northing_m: float

    #: When the spacecraft took it. Not when we fetched it, and not the date anyone asked for:
    #: Sentinel-2 revisits about every five days, so imagery for a requested date usually does
    #: not exist and the scene's own timestamp is the only honest one to carry.
    captured_at: UtcDatetime

    #: Percentage of the granule the provider scored as cloud, 0 to 100.
    cloud_cover: Annotated[float, Field(ge=0.0, le=100.0)]

    #: Percentage of the granule that carries no data at all, 0 to 100. A granule at the edge
    #: of an orbit swath is mostly black, and a black pixel is not a dark field.
    nodata_percent: Annotated[float, Field(ge=0.0, le=100.0)]

    #: The provider's own reduced-resolution JPEG of the whole granule. This is the asset the
    #: mosaic reads: the full ``visual`` GeoTIFF is 298MB and the globe cannot use the depth.
    preview_url: HttpUrl

    #: Envelope in degrees, ``[west, south, east, north]``, used to shortlist granules against
    #: an output tile and for nothing else. See the module docstring.
    bounds: BoundingBox

    @property
    def utm_zone(self) -> int:
        """The UTM zone number, 1 to 60."""
        return self.epsg % 100

    @property
    def northern_hemisphere(self) -> bool:
        """Whether the granule's zone is a northern one, which fixes the false northing."""
        return self.epsg < _UTM_SOUTH_BASE

    @model_validator(mode="after")
    def _zone_is_real(self) -> Self:
        """Reject an EPSG code in the UTM range that names no zone, such as 32600 or 32661."""
        zone = self.utm_zone
        if not 1 <= zone <= _MAX_ZONE:
            message = f"EPSG {self.epsg} is not a WGS84 UTM zone"
            raise ValueError(message)
        return self
