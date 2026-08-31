"""The satellite domain contract: one CelesTrak GP element set, ready to propagate.

Modelled from the recorded OMM JSON on disk, because CelesTrak was unreachable when the
source recon ran on 2026-08-20 (TCP 443 and 80 both dead from two independent networks,
with the site serving a week earlier, so the outage is theirs). While it is down the layer
reports itself unavailable with the reason, exactly as it would for a missing key.

Two real payloads back this contract and they were captured five months apart:
``tests/fixtures/celestrak_iss_omm.json`` (NORAD 25544, epoch 2026-08-19) and
``tests/fixtures/celestrak_catnr19548_omm_wayback20260310.json`` (NORAD 19548, epoch
2026-03-05). Both carry the identical 17 keys in the identical order, and every field below
was present on both: ``OBJECT_NAME``, ``OBJECT_ID``, ``EPOCH``, ``MEAN_MOTION``,
``ECCENTRICITY``, ``INCLINATION``, ``RA_OF_ASC_NODE``, ``ARG_OF_PERICENTER``,
``MEAN_ANOMALY``, ``EPHEMERIS_TYPE``, ``CLASSIFICATION_TYPE``, ``NORAD_CAT_ID``,
``ELEMENT_SET_NO``, ``REV_AT_EPOCH``, ``BSTAR``, ``MEAN_MOTION_DOT``, ``MEAN_MOTION_DDOT``.
The 28 element sets in ``tests/fixtures/celestrak_stations_tle_wayback20260407.txt`` (whose
content is actually the 2026-04-22 capture, so cite the epoch from inside the file) agree on
the same quantities in the older TLE encoding. CelesTrak sends the numerics as JSON
**numbers**; Space-Track sends the same fields as strings, which matters only if a second
provider ever lands.

``OBJECT_NAME`` and ``OBJECT_ID`` are optional even though both sampled records carried
them: CelesTrak documents that analyst objects in the 80000 series have neither.

**These are the mean elements the browser feeds to satellite.js, and nothing else.** Its
``json2satrec`` export takes CelesTrak OMM directly (verified against the ISS fixture at npm
7.1.0), so this contract carries no TLE strings and nothing here synthesises a line pair.
That is not a convenience: CelesTrak exhausted the 5-digit catalogue on 2026-07-11, the TLE
format has no room for a sixth digit, and every object catalogued since is unrepresentable
in it.

**No position field, deliberately.** The position is computed client-side from these
elements. A server-computed one would be a second source of truth for the same thing, and
they would drift.

**Nothing on an OMM record says an element set is decayed or unpropagatable, and this
contract does not pretend otherwise.** No source in phase 2 fills such a field, so there is
no field. Four real signals exist and the first two are what this contract carries:

1. **Absence from the group.** A decayed object stops appearing, so the store uses
   ``replace_all`` and the object leaves with it. Cheapest guard there is.
2. **Epoch staleness**, from :attr:`Satellite.epoch` against
   :data:`STALE_EPOCH_AGE_S`. Taken from CelesTrak's own ``OLDEST`` threshold rather than
   invented. Worth knowing why it matters: propagating the real ISS element set 365 days
   past its epoch still returns ``error = 0`` and a plausible 402 km altitude, so a clean
   error code is not evidence of a usable position.
3. **``propagate()`` returning null** with ``communityDecayCheckEnabled``, in the browser.
   ``satrec.error`` names the reason (6 decayed, 1 mean eccentricity out of range) but it is
   **mutated on the record by the most recent propagation**, so it is read immediately after
   the call and never cached.
4. **SATCAT ``DECAY_DATE`` and ``OPS_STATUS_CODE``**, a different endpoint on a daily
   cadence, not fetched in phase 2.

Guards 3 and 4 are the frontend's and a later phase's. Two things this contract does refuse
outright, because the element set itself proves it cannot be propagated: an eccentricity
outside 0 to 1 (``SatRecError`` 1) and a mean motion at or below zero (``SatRecError`` 2).
Those are dropped and counted at the adapter rather than rendered as a satellite underground.
"""

from datetime import datetime
from typing import Final, Literal

from pydantic import ConfigDict, Field

from tracker.contracts.base import StrictModel, UtcDatetime

STALE_EPOCH_AGE_S: Final = 3.5 * 24 * 60 * 60
"""How old an element set may be before it is treated as stale: 3.5 days.

CelesTrak's own number, not ours. Its ``OLDEST`` table flag shows objects whose GP data is
more than 3.5 days old, and its usage policy notes that on the active list that is normally
fewer than 50 objects out of 10,000-plus.
"""


