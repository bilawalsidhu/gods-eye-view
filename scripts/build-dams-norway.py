#!/usr/bin/env python3
"""Maintainer-only build of the Norwegian dam supplement (standard library only).

Reads every registered dam from NVE's hydropower map service (layer Dam_N250
of Vannkraft1, which also holds dams built for other purposes), translates
NVE's code lists to English, and writes one GeoJSON Point per dam to
src/data/local_data/dams/norway.geojsonl with its SHA-256. Names of dams,
power plants, reservoirs and places stay Norwegian; names NVE stores in
capitals are written in normal case.

An unknown code value stops the build rather than being guessed: extend the
tables below. NVE updates the register daily, so a rebuild may differ; use
--verify to check the committed file against its checksum and schema without
network access.

Data: NVE, Norwegian Licence for Open Government Data (NLOD).
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / 'src/data/local_data/dams'
OUTPUT = PACK / 'norway.geojsonl'
CHECKSUM = PACK / 'norway.sha256'
SERVICE = 'https://kart.nve.no/enterprise/rest/services/Vannkraft1/MapServer/1/query'
PAGE = 2000
USER_AGENT = 'gods-eye-view-build (+https://github.com/bilawalsidhu/gods-eye-view)'

PURPOSES = {
    'Kraftproduksjon': 'Hydropower',
    'Vannforsyning': 'Water supply',
    'Akvakultur - settefisk': 'Aquaculture (hatchery)',
    'Akvakultur': 'Aquaculture',
    'Jordvanning': 'Irrigation',
    'Rekreasjon': 'Recreation',
    'Flomdempning': 'Flood control',
    'Tidligere fløtning': 'Former timber floating',
    'Tidligere isproduksjon': 'Former ice production',
    'Kraftverk nedlagt/ute av drift': 'Former hydropower',
    'Slamdam': 'Tailings',
    'Sedimenteringsdam': 'Sedimentation',
    'Snøproduksjon': 'Snowmaking',
    'Andre': 'Other',
    'Annet': 'Other',
    'Ukjent': 'Unknown',
}
DAM_TYPES = {
    1: 'Aluminium', 2: 'Other', 3: 'Concrete', 4: 'Fibre cement', 5: 'Earthfill',
    6: 'Lightweight aggregate', 7: 'Masonry', 8: 'Rockfill', 9: 'Timber', 11: None,
}
# Code 4 is used by two dams but absent from NVE's published code list: left blank.
FUNCTIONS = {1: 'Intake dam', 2: 'Saddle dam', 3: 'Spillway dam', 4: None, 6: None, 7: 'Main dam'}
SETTINGS = {
    1: 'Reservoir', 2: 'Regulated lake', 3: 'River', 4: 'Stream intake',
    6: 'Intake reservoir', 7: None,
}
STATUSES = {'D': 'In operation'}
ROMAN = re.compile(r'^[IVX]+$')


def fetch_page(offset):
    query = urllib.parse.urlencode({
        'where': '1=1', 'outFields': '*', 'returnGeometry': 'true', 'outSR': '4326',
        'orderByFields': 'objectid', 'resultOffset': offset, 'resultRecordCount': PAGE,
        'f': 'json',
    })
    request = urllib.request.Request(f'{SERVICE}?{query}', headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    if 'error' in payload:
        raise RuntimeError(f'NVE error: {payload["error"]}')
    return payload


def fetch_all():
    features, offset = [], 0
    while True:
        page = fetch_page(offset)
        features.extend(page.get('features', []))
        if not page.get('exceededTransferLimit') and len(page.get('features', [])) < PAGE:
            return features
        offset += PAGE


def text(value):
    value = re.sub(r'\s+', ' ', str(value or '')).strip()
    return value or None


def normal_case(value):
    """'BJORDAL KRAFT II INNTAKSDAM' -> 'Bjordal Kraft II Inntaksdam'; mixed case is kept."""
    value = text(value)
    if not value or value != value.upper():
        return value
    return ' '.join(
        word if ROMAN.match(word) else word[:1] + word[1:].lower()
        for word in value.split(' ')
    )


def lookup(table, code, field):
    if code is None:
        return None
    if code not in table:
        raise ValueError(f'Unknown {field} code {code!r}: extend the table in this script')
    return table[code]


def record(feature):
    a = feature['attributes']
    g = feature.get('geometry') or {}
    lon, lat = g.get('x'), g.get('y')
    if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
        return None
    purposes = []
    for part in (a.get('damformal_liste') or '').split(','):
        part = text(part)
        if part:
            english = lookup(PURPOSES, part, 'purpose')
            if english not in purposes:
                purposes.append(english)
    name = normal_case(a.get('damnavn'))
    catchment = text(a.get('nedborfelt'))
    # The layer's shared card and analyst code read the river from this tag.
    tags = {'associated_river': catchment} if catchment else {}
    nve = {
        'damNumber': a.get('damnr'),
        'purpose': purposes,
        'damType': lookup(DAM_TYPES, a.get('damhovedtype'), 'dam type'),
        'function': lookup(FUNCTIONS, a.get('damfunksjon'), 'function'),
        'setting': lookup(SETTINGS, a.get('damkategori'), 'category'),
        'built': a.get('idriftsattaar'),
        'reservoir': normal_case(a.get('magasinnavn')),
        'powerPlant': normal_case(a.get('vannkraftverknavn')),
        'municipality': text(a.get('kommunenavn')),
        'county': text(a.get('fylke')),
    }
    # Only dams in operation are expected; anything else stops the build.
    lookup(STATUSES, a.get('status'), 'status')
    return {
        'objectid': a['objectid'],
        'feature': {
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [round(lon, 5), round(lat, 5)]},
            'properties': {
                'name': name,
                'tags': tags,
                'source': 'nve',
                'nve': {k: v for k, v in nve.items() if v not in (None, [], '')},
            },
        },
    }


def build(raw):
    rows = [r for r in (record(f) for f in raw) if r]
    numbers = {}
    for row in rows:
        number = row['feature']['properties']['nve'].get('damNumber')
        numbers[number] = numbers.get(number, 0) + 1
    for row in rows:
        number = row['feature']['properties']['nve'].get('damNumber')
        unique = number is not None and numbers[number] == 1
        row['feature']['id'] = f'nve-dam-{number}' if unique else f'nve-dam-o{row["objectid"]}'
    rows.sort(key=lambda row: row['feature']['id'])
    lines = [json.dumps({'id': r['feature']['id'], **r['feature']}, ensure_ascii=False,
                        separators=(',', ':')) for r in rows]
    return ('\n'.join(lines) + '\n').encode('utf-8')


def validate(raw):
    ids = set()
    lines = raw.decode('utf-8').splitlines()
    for line in lines:
        feature = json.loads(line)
        lon, lat = feature['geometry']['coordinates']
        if not (-11 <= lon <= 35 and 57 <= lat <= 81.5):
            raise ValueError(f'{feature["id"]} lies outside Norway and Svalbard')
        if feature['id'] in ids:
            raise ValueError(f'Duplicate id {feature["id"]}')
        ids.add(feature['id'])
    return len(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true',
                        help='check the committed file against its checksum, offline')
    args = parser.parse_args()
    if args.verify:
        raw = OUTPUT.read_bytes()
        expected = CHECKSUM.read_text(encoding='utf-8').split()[0]
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected:
            raise SystemExit(f'SHA-256 mismatch: {digest}')
        print(json.dumps({'records': validate(raw), 'sha256': digest}))
        return
    raw = build(fetch_all())
    count = validate(raw)
    digest = hashlib.sha256(raw).hexdigest()
    OUTPUT.write_bytes(raw)
    CHECKSUM.write_text(f'{digest}  norway.geojsonl\n', encoding='utf-8', newline='\n')
    print(json.dumps({'records': count, 'sha256': digest}))


if __name__ == '__main__':
    main()
