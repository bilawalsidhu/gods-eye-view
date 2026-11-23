#!/usr/bin/env python3
"""Independent satellite reference for the Sky view worker.

NOTE: provenance record, not run by the tests. satCore.test.mjs and passes.test.mjs read the
committed satReference.json / passReference.json. The fixture satFixture200.tle was
produced from a CelesTrak GP CSV export (the satFixture200.csv named below, which is not
committed) by writing each row as a three-line TLE (name, line 1, line 2) with the
usual TLE checksum; the script reads that GP CSV, so re-running needs your own export
plus the pinned Python packages.

Builds (1) a 200-object GP CSV fixture from the cached CelesTrak `active`
group (ISS, one GEO, one Molniya and one Starlink forced in, the rest a seeded
random draw) and (2) Skyfield/sgp4 topocentric az/el/range plus the sunlit
flag at five instants for an observer in Houston at height 0 m (the same
height lookAnglesAt() uses). satCore.test.mjs compares the JS worker against
these committed numbers.

Usage (venv with the pinned versions printed into the output):
  python build_sat_reference.py <celestrak-active.json> <out-dir>
Needs de421.bsp (JPL) for the Sun position; Skyfield downloads it once.
"""
import csv
import io
import json
import random
import sys
from datetime import datetime

import numpy
import sgp4
import skyfield
from skyfield.api import EarthSatellite, load, wgs84

OBSERVER = {"latDeg": 29.7604, "lonDeg": -95.3698, "heightM": 0.0}
TIMES = [
    "2026-10-11T03:00:00Z",
    "2026-10-11T12:00:00Z",
    "2026-10-12T00:30:00Z",
    "2026-10-12T11:15:00Z",
    "2026-10-13T02:00:00Z",
]
SEED = 20261011
FORCED = {"iss": 25544}
TERMINATOR_WINDOW_S = 5


def main(active_json, out_dir):
    body = json.load(open(active_json))["body"]
    rows = list(csv.DictReader(io.StringIO(body.replace("\r\n", "\n"))))
    header = body.split("\r\n", 1)[0]
    by_id = {int(r["NORAD_CAT_ID"]): r for r in rows}

    def first(pred):
        for r in rows:
            if pred(r):
                return int(r["NORAD_CAT_ID"])
        raise SystemExit("no match")

    picks = [FORCED["iss"]]
    # GEO: mean motion ~1 rev/day, low eccentricity and inclination.
    picks.append(first(lambda r: abs(float(r["MEAN_MOTION"]) - 1.0027) < 0.002
                       and float(r["ECCENTRICITY"]) < 0.001 and float(r["INCLINATION"]) < 1))
    # Molniya orbit (12 h, e ~0.7, i ~63.4 deg); no object is NAMED Molniya
    # in today's active list, the Meridian/EKS/Arktika satellites fly it.
    picks.append(first(lambda r: float(r["ECCENTRICITY"]) > 0.6 and 62 < float(r["INCLINATION"]) < 65
                       and 1.95 < float(r["MEAN_MOTION"]) < 2.05))
    picks.append(first(lambda r: r["OBJECT_NAME"].startswith("STARLINK")))
    rng = random.Random(SEED)
    rest = sorted(i for i in by_id if i not in picks)
    picks += rng.sample(rest, 200 - len(picks))
    fixture = [by_id[i] for i in picks]

    cols = header.split(",")
    lines = [header] + [",".join(r[c] for c in cols) for r in fixture]
    with open(f"{out_dir}/satFixture200.csv", "w", newline="") as fh:
        fh.write("\r\n".join(lines) + "\r\n")

    ts = load.timescale(builtin=True)
    eph = load("de421.bsp")
    here = wgs84.latlon(OBSERVER["latDeg"], OBSERVER["lonDeg"], elevation_m=OBSERVER["heightM"])
    objects = []
    for r in fixture:
        sat = EarthSatellite.from_omm(ts, r)
        samples = []
        for iso in TIMES:
            t = ts.from_datetime(datetime.fromisoformat(iso.replace("Z", "+00:00")))
            topo = (sat - here).at(t)
            alt, az, dist = topo.altaz()
            window = ts.tt_jd(t.tt + numpy.array([-TERMINATOR_WINDOW_S, 0, TERMINATOR_WINDOW_S]) / 86400.0)
            lit = sat.at(window).is_sunlit(eph)
            samples.append({
                "t": iso,
                "azDeg": round(float(az.degrees), 6),
                "elDeg": round(float(alt.degrees), 6),
                "rangeKm": round(float(dist.km), 4),
                "sunlit": bool(lit[1]),
                "terminator": bool(lit[0] != lit[1] or lit[2] != lit[1]),
            })
        objects.append({"noradId": int(r["NORAD_CAT_ID"]), "name": r["OBJECT_NAME"], "samples": samples})

    out = {
        "generatedBy": "build_sat_reference.py",
        "versions": {"skyfield": skyfield.__version__, "sgp4": sgp4.__version__,
                     "numpy": numpy.__version__, "python": sys.version.split()[0],
                     "ephemeris": "de421.bsp", "timescale": "builtin"},
        "observer": OBSERVER,
        "times": TIMES,
        "seed": SEED,
        "forced": {"iss": picks[0], "geo": picks[1], "molniya": picks[2], "starlink": picks[3]},
        "terminatorWindowS": TERMINATOR_WINDOW_S,
        "objects": objects,
    }
    with open(f"{out_dir}/satReference.json", "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
        fh.write("\n")
    print(json.dumps(out["versions"]), out["forced"], len(objects))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
