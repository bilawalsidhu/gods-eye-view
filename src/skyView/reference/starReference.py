#!/usr/bin/env python3
"""Independent reference az/el for the Sky view star maths (GEV P3a).

Run once by hand (network needed the first time, to download de421.bsp and the
original 1997 Hipparcos main catalogue from CDS); the numbers it prints are
committed as starReference.fixture.json and the unit test compares
src/skyView/skyMath.js against them with NO network.

  python3 -m venv venv && ./venv/bin/pip install skyfield==1.53 pandas
  ./venv/bin/python starReference.py > starReference.fixture.json

Reference = Skyfield apparent topocentric position (proper motion, precession,
nutation, annual aberration, light deflection), alt/az WITHOUT refraction.
Star data = Hipparcos 1997 main catalogue (hip_main.dat, ESA SP-1200), which
is independent of the HYG v4.4 numbers bundled in GEV. skyMath.js ignores
nutation and aberration on purpose, so differences up to
about 0.01 deg are expected; the acceptance tolerance is 0.02 deg.
"""
import json
import sys

import skyfield
from skyfield.api import Loader, Star, wgs84
from skyfield.data import hipparcos

load = Loader('.')
ts = load.timescale()
eph = load('de421.bsp')
earth = eph['earth']
with load.open(hipparcos.URL) as handle:
    catalogue = hipparcos.load_dataframe(handle)

STARS = {'Vega': 91262, 'Arcturus': 69673, 'Rigel': 24436}
SITES = [
    {'name': 'Houston', 'latDeg': 29.7604, 'lonDeg': -95.3698, 'heightM': 15},
    {'name': 'Reykjavik', 'latDeg': 64.1466, 'lonDeg': -21.9426, 'heightM': 30},
    {'name': 'Sydney', 'latDeg': -33.8688, 'lonDeg': 151.2093, 'heightM': 50},
]
DATES = ['2026-10-12T03:00:00Z', '2031-01-15T12:00:00Z', '2036-07-04T20:00:00Z']


def parse(iso):
    date, time = iso.rstrip('Z').split('T')
    y, mo, d = (int(v) for v in date.split('-'))
    h, mi, s = (int(v) for v in time.split(':'))
    return ts.utc(y, mo, d, h, mi, s)


rows = []
for star_name, hip in STARS.items():
    star = Star.from_dataframe(catalogue.loc[hip])
    for site in SITES:
        topos = wgs84.latlon(site['latDeg'], site['lonDeg'], elevation_m=site['heightM'])
        observer = earth + topos
        for iso in DATES:
            t = parse(iso)
            alt, az, _ = observer.at(t).observe(star).apparent().altaz()
            rows.append({
                'star': star_name,
                'hip': hip,
                'site': site['name'],
                'utc': iso,
                'azDeg': round(az.degrees, 6),
                'elDeg': round(alt.degrees, 6),
            })

out = {
    'source': 'Skyfield %s, de421.bsp, Hipparcos 1997 main catalogue (hip_main.dat via CDS)' % skyfield.__version__,
    'method': 'observer.at(t).observe(Star.from_dataframe(hip)).apparent().altaz() - no refraction',
    'script': 'src/skyView/reference/starReference.py',
    'sites': SITES,
    'dates': DATES,
    'rows': rows,
}
json.dump(out, sys.stdout, indent=1)
sys.stdout.write('\n')
