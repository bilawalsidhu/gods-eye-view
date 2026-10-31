#!/usr/bin/env python3
"""Independent ISS pass reference for Sky view passes.js.

NOTE: provenance record, not run by the tests. satCore.test.mjs and passes.test.mjs read the
committed satReference.json / passReference.json. The fixture satFixture200.tle was
produced from a CelesTrak GP CSV export (the satFixture200.csv named below, which is not
committed) by writing each row as a three-line TLE (name, line 1, line 2) with the
usual TLE checksum; the script reads that GP CSV, so re-running needs your own export
plus the pinned Python packages.

Skyfield find_events() at altitude 10 deg (the passes panel minElev) for the
ISS element set in satFixture200.csv, five passes from START at each of three
observers (latitude 0, 30, 60 N; longitude -95.37; height 0 m, the height
lookAnglesAt() uses). For each pass: rise / culmination / set times, the
culmination altitude, and the minimum Sun altitude over the pass sampled every
10 s (so the test can pick passes that are wholly in daylight).
passes.test.mjs compares the JS pass finder against these committed numbers;
nothing here runs at test time.

Usage (a venv with the pinned versions, versions are written into the output):
  python build_pass_reference.py <satFixture200.csv> <de421.bsp> <out.json>
"""
import csv
import json
import sys
from datetime import datetime, timedelta

import numpy
import sgp4
import skyfield
from skyfield.api import EarthSatellite, load, wgs84

START = "2026-10-11T06:00:00Z"
LATITUDES = [0.0, 30.0, 60.0]
LON_DEG = -95.37
MIN_ELEV_DEG = 10.0
PASSES_PER_SITE = 5
ISS = 25544


def iso(t):
    return t.utc_datetime().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def main(fixture_csv, de421, out_path):
    with open(fixture_csv, newline="") as fh:
        rows = list(csv.DictReader(fh))
    row = next(r for r in rows if int(r["NORAD_CAT_ID"]) == ISS)
    ts = load.timescale(builtin=True)
    sat = EarthSatellite.from_omm(ts, row)
    eph = load(de421)
    sun, earth = eph["sun"], eph["earth"]
    t0 = ts.from_datetime(datetime.fromisoformat(START.replace("Z", "+00:00")))
    t1 = ts.from_datetime(t0.utc_datetime() + timedelta(days=4))
    sites = []
    for lat in LATITUDES:
        site = wgs84.latlon(lat, LON_DEG, elevation_m=0.0)
        times, events = sat.find_events(site, t0, t1, altitude_degrees=MIN_ELEV_DEG)
        passes = []
        current = None
        for t, e in zip(times, events):
            if e == 0:
                current = {"rise": t}
            elif e == 1 and current is not None:
                alt, az, _ = (sat - site).at(t).altaz()
                # keep the highest culmination if a pass has two
                if "peak" not in current or alt.degrees > current["peakElevDeg"]:
                    current["peak"] = t
                    current["peakElevDeg"] = alt.degrees
                    current["peakAzDeg"] = az.degrees
            elif e == 2 and current is not None and "peak" in current:
                current["set"] = t
                span = (t - current["rise"]) * 86400.0
                n = max(2, int(span // 10) + 1)
                samples = ts.linspace(current["rise"], t, n)
                sun_alt = (earth + site).at(samples).observe(sun).apparent().altaz()[0].degrees
                sunlit = sat.at(samples).is_sunlit(eph)
                passes.append(
                    {
                        "riseIso": iso(current["rise"]),
                        "peakIso": iso(current["peak"]),
                        "setIso": iso(t),
                        "peakElevDeg": round(float(current["peakElevDeg"]), 4),
                        "peakAzDeg": round(float(current["peakAzDeg"]), 4),
                        "minSunAltDeg": round(float(numpy.min(sun_alt)), 3),
                        "maxSunAltDeg": round(float(numpy.max(sun_alt)), 3),
                        "anySunlit": bool(numpy.any(sunlit)),
                    }
                )
                current = None
            if len(passes) >= PASSES_PER_SITE:
                break
        sites.append({"latDeg": lat, "lonDeg": LON_DEG, "heightM": 0.0, "passes": passes})
    out = {
        "generatedBy": "build_pass_reference.py",
        "versions": {
            "python": sys.version.split()[0],
            "skyfield": skyfield.__version__,
            "sgp4": sgp4.__version__,
            "numpy": numpy.__version__,
            "ephemeris": "de421.bsp",
            "timescale": "builtin",
        },
        "noradId": ISS,
        "epoch": row["EPOCH"],
        "start": START,
        "minElevDeg": MIN_ELEV_DEG,
        "sites": sites,
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:4])
