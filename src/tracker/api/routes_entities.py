"""REST reads for live entity layers.

These are snapshot endpoints. They exist because a client needs a starting picture before
the WebSocket has had time to deliver deltas, and because they make the whole system
inspectable with curl, which is worth a great deal when a feed misbehaves.

They read the store and never touch an upstream. A browser refresh must not turn into an
upstream request, or a page reload loop becomes a denial of service against a free
provider.
"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from tracker.api.state import StateDep
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import StrictModel
from tracker.contracts.geo import BoundingBox
from tracker.contracts.messages import FeedHealth

router = APIRouter(prefix="/api", tags=["entities"])


class AircraftSnapshot(StrictModel):
    """Every aircraft currently held, optionally filtered to a viewport."""

    count: int
    aircraft: tuple[Aircraft, ...]


class LayerSummary(StrictModel):
    """Counts and health per layer, for the layer rail and the degraded banners."""

    layers: dict[str, int]
    feeds: tuple[FeedHealth, ...]


def _optional_box(
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> BoundingBox | None:
    """Build a bounding box only when all four edges were supplied.

    Partial boxes are rejected rather than guessed at: silently defaulting a missing edge
    to the world would return every aircraft to a client that believed it was filtering.
    """
    if west is None and south is None and east is None and north is None:
        return None
    if west is None or south is None or east is None or north is None:
        raise HTTPException(
            status_code=422,
            detail="a bounding box needs all four of west, south, east and north",
        )
    return BoundingBox(west=west, south=south, east=east, north=north)


@router.get("/aircraft", response_model=AircraftSnapshot)
async def list_aircraft(
    state: StateDep,
    *,
    west: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    south: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    east: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    north: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    military_only: Annotated[bool, Query()] = False,
) -> AircraftSnapshot:
    """Aircraft currently known to the server.

    Military aircraft are held in their own store because they come from a separate
    worldwide endpoint rather than the viewport query, and merging them into one store
    would let a global feed evict the local one every poll.
    """
    box = _optional_box(west, south, east, north)
    records = state.military.snapshot() if military_only else state.aircraft.snapshot()
    if box is not None:
        records = tuple(a for a in records if box.contains(a.point))
    return AircraftSnapshot(count=len(records), aircraft=records)


@router.get("/aircraft/{icao24}", response_model=Aircraft | None)
async def get_aircraft(state: StateDep, icao24: str) -> Aircraft | None:
    """One aircraft by ICAO address, from either store. ``null`` when not currently seen."""
    key = icao24.strip().lower()
    return state.aircraft.get(key) or state.military.get(key)


@router.get("/layers", response_model=LayerSummary)
async def layer_summary(state: StateDep) -> LayerSummary:
    """Entity counts per layer plus upstream health, for the layer rail."""
    return LayerSummary(
        layers={"aircraft": len(state.aircraft), "military": len(state.military)},
        feeds=state.pollers.health(),
    )
