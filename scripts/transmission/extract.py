#!/usr/bin/env python3
"""Build the bounded Cape Town OSM pilot; no network requests or inferred tags.

python scripts/transmission/extract.py INPUT.osm.pbf OUTPUT_DIRECTORY
Dependencies are pinned in requirements.txt. See README.md for provenance.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re

import osmium
from pyproj import Geod, Transformer
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.ops import transform

BBOX = (18.30, -34.36, 18.99, -33.47)
CUTOFF = 110000
EXPECTED_MD5 = 'd652fc8aa7414b6f49836388343d691b'
SOURCE_URL = 'https://download.geofabrik.de/africa/south-africa-261022.osm.pbf'


def voltage_state(raw):
    """Missing and malformed are distinct; preserve every numeric tagged value."""
    if raw is None:
        return 'unknown', []
    parts = [p.strip() for p in re.split('[;,]', raw) if p.strip()]
    if not parts or any(not re.fullmatch('[0-9]+', p) for p in parts):
        return 'malformed', []
    volts = [int(p) for p in parts]
    return ('known' if max(volts) >= CUTOFF else 'below'), volts


def line_parts(geom):
    if geom.geom_type == 'LineString' and geom.length > 0:
        return [geom]
    return [part for g in getattr(geom, 'geoms', []) for part in line_parts(g)]


def make_pack(records, region):
    """Clip before metric simplification; keep source identities across split lines."""
    project = Transformer.from_crs(4326, 32734, always_xy=True).transform
    unproject = Transformer.from_crs(32734, 4326, always_xy=True).transform
    features, overlaps = [], []
    areas = [r for r in records if r['kind'] == 'substation' and r['geometry'].geom_type == 'Polygon']
    for record in sorted(records, key=lambda r: r['id']):
        geom, tags = record['geometry'], record['tags']
        state, volts = voltage_state(tags.get('voltage'))
        if state != 'known' and not (record['kind'] == 'substation' and state == 'unknown'):
            continue
        properties = {key: tags[key] for key in ('name', 'operator', 'voltage', 'substation', 'circuits', 'cables', 'location') if key in tags}
        properties.update(kind=record['kind'], voltageState=state, voltages=volts)
        clipped = geom.intersection(region)
        if record['kind'] == 'line':
            parts = []
            for part in line_parts(clipped):
                simple = transform(unproject, transform(project, part).simplify(5, preserve_topology=False))
                parts.extend(line_parts(simple.intersection(region)))
            if not parts:
                continue
            geometry = {'type': 'MultiLineString', 'coordinates': [list(p.coords) for p in parts]}
            properties['clipped'] = not region.covers(geom)
        else:
            geometry = mapping(clipped.representative_point())
            properties['representativePoint'] = geom.geom_type != 'Point'
            containing = sorted(a['id'] for a in areas if geom.geom_type == 'Point' and a['geometry'].covers(geom))
            if containing:
                properties['overlappingAreas'] = containing
                overlaps.append({'id': record['id'], 'areas': containing})
        features.append({'type': 'Feature', 'id': record['id'], 'properties': properties, 'geometry': geometry})
    return {'type': 'FeatureCollection', 'features': features}, overlaps


def extract(path):
    region = box(*BBOX)
    records, counts, relation_members, resolved_members = [], Counter(), {}, {}
    # Relation count alone is not a spatial count. Resolve each member before
    # asserting that the pilot can safely use the node/way subset.
    for rel in osmium.FileProcessor(str(path), entities=osmium.osm.RELATION):
        if rel.tags.get('power') == 'substation':
            relation_members[rel.id] = [(m.type, m.ref) for m in rel.members]
    wanted = {member for members in relation_members.values() for member in members}

    def add(oid, kind, tags, geom):
        if not region.intersects(geom):
            return
        if not geom.is_valid or geom.is_empty:
            raise ValueError(f'Invalid pilot geometry: {oid}')
        state, _ = voltage_state(tags.get('voltage'))
        counts[f'{kind}_{state}'] += 1
        records.append({'id': oid, 'kind': kind, 'tags': tags, 'geometry': geom})

    class Handler(osmium.SimpleHandler):
        def node(self, node):
            if node.tags.get('power') == 'substation' or ('n', node.id) in wanted:
                geom = Point(node.location.lon, node.location.lat)
                if ('n', node.id) in wanted:
                    resolved_members[('n', node.id)] = geom
                if node.tags.get('power') == 'substation':
                    add(f'node/{node.id}', 'substation', dict(node.tags), geom)

        def way(self, way):
            kind = way.tags.get('power')
            if kind not in ('line', 'substation') and ('w', way.id) not in wanted:
                return
            coords = [(node.lon, node.lat) for node in way.nodes]
            if len(coords) < 2:
                return
            geom = Polygon(coords) if kind == 'substation' and len(coords) >= 4 and coords[0] == coords[-1] else LineString(coords)
            if ('w', way.id) in wanted:
                resolved_members[('w', way.id)] = geom
            if kind in ('line', 'substation'):
                add(f'way/{way.id}', kind, dict(way.tags), geom)

    Handler().apply_file(str(path), locations=True, idx='flex_mem')
    for rid, members in relation_members.items():
        if not members or any(m not in resolved_members for m in members):
            raise ValueError(f'Unresolved substation relation {rid}; audit before rebuilding')
        if any(region.intersects(resolved_members[m]) for m in members):
            raise ValueError(f'Substation relation {rid} intersects pilot; add relation support before rebuilding')
    if len({r['id'] for r in records}) != len(records):
        raise ValueError('Duplicate OSM identity')
    pack, overlaps = make_pack(records, region)
    return pack, dict(sorted(counts.items())), overlaps, sorted(relation_members)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    md5, sha256 = hashlib.md5(), hashlib.sha256()
    with args.input.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            md5.update(block)
            sha256.update(block)
    if md5.hexdigest() != EXPECTED_MD5:
        raise ValueError('This pilot pins south-africa-261022.osm.pbf; checksum mismatch')
    with osmium.io.Reader(str(args.input)) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp')
    pack, counts, overlaps, relations = extract(args.input)
    body = (json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    geod = Geod(ellps='WGS84')
    lengths = [geod.line_length(*zip(*part)) for f in pack['features'] if f['properties']['kind'] == 'line' for part in f['geometry']['coordinates']]
    metadata = {
        'schemaVersion': 1, 'region': 'Cape Town', 'bbox': list(BBOX), 'cutoffV': CUTOFF,
        'sourceUrl': SOURCE_URL, 'sourceTimestamp': timestamp,
        'sourceBytes': args.input.stat().st_size, 'sourceMd5': md5.hexdigest(), 'sourceSha256': sha256.hexdigest(),
        'attribution': '© OpenStreetMap contributors', 'license': 'ODbL-1.0',
        'licenseUrl': 'https://www.openstreetmap.org/copyright',
        'clipPolicy': 'Clip lines and substation representative points to the bounding box; it is not a municipal boundary.',
        'simplification': {'crs': 'EPSG:32734', 'toleranceM': 5},
        'counts': counts, 'features': len(pack['features']),
        'lineKm': round(sum(lengths) / 1000, 3),
        'lineVertices': sum(len(p) for f in pack['features'] if f['properties']['kind'] == 'line' for p in f['geometry']['coordinates']),
        'overlappingSubstations': overlaps, 'substationRelationsOutsidePilot': relations,
        'packBytes': len(body), 'packGzip9Bytes': len(gzip.compress(body, compresslevel=9, mtime=0)),
        'packSha256': hashlib.sha256(body).hexdigest(),
        'dependencies': {name: importlib.metadata.version(name) for name in ('osmium', 'shapely', 'pyproj')},
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'cape-town.geojson').write_bytes(body)
    (args.output / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