class Satellite(StrictModel):
    """One GP element set, keyed on the NORAD catalogue number.

    Immutable, like every entity here. Field names are ours; the mapping from the OMM
    keyword to each one is in the adapter and only there.
    """

    # Non-finite floats are refused, not stored. Two holes without this: ``inf`` satisfies
    # ``mean_motion``'s ``gt=0.0`` and so defeats the one bound that refuses an
    # unpropagatable element set, and ``bstar``, ``mean_motion_dot`` and ``mean_motion_ddot``
    # carry no bounds at all because a real B* can be any sign. Both dump to JSON ``null``,
    # so accepting one publishes a ``/api/satellites`` response our own contract rejects and
    # hands satellite.js ``undefined`` where it needs a number.
    model_config = ConfigDict(allow_inf_nan=False)

    kind: Literal["satellite"] = "satellite"

    # Not capped at 5 digits: CelesTrak ran out of those on 2026-07-11, everything catalogued
    # since is 100000 or above, and 18 SPCS assigns analyst numbers above 799,500,000. A cap
    # at 99999 would start dropping new objects silently.
    norad_cat_id: int = Field(
        ge=1,
        le=999_999_999,
        description="NORAD catalogue number, the identity of the object. 1 to 9 digits, "
        "never zero-padded to a fixed width.",
    )
    object_name: str | None = Field(
        default=None,
        max_length=80,
        description="Name as published, e.g. 'ISS (ZARYA)'. Absent for analyst objects in "
        "the 80000 series, which carry no name at all.",
    )
    object_id: str | None = Field(
        default=None,
        max_length=20,
        description="International designator, e.g. 1998-067A. Also absent for analyst objects.",
    )
    classification_type: str = Field(
        pattern=r"^[UCS]$",
        description="U unclassified, C classified, S secret. Both sampled records read U.",
    )

    # CelesTrak sends EPOCH naive with six decimal places, no Z and no offset, and omits the
    # OMM TIME_SYSTEM keyword precisely because it is always UTC, so the adapter attaches it.
    # The Z on the wire is load-bearing rather than cosmetic: json2satrec appends a Z when the
    # string lacks one, so an offset-suffixed '+00:00' becomes '+00:00Z', new Date() rejects
    # it, and every satellite lands at NaN with nothing thrown. tests/contracts/
    # test_satellite.py asserts the suffix.
    epoch: UtcDatetime = Field(
        description="The instant these elements describe, UTC, serialised with a Z suffix.",
    )

    mean_motion: float = Field(
        gt=0.0,
        description="Revolutions per day, no conversion from the wire. At or below zero is "
        "SatRecError 2 and cannot be propagated, so it is refused rather than stored.",
    )
    eccentricity: float = Field(
        ge=0.0,
        lt=1.0,
        description="Dimensionless. Outside 0 to 1 is SatRecError 1, an element set SGP4 "
        "cannot propagate, so it is refused here.",
    )
    inclination_deg: float = Field(ge=0.0, le=180.0, description="Degrees.")
    ra_of_asc_node_deg: float = Field(
        ge=0.0,
        le=360.0,
        description="Right ascension of the ascending node, degrees. Not a compass bearing, "
        "so it is bounded explicitly rather than typed as one.",
    )
    arg_of_pericenter_deg: float = Field(ge=0.0, le=360.0, description="Degrees.")
    mean_anomaly_deg: float = Field(ge=0.0, le=360.0, description="Degrees.")
    bstar: float = Field(
        description="B* drag term, inverse earth radii. Zero on the recorded TDRS 3 record, "
        "which is a real value for a geostationary object and not a missing one.",
    )
    mean_motion_dot: float = Field(
        description="First derivative of mean motion, already halved by the provider. "
        "Negative on the recorded TDRS 3 record. Goes to satellite.js verbatim.",
    )
    mean_motion_ddot: float = Field(
        description="Second derivative, already sixthed by the provider. Zero on both "
        "recorded records.",
    )
    ephemeris_type: int = Field(
        ge=0,
        le=9,
        description="Always 0 on CelesTrak GP data, which means SGP4. Carried because it is "
        "part of the element set the propagator is handed.",
    )
    element_set_no: int = Field(
        ge=0,
        description="Element set number. Both recorded records read 999.",
    )
    rev_at_epoch: int = Field(
        ge=0,
        description="Revolution number at epoch. 58157 on the recorded ISS record, so the "
        "5-digit TLE column is already at its limit here too.",
    )

    group: str = Field(
        min_length=1,
        max_length=40,
        description="The CelesTrak group this element set was fetched from, e.g. stations. "
        "Provenance, and the reason two overlapping groups cannot double-count an object: "
        "the store is keyed on the catalogue number, not on the group.",
    )
    fetched_at: UtcDatetime = Field(
        description="When we fetched this element set. Distinct from epoch, which is when "
        "the elements were fitted: the fetch says how current our copy is, the epoch says "
        "how current the orbit determination is, and only the second one decides whether a "
        "propagated position is worth drawing.",
    )
    source: str = Field(
        min_length=1,
        max_length=40,
        description="Which adapter produced this record, e.g. celestrak. Shown as attribution.",
    )

    # Plain property and a method, NOT pydantic computed fields, for the reason set out at
    # contracts/aircraft.py:160: a computed field serialises but is then rejected by
    # extra="forbid", so our own published wire format could not be re-validated.

    def epoch_age_s(self, now: datetime) -> float:
        """Seconds between the element set's epoch and ``now``.

        Takes the clock rather than reading it, so a test asserts a boundary instead of
        approximating one.
        """
        return (now - self.epoch).total_seconds()

    def is_stale_at(self, now: datetime) -> bool:
        """Whether these elements are older than CelesTrak's own 3.5-day threshold."""
        return self.epoch_age_s(now) > STALE_EPOCH_AGE_S

    @property
    def label(self) -> str:
        """Best available human label, falling back to the catalogue number."""
        return self.object_name or str(self.norad_cat_id)
