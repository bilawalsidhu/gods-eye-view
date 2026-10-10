#!/usr/bin/env python3
"""Maintainer-only build of the Norwegian military-name supplement (osmium-tool).

Downloads a pinned Geofabrik Norway extract, verifies its MD5, and measures
every OpenStreetMap object named in scripts/military-names-norway.json:
interior label point, bounds and area. A named object must still be an
unnamed military area (`landuse=military` or a known `military=*` class);
a `site` object (a co-located aerodrome) only lends its bounds and area to a
point-only row. Every Wikidata position must lie inside Norway and within
MAX_WIKIDATA_KM of the area it names, and a named area must be at least a
hectare.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
EXTRACT = 'norway-261005'
GEOFABRIK = 'https://download.geofabrik.de/europe/'
CURATED = ROOT / 'scripts/military-names-norway.json'
PACK = ROOT / 'src/data/local_data/osm_military_names'
CLASSES = ['military_land', 'airfield', 'naval_base', 'range', 'barracks', 'base', 'training_area']
MILITARY = {'airfield', 'naval_base', 'range', 'barracks', 'base', 'training_area'}
MAX_WIKIDATA_KM = 4
MIN_NAMED_AREA_M2 = 10_000  # a smaller area is a building, not the site
AUTHALIC_RADIUS_M = 6371007.2


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


def in_norway(rings, lon, lat):
    return any(in_ring(r, lon, lat) for r, h in rings if not h) and \
        not any(in_ring(r, lon, lat) for r, h in rings if h)


def in_polygons(polygons, lon, lat):
    return any(in_ring(poly[0], lon, lat) and not any(in_ring(h, lon, lat) for h in poly[1:])
               for poly in polygons)


def ring_area(ring):
    """Spherical ring area on the authalic sphere, square metres."""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        total += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return abs(total) * AUTHALIC_RADIUS_M ** 2 / 2


def area(polygons):
    return sum(ring_area(poly[0]) - sum(ring_area(h) for h in poly[1:]) for poly in polygons)


def label_point(polygons):
    """Area-weighted centroid when interior, else the widest interior interval
    on the largest polygon's mid-latitude (as the tile code falls back)."""
    xs = ys = weight = 0.0
    for poly in polygons:
        ring = poly[0]
        a = ring_area(ring)
        xs += sum(p[0] for p in ring) / len(ring) * a
        ys += sum(p[1] for p in ring) / len(ring) * a
        weight += a
    point = (xs / weight, ys / weight)
    if in_polygons(polygons, *point):
        return point
    largest = max(polygons, key=lambda poly: ring_area(poly[0]))
    lat = (min(p[1] for p in largest[0]) + max(p[1] for p in largest[0])) / 2
    hits = sorted(x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
                  for ring in largest
                  for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])
                  if (y1 > lat) != (y2 > lat))
    spans = [(b - a, (a + b) / 2) for a, b in zip(hits, hits[1:])
             if in_polygons(polygons, (a + b) / 2, lat)]
    if not spans:
        raise ValueError('No interior label point')
    return (max(spans)[1], lat)


def distance_km(polygons, lon, lat):
    if in_polygons(polygons, lon, lat):
        return 0.0
    scale = math.cos(math.radians(lat))
    return min(math.hypot((p[0] - lon) * scale, p[1] - lat) * 111.32
               for poly in polygons for ring in poly for p in ring)


