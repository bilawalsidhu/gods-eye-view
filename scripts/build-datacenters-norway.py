#!/usr/bin/env python3
"""Maintainer-only Norway refresh of the bundled datacenter extract (osmium-tool).

Downloads a pinned Geofabrik Norway extract, verifies its MD5, filters
telecom=data_center / building=data_center with osmium, and merges the result
into datacenters.geojsonl: features inside the Geofabrik Norway boundary are
added, updated or removed; every other line is kept byte-for-byte.
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
DATASET = ROOT / 'src/data/local_data/datacenters/datacenters.geojsonl'
CONTACT_TAGS = {'email', 'phone', 'fax', 'mobile', 'whatsapp', 'contact:email', 'contact:phone',
                'contact:fax', 'contact:mobile', 'contact:whatsapp'}
SAME_GEOMETRY_METERS = 0.05


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


def inside(rings, lon, lat):
    def in_ring(ring):
        hit = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
        return hit
    return any(in_ring(r) for r, h in rings if not h) and not any(in_ring(r) for r, h in rings if h)


def points(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [coordinates]
    return [p for part in coordinates for p in points(part)]


def osm_key(feature):
    osm_id = feature['properties']['osm_id']
    if osm_id < 0:
        return 'r%d' % -osm_id
    return ('n' if feature['geometry']['type'] == 'Point' else 'w') + str(osm_id)


def export(osmium, pbf, cache):
    filtered = cache / (EXTRACT + '-datacenters.osm.pbf')
    exported = cache / (EXTRACT + '-datacenters.geojsonseq')
    subprocess.run([osmium, 'tags-filter', '-O', '-o', str(filtered), str(pbf),
                    'nwr/telecom=data_center', 'nwr/building=data_center'], check=True)
    subprocess.run([osmium, 'export', '-O', '-f', 'geojsonseq', '--add-unique-id=type_id',
                    '-o', str(exported), str(filtered)], check=True)
    fresh = {}
    for line in exported.read_text().splitlines():
        line = line.lstrip('\x1e').strip()
        if not line:
            continue
        feature = json.loads(line)
        tags = {k: v for k, v in feature['properties'].items() if k not in CONTACT_TAGS}
        if tags.get('telecom') != 'data_center' and tags.get('building') != 'data_center':
            continue  # untagged member ways exported only for geometry
        key = feature['id']
        geometry = feature['geometry']
        if key[0] == 'a':  # osmium area id: way * 2 or relation * 2 + 1
            number = int(key[1:])
            key = ('w%d' % (number // 2)) if number % 2 == 0 else ('r%d' % (number // 2))
            if key[0] == 'r':
                tags = {**tags, 'type': 'multipolygon'}
            if geometry['type'] == 'MultiPolygon' and len(geometry['coordinates']) == 1:
                geometry = {'type': 'Polygon', 'coordinates': geometry['coordinates'][0]}
        elif key in fresh or geometry['type'] == 'LineString':
            continue  # closed ways are taken from their area export
        fresh[key] = {'geometry': geometry, 'tags': tags}
    return fresh


def same_geometry(old, new):
    """Same type and vertex set within tolerance; ring start and winding may differ."""
    if old['type'] != new['type']:
        return False
    a, b = points(old['coordinates']), points(new['coordinates'])
    if len(a) != len(b):
        return False

    def meters(p, q):
        dx = (p[0] - q[0]) * 111320 * math.cos(math.radians(p[1]))
        return math.hypot(dx, (p[1] - q[1]) * 110540)
    return all(min(meters(p, q) for q in b) <= SAME_GEOMETRY_METERS for p in a) and \
        all(min(meters(q, p) for p in a) <= SAME_GEOMETRY_METERS for q in b)


def feature_line(key, sequence, fresh):
    osm_id = int(key[1:]) * (-1 if key[0] == 'r' else 1)
    feature = {'id': osm_id, 'type': 'Feature', 'geometry': fresh['geometry'],
               'properties': {'id': sequence, 'tags': fresh['tags'], 'type': 'data_center',
                              'osm_id': osm_id}}
    return json.dumps(feature, separators=(',', ':'), ensure_ascii=False)


def merge(lines, fresh, rings):
    out, seen, sequence = [], set(), 0
    report = {'kept': 0, 'updated': [], 'removed': [], 'added': []}
    for line in lines:
        feature = json.loads(line)
        sequence = max(sequence, feature['properties']['id'])
        key = osm_key(feature)
        if key in fresh:
            seen.add(key)
            old_tags = feature['properties']['tags']
            if old_tags == fresh[key]['tags'] and same_geometry(feature['geometry'], fresh[key]['geometry']):
                out.append(line)
                report['kept'] += 1
            else:
                out.append(feature_line(key, feature['properties']['id'], fresh[key]))
                report['updated'].append(key)
            continue
        lon, lat = points(feature['geometry']['coordinates'])[0][:2]
        if inside(rings, lon, lat):
            report['removed'].append(key)
            continue
        out.append(line)
    for key in sorted(set(fresh) - seen, key=lambda k: (k[0], int(k[1:]))):
        sequence += 1
        out.append(feature_line(key, sequence, fresh[key]))
        report['added'].append(key)
    if len({osm_key(json.loads(line)) for line in out}) != len(out):
        raise ValueError('Duplicate OSM identity')
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
    fresh = export(args.osmium, pbf, args.cache)
    current = [line for line in DATASET.read_text().splitlines() if line.strip()]
    merged, report = merge(current, fresh, rings)
    payload = '\n'.join(merged) + '\n'
    if args.verify:
        if payload != DATASET.read_text():
            raise SystemExit('datacenters.geojsonl is not the %s merge' % EXTRACT)
    else:
        DATASET.write_text(payload)
    print(json.dumps({'extract': EXTRACT, 'md5': actual, 'norway': len(fresh),
                      'features': len(merged), **report}))


if __name__ == '__main__':
    main()
