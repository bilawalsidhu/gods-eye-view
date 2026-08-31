"""Geographic primitives.

Coordinate order is ``[longitude, latitude]`` everywhere, matching GeoJSON. This is the
opposite of the ``lat, lon`` order most feeds use, so every source adapter swaps at its
boundary. Getting it wrong puts London in the Indian Ocean, which is at least obvious;
getting it wrong near the equator is not, hence the single convention.
"""

import math
from typing import Self

from pydantic import Field, model_validator

from tracker.contracts.base import Bearing, Latitude, Longitude, StrictModel

EARTH_RADIUS_M = 6_371_008.8
"""Mean Earth radius in metres (WGS84 mean radius), for great-circle work."""

FEET_TO_METRES = 0.3048
KNOTS_TO_METRES_PER_SECOND = 0.514444
FEET_PER_MINUTE_TO_METRES_PER_SECOND = 0.00508


class Point(StrictModel):
    """A position on the WGS84 ellipsoid.

    ``altitude_m`` is metres above the ellipsoid, not above ground and not above mean sea
    level. It is ``None`` when the source does not report altitude, and ``0.0`` only when
    the source actively says the object is at the surface.
    """

    lon: Longitude
    lat: Latitude
    altitude_m: float | None = Field(default=None, ge=-500.0, le=40_000_000.0)

    def distance_to_m(self, other: "Point") -> float:
        """Great-circle surface distance in metres, ignoring altitude.

        Haversine. Accurate to roughly 0.5% against the true ellipsoidal distance, which
        is far better than the positional accuracy of any feed here.
        """
        lat1, lat2 = math.radians(self.lat), math.radians(other.lat)
        dlat = lat2 - lat1
        dlon = math.radians(other.lon - self.lon)
        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))

    def project(self, *, bearing_deg: Bearing, distance_m: float) -> "Point":
        """Return the point reached by travelling ``distance_m`` along ``bearing_deg``.

        Used for dead reckoning: between server ticks the frontend advances an aircraft
        along its last known track so a five-second feed still looks like motion. Kept
        server-side too, for track-history gap filling.
        """
        ang = distance_m / EARTH_RADIUS_M
        brg = math.radians(bearing_deg)
        lat1, lon1 = math.radians(self.lat), math.radians(self.lon)

        lat2 = math.asin(
            math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg)
        )
        lon2 = lon1 + math.atan2(
            math.sin(brg) * math.sin(ang) * math.cos(lat1),
            math.cos(ang) - math.sin(lat1) * math.sin(lat2),
        )
        return Point(
            lon=(math.degrees(lon2) + 540.0) % 360.0 - 180.0,
            lat=math.degrees(lat2),
            altitude_m=self.altitude_m,
        )


class BoundingBox(StrictModel):
    """An axis-aligned geographic box.

    Antimeridian crossing is represented by ``west > east``, the same convention Cesium
    and GeoJSON bounding boxes use. :meth:`contains` handles it; naive comparisons do
    not, which is why callers must not reimplement this.
    """

    west: Longitude
    south: Latitude
    east: Longitude
    north: Latitude

    @model_validator(mode="after")
    def _check_latitudes(self) -> Self:
        if self.south > self.north:
            msg = f"south ({self.south}) must not exceed north ({self.north})"
            raise ValueError(msg)
        return self

    @property
    def crosses_antimeridian(self) -> bool:
        """Whether the box wraps past 180 degrees, leaving west numerically east of east."""
        return self.west > self.east

    def contains(self, point: Point) -> bool:
        """Whether a point falls inside the box, wrap across the antimeridian included."""
        if not (self.south <= point.lat <= self.north):
            return False
        if self.crosses_antimeridian:
            return point.lon >= self.west or point.lon <= self.east
        return self.west <= point.lon <= self.east

    @property
    def centre(self) -> Point:
        """Centre of the box, correct across the antimeridian."""
        lat = (self.south + self.north) / 2.0
        if self.crosses_antimeridian:
            span = (self.east + 360.0) - self.west
            lon = (self.west + span / 2.0 + 540.0) % 360.0 - 180.0
        else:
            lon = (self.west + self.east) / 2.0
        return Point(lon=lon, lat=lat)

    def enclosing_radius_m(self) -> float:
        """Radius in metres of a circle centred on :attr:`centre` that covers the box.

        Feeds like adsb.lol take a centre and a radius rather than a box, so a viewport
        query becomes the circumscribed circle plus server-side filtering. Corner
        distance is used because the widest point of a lat/lon box is its corner.
        """
        centre = self.centre
        corners = [
            Point(lon=self.west, lat=self.south),
            Point(lon=self.west, lat=self.north),
            Point(lon=self.east, lat=self.south),
            Point(lon=self.east, lat=self.north),
        ]
        return max(centre.distance_to_m(c) for c in corners)