def export(osmium, pbf, cache, ids):
    picked = cache / (EXTRACT + '-military-names-norway.osm.pbf')
    exported = cache / (EXTRACT + '-military-names-norway.geojsonseq')
    subprocess.run([osmium, 'getid', '-r', '-O', '-o', str(picked), str(pbf), *sorted(ids)], check=True)
    subprocess.run([osmium, 'export', '-O', '-f', 'geojsonseq', '--add-unique-id=type_id',
                    '-o', str(exported), str(picked)], check=True)
    areas = {}
    for line in exported.read_text().splitlines():
        line = line.lstrip('\x1e').strip()
        if not line:
            continue
        feature = json.loads(line)
        key = feature['id']
        if key[0] != 'a' or feature['geometry']['type'] != 'MultiPolygon':
            continue
        number = int(key[1:])  # osmium area id: way * 2 or relation * 2 + 1
        key = ('w%d' % (number // 2)) if number % 2 == 0 else ('r%d' % (number // 2))
        if key in ids:
            areas[key] = feature
    return areas


def build(curated, areas, rings):
    records = []
    for site in curated['sites']:
        cls = CLASSES.index(site['class'])
        qid = site['wikidata']
        if 'osm' in site:
            feature = areas.get(site['osm'])
            if feature is None:
                raise ValueError('%s is no longer an area in %s' % (site['osm'], EXTRACT))
            tags = feature['properties']
            if tags.get('landuse') != 'military' and tags.get('military') not in MILITARY:
                raise ValueError('%s is no longer tagged military' % site['osm'])
            if tags.get('name'):
                raise ValueError('%s is now named %r in OpenStreetMap' % (site['osm'], tags['name']))
            polygons = feature['geometry']['coordinates']
            offset = distance_km(polygons, *site['point'])
            if offset > MAX_WIKIDATA_KM:
                raise ValueError('%s lies %.1f km from %s' % (site['osm'], offset, site['name']))
            if area(polygons) < MIN_NAMED_AREA_M2:
                raise ValueError('%s is too small to be %s' % (site['osm'], site['name']))
            lon, lat = label_point(polygons)
            key = site['osm']
        else:
            polygons = areas[site['site']]['geometry']['coordinates'] if 'site' in site else None
            lon, lat = site['point']
            key = None
        if not in_norway(rings, lon, lat) or not in_norway(rings, *site['point']):
            raise ValueError('%s lies outside Norway' % site['name'])
        if polygons:
            points = [p for poly in polygons for ring in poly for p in ring]
            bbox = [min(p[0] for p in points), min(p[1] for p in points),
                    max(p[0] for p in points), max(p[1] for p in points)]
            size = max(1, round(area(polygons)))
        else:
            bbox, size = [lon, lat, lon, lat], 1
        lon, lat = round(lon, 5), round(lat, 5)
        # Round bounds outward so they still hold the rounded label point.
        bbox = [math.floor(min(bbox[0], lon) * 1e4) / 1e4, math.floor(min(bbox[1], lat) * 1e4) / 1e4,
                math.ceil(max(bbox[2], lon) * 1e4) / 1e4, math.ceil(max(bbox[3], lat) * 1e4) / 1e4]
        records.append([key, site['name'], lon, lat, *bbox, cls, size, qid])
    keys = [r[0] for r in records if r[0]]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate OSM identity')
    return {'extract': EXTRACT, 'wikidataRetrieved': curated['wikidataRetrieved'],
            'classes': CLASSES, 'records': records}


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
    curated = json.loads(CURATED.read_text())
    ids = {s[k] for s in curated['sites'] for k in ('osm', 'site') if k in s}
    areas = export(args.osmium, pbf, args.cache, ids)
    pack = build(curated, areas, rings)
    for site, record in zip(curated['sites'], pack['records']):
        offset = distance_km(areas[site['osm']]['geometry']['coordinates'], *site['point']) \
            if 'osm' in site else None
        print('%-11s %-24s %s' % (record[0] or '(point)', record[1],
                                  '' if offset is None else '%.2f km from Wikidata' % offset))
    raw = json.dumps(pack, ensure_ascii=False, separators=(',', ':')).encode()
    digest = hashlib.sha256(raw).hexdigest()
    if args.verify:
        expected = (PACK / 'norway.sha256').read_text().split()[0]
        if digest != expected:
            raise SystemExit('Output SHA-256 mismatch: %s' % digest)
    else:
        (PACK / 'norway.json').write_bytes(raw)
        (PACK / 'norway.sha256').write_text(digest + '  norway.json\n')
    print(json.dumps({'extract': EXTRACT, 'md5': actual, 'records': len(pack['records']),
                      'sha256': digest}))


if __name__ == '__main__':
    main()
