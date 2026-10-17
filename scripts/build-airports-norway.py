#!/usr/bin/env python3
"""Maintainer-only build of the bundled Norwegian airports layer (osmium-tool).

Downloads a pinned Geofabrik Norway extract, verifies its MD5, and writes
airports.geojsonl:

- every `aeroway=aerodrome` inside Geofabrik's Norway boundary that carries a
  Norwegian ICAO location indicator (EN..) and is not disused or abandoned,
  as its mapped area (or point), with a short allow-list of tags and its
  Norwegian name (`name:no`, else `name`) as the label;
- each such aerodrome's `aeroway=runway` ways, drawn as runway surfaces from
  their centreline and `width` (DEFAULT_RUNWAY_WIDTH_M when untagged);
- new Bodø Airport, which OpenStreetMap maps as construction: the site, the
  runway and the terminal, with Avinor's published project facts (NEW_BODO).

Runways, the terminal and the construction site carry `role` so the layer
draws them without a stem or card of their own.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
EXTRACT = 'norway-261005'
GEOFABRIK = 'https://download.geofabrik.de/europe/'
DATASET = ROOT / 'src/data/local_data/airports/airports.geojsonl'
ICAO = re.compile(r'^EN[A-Z]{2}$')
KEEP_TAGS = ['name', 'name:en', 'icao', 'iata', 'operator', 'aerodrome:type', 'ele', 'wikidata']
RUNWAY_TAGS = ['ref', 'surface', 'width', 'length']
DEFAULT_RUNWAY_WIDTH_M = 30
RUNWAY_SEARCH_M = 3000
UNDER_CONSTRUCTION = '#ffb000'

# Avinor's project facts (avinor.no, January 2026 project brief): runway
# 2,750 m about 900 m south-west of today's, 24,000 m2 terminal, trial
# operation from the second half of 2029. OSM maps the new runway without a
# width; ICAO code-4 runways, like today's at Bodø, are 45 m wide.
NEW_BODO = {
    'site': 'w714425964',
    'runway': 'w1019473337',
    'terminal': 'w539307318',
    'runway_width_m': 45,
    'tags': {
        'name': 'Nye Bodø lufthavn',
        'name:en': 'New Bodø Airport',
        'operator': 'Avinor',
        'status': 'under construction',
        'opening': '2029',
        'runway_length': '2750 m',
        'description': 'Replaces today\'s Bodø lufthavn ~900 m south-west of the current runway; '
                       'trial operation planned for the second half of 2029.',
    },
}


def fetch(url, target):
    if not target.exists():
        with urllib.request.urlopen(url) as response, open(str(target) + '.part', 'wb') as out:
            shutil.copyfileobj(response, out)
        Path(str(target) + '.part').rename(target)
    return target


def md5(path):
    digest = hashlib.md5()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def read_poly(path):
    """Geofabrik .poly -> list of (ring, is_hole)."""
    rings, ring, hole = [], None, False
    for raw in path.read_text().splitlines()[1:]:
        line = raw.strip()
        if ring is None:
            if line and line != 'END':
                ring, hole = [], line.startswith('!')
        elif line == 'END':
            rings.append((ring, hole))
            ring = None
        elif line:
            lon, lat = (float(v) for v in line.split())
            ring.append((lon, lat))
    return rings


def in_ring(ring, lon, lat):
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def inside(rings, lon, lat):
    return any(in_ring(r, lon, lat) for r, h in rings if not h) and \
        not any(in_ring(r, lon, lat) for r, h in rings if h)


def points(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [coordinates]
    return [p for part in coordinates for p in points(part)]


def centre(geometry):
    pts = points(geometry['coordinates'])
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def metres(a, b):
    dx = (b[0] - a[0]) * 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot(dx, (b[1] - a[1]) * 110540)


def typed_key(feature):
    key = feature['id']
    if key[0] == 'a':  # osmium area id: way * 2 or relation * 2 + 1
        number = int(key[1:])
        return ('w%d' % (number // 2)) if number % 2 == 0 else ('r%d' % (number // 2))
    return key


def runway_surface(line, width_m):
    """Buffer a centreline into a flat-ended runway polygon (local metric frame)."""
    lat0 = sum(p[1] for p in line) / len(line)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    xy = [(p[0] * kx, p[1] * ky) for p in line]
    half = width_m / 2
    left, right = [], []
    for i, (x, y) in enumerate(xy):
        a, b = xy[max(0, i - 1)], xy[min(len(xy) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length * half, dx / length * half
        left.append((x + nx, y + ny))
        right.append((x - nx, y - ny))
    ring = left + right[::-1]
    ring.append(ring[0])
    return {'type': 'Polygon',
            'coordinates': [[[round(x / kx, 7), round(y / ky, 7)] for x, y in ring]]}


def width_of(tags, fallback):
    try:
        width = float(str(tags.get('width', '')).replace('m', '').strip())
        return width if 10 <= width <= 100 else fallback
    except ValueError:
        return fallback


def export(osmium, pbf, cache):
    filtered = cache / (EXTRACT + '-airports.osm.pbf')
    exported = cache / (EXTRACT + '-airports.geojsonseq')
    subprocess.run([osmium, 'tags-filter', '-O', '-o', str(filtered), str(pbf),
                    'nwr/aeroway=aerodrome', 'w/aeroway=runway',
                    'nwr/construction=airport,airport_terminal,runway'], check=True)
    subprocess.run([osmium, 'export', '-O', '-f', 'geojsonseq', '--add-unique-id=type_id',
                    '-o', str(exported), str(filtered)], check=True)
    features = {}
    for line in exported.read_text().splitlines():
        line = line.lstrip('\x1e').strip()
        if not line:
            continue
        feature = json.loads(line)
        key = typed_key(feature)
        # A closed way exports as both a line and an area; keep the area.
        if key in features and feature['geometry']['type'] == 'LineString' \
                and feature['id'][0] == 'w' and features[key]['geometry']['type'] != 'LineString':
            continue
        if feature['geometry']['type'] == 'MultiPolygon' and len(feature['geometry']['coordinates']) == 1:
            feature['geometry'] = {'type': 'Polygon', 'coordinates': feature['geometry']['coordinates'][0]}
        if key in features and features[key]['geometry']['type'] != 'LineString' \
                and feature['geometry']['type'] == 'LineString':
            continue
        features[key] = feature
    return features


def rounded(geometry):
    def walk(value):
        if isinstance(value[0], (int, float)):
            return [round(value[0], 7), round(value[1], 7)]
        return [walk(v) for v in value]
    return {'type': geometry['type'], 'coordinates': walk(geometry['coordinates'])}


def build(features, rings):
    aerodromes = []
    for key, feature in features.items():
        tags = feature['properties']
        if tags.get('aeroway') != 'aerodrome' or not ICAO.match(tags.get('icao', '')):
            continue
        if any(k.startswith(('disused', 'abandoned')) for k in tags) or tags.get('aerodrome:type') == 'disused':
            continue
        if not inside(rings, *centre(feature['geometry'])):
            continue
        aerodromes.append((key, feature))
    aerodromes.sort(key=lambda item: item[1]['properties']['icao'])
    if len({f['properties']['icao'] for _, f in aerodromes}) != len(aerodromes):
        raise ValueError('Duplicate ICAO indicator')

    out = []

    def emit(key, geometry, properties, part=None):
        osm_id = int(key[1:]) * (-1 if key[0] == 'r' else 1)
        out.append({'id': '%d:%s' % (osm_id, part) if part else osm_id, 'type': 'Feature',
                    'geometry': rounded(geometry),
                    'properties': {'id': len(out) + 1, 'osm_id': osm_id, **properties}})

    def keep(tags, names):
        return {k: tags[k] for k in names if str(tags.get(k, '')).strip()}

    runways = [(k, f) for k, f in features.items()
               if f['properties'].get('aeroway') == 'runway' and f['geometry']['type'] == 'LineString']
    used = set()
    report = []
    for key, feature in aerodromes:
        tags = feature['properties']
        # The Norwegian name labels the site; `name` may also carry Sámi.
        label = str(tags.get('name:no') or tags.get('name') or '').strip()
        emit(key, feature['geometry'], {'type': 'aerodrome', **({'name': label} if label else {}),
                                        'tags': keep(tags, KEEP_TAGS)})
        polygon = feature['geometry']['type'] in ('Polygon', 'MultiPolygon')
        polys = [feature['geometry']['coordinates']] if feature['geometry']['type'] == 'Polygon' \
            else feature['geometry']['coordinates'] if polygon else []
        here = centre(feature['geometry'])
        count = 0
        for rkey, runway in runways:
            if rkey in used:
                continue
            mid = centre(runway['geometry'])
            hit = any(in_ring(poly[0], *mid) for poly in polys) if polygon \
                else metres(here, mid) <= RUNWAY_SEARCH_M
            if not hit:
                continue
            used.add(rkey)
            count += 1
            rtags = runway['properties']
            emit(rkey, runway_surface(runway['geometry']['coordinates'],
                                      width_of(rtags, DEFAULT_RUNWAY_WIDTH_M)),
                 {'type': 'runway', 'role': 'runway',
                  'tags': {**keep(rtags, RUNWAY_TAGS), 'icao': tags['icao']}})
        report.append((tags['icao'], tags.get('name'), count))

    site = features.get(NEW_BODO['site'])
    runway = features.get(NEW_BODO['runway'])
    terminal = features.get(NEW_BODO['terminal'])
    if not site or site['properties'].get('construction') != 'airport':
        raise ValueError('New Bodø Airport site is no longer construction=airport')
    if not runway or runway['properties'].get('construction') != 'runway':
        raise ValueError('New Bodø Airport runway is no longer construction=runway')
    if not terminal or terminal['properties'].get('construction') != 'airport_terminal':
        raise ValueError('New Bodø Airport terminal is no longer under construction')
    style = {'stroke': UNDER_CONSTRUCTION}
    # The card sits on the new runway, clear of today's airport; the much
    # larger construction site is drawn as a part of it.
    line = runway['geometry']['coordinates']
    middle = [(line[0][0] + line[-1][0]) / 2, (line[0][1] + line[-1][1]) / 2]
    emit(NEW_BODO['site'], {'type': 'Point', 'coordinates': middle},
         {'type': 'aerodrome', 'name': NEW_BODO['tags']['name'], 'tags': NEW_BODO['tags'], **style})
    emit(NEW_BODO['site'], site['geometry'],
         {'type': 'site', 'role': 'site', 'tags': {'status': 'under construction'}, **style}, part='site')
    emit(NEW_BODO['runway'], runway_surface(runway['geometry']['coordinates'], NEW_BODO['runway_width_m']),
         {'type': 'runway', 'role': 'runway',
          'tags': {'status': 'under construction', 'width': str(NEW_BODO['runway_width_m'])}, **style})
    emit(NEW_BODO['terminal'], terminal['geometry'],
         {'type': 'terminal', 'role': 'terminal', 'tags': {'status': 'under construction'}, **style})
    return out, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--osmium', default=shutil.which('osmium') or 'osmium')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    pbf = fetch(GEOFABRIK + EXTRACT + '.osm.pbf', args.cache / (EXTRACT + '.osm.pbf'))
    expected = fetch(GEOFABRIK + EXTRACT + '.osm.pbf.md5',
                     args.cache / (EXTRACT + '.osm.pbf.md5')).read_text().split()[0]
    actual = md5(pbf)
    if actual != expected:
        raise RuntimeError('MD5 mismatch for %s: %s != %s' % (pbf.name, actual, expected))
    rings = read_poly(fetch(GEOFABRIK + 'norway.poly', args.cache / 'norway.poly'))
    out, report = build(export(args.osmium, pbf, args.cache), rings)
    payload = ''.join(json.dumps(f, ensure_ascii=False, separators=(',', ':')) + '\n' for f in out)
    if args.verify:
        if payload != DATASET.read_text():
            raise SystemExit('airports.geojsonl is not the %s build' % EXTRACT)
    else:
        DATASET.parent.mkdir(parents=True, exist_ok=True)
        DATASET.write_text(payload)
    for icao, name, count in report:
        print('%s %-44s %d runway(s)' % (icao, name, count))
    print(json.dumps({'extract': EXTRACT, 'md5': actual, 'aerodromes': len(report),
                      'features': len(out), 'bytes': len(payload.encode())}))


if __name__ == '__main__':
    main()
