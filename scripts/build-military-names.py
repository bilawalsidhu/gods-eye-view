#!/usr/bin/env python3
"""Maintainer-only Overture military-name pack build (DuckDB 1.5.5)."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
RELEASE = '2026-09-23.1'
CLASSES = ['military_land', 'airfield', 'naval_base', 'range', 'barracks', 'base', 'training_area']
PACK = ROOT / 'src/data/local_data/osm_military_names'


def assemble(rows):
    records = []
    snapshots = set()
    for row in rows:
        source = next(s for s in row['sources'] if s['dataset'] == 'OpenStreetMap')
        match = re.fullmatch(r'([nwr])(\d+)@\d+', source['record_id'])
        if not match:
            raise ValueError('Invalid typed OSM identity')
        ident = match[1] + match[2]
        bbox = [row['bbox'][k] for k in ['xmin', 'ymin', 'xmax', 'ymax']]
        lon, lat, area = row['lon'], row['lat'], row['area']
        if not all(math.isfinite(v) for v in [lon, lat, area, *bbox]):
            raise ValueError('Invalid geometry measurement')
        if not bbox[0] - 1e-7 <= lon <= bbox[2] + 1e-7 or not bbox[1] - 1e-7 <= lat <= bbox[3] + 1e-7:
            raise ValueError('Label outside source bounds')
        kind = row['military'] if row['military'] in CLASSES else 'military_land'
        records.append([ident, row['name'], round(lon, 5), round(lat, 5),
                        *[round(v, 4) for v in bbox], CLASSES.index(kind), max(1, round(abs(area)))])
        snapshots.add(source['version'][:10])
    records.sort(key=lambda r: (r[0][0], int(r[0][1:])))
    if len(set(r[0] for r in records)) != len(records):
        raise ValueError('Duplicate OSM identity')
    return {'release': RELEASE, 'snapshots': sorted(snapshots), 'classes': CLASSES, 'records': records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--extensions', type=Path)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    cached = args.cache / ('military-names-' + RELEASE + '.json')
    if not cached.exists():
        import duckdb
        if duckdb.__version__ != '1.5.5':
            raise RuntimeError('Use duckdb==1.5.5')
        config = {'threads': '8', 'memory_limit': '3GB', 'temp_directory': str(args.cache / 'temp')}
        if args.extensions:
            config['extension_directory'] = str(args.extensions)
        connection = duckdb.connect(config=config)
        if not args.extensions:
            connection.execute('INSTALL httpfs; INSTALL spatial;')
        connection.execute('LOAD httpfs; LOAD spatial; SET geometry_always_xy=true; SET enable_progress_bar=false;')
        files = json.loads((ROOT / 'scripts/military-names-files.json').read_text())
        if not all('/' + RELEASE + '/' in url for url in files):
            raise ValueError('Unexpected source release')
        cursor = connection.execute((ROOT / 'scripts/military-names.sql').read_text(), [files])
        fields = [d[0] for d in cursor.description]
        rows = [dict(zip(fields, row)) for row in cursor.fetchall()]
        cached.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
    pack = assemble(json.loads(cached.read_text()))
    raw = json.dumps(pack, ensure_ascii=False, separators=(',', ':')).encode()
    digest = hashlib.sha256(raw).hexdigest()
    if args.verify:
        expected = (PACK / 'names.sha256').read_text().split()[0]
        if digest != expected:
            raise ValueError(f'Output SHA-256 mismatch: {digest}')
    else:
        PACK.mkdir(parents=True, exist_ok=True)
        (PACK / 'names.json').write_bytes(raw)
        (PACK / 'names.sha256').write_text(digest + '  names.json\n')
    print(json.dumps({'records': len(pack['records']), 'rawBytes': len(raw),
                      'gzipBytes': len(gzip.compress(raw, compresslevel=9, mtime=0)), 'sha256': digest}))


if __name__ == '__main__':
    main()
