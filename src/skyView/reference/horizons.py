#!/usr/bin/env python3
"""Fetch JPL Horizons topocentric apparent (airless) az/el + Moon illumination rows
for the Sky view ephemeris test (GEV P3a). Run once by hand; the raw
rows are pasted into ephemeris.test.mjs together with the query below.

  python3 horizons.py > horizons.json   (stdlib only; network needed)
"""
import json
import sys
import urllib.parse
import urllib.request

API = 'https://ssd.jpl.nasa.gov/api/horizons.api'
BODIES = {'Sun': '10', 'Moon': '301', 'Venus': '299', 'Jupiter': '599', 'Saturn': '699'}
CASES = [
    {'site': 'Houston', 'lon': -95.3698, 'lat': 29.7604, 'km': 0.015, 'utc': '2026-12-01 03:00'},
    {'site': 'Sydney', 'lon': 151.2093, 'lat': -33.8688, 'km': 0.050, 'utc': '2031-06-15 12:00'},
    {'site': 'Reykjavik', 'lon': -21.9426, 'lat': 64.1466, 'km': 0.030, 'utc': '2036-03-20 22:00'},
]

out = []
for case in CASES:
    for name, command in BODIES.items():
        params = {
            'format': 'json',
            'COMMAND': f"'{command}'",
            'OBJ_DATA': "'NO'",
            'MAKE_EPHEM': "'YES'",
            'EPHEM_TYPE': "'OBSERVER'",
            'CENTER': "'coord@399'",
            'COORD_TYPE': "'GEODETIC'",
            'SITE_COORD': f"'{case['lon']},{case['lat']},{case['km']}'",
            'TLIST': f"'{case['utc']}'",
            'TLIST_TYPE': "'CAL'",
            'TIME_TYPE': "'UT'",
            'QUANTITIES': "'4,10'",
            'ANG_FORMAT': "'DEG'",
            'APPARENT': "'AIRLESS'",
            'EXTRA_PREC': "'YES'",
            'CSV_FORMAT': "'YES'",
        }
        url = API + '?' + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = json.load(response)
        text = payload['result']
        body = text.split('$$SOE')[1].split('$$EOE')[0].strip()
        header = text.split('$$SOE')[0].strip().splitlines()[-2]
        out.append({'site': case['site'], 'utc': case['utc'], 'body': name,
                    'header': header.strip(), 'row': body,
                    'version': payload.get('signature', {}).get('version')})
        print(case['site'], case['utc'], name, body, file=sys.stderr)
json.dump({'cases': CASES, 'rows': out}, sys.stdout, indent=1)
