#!/usr/bin/env python3
"""Maintainer-only Who's On First neighborhood pack build (Shapely 2.1).

Reads the pinned Who's On First neighbourhood, macrohood and microhood
archives and the WOF sources registry, keeps current polygon records whose
geometry source matches the reviewed open-licence allowlist, simplifies them
to about 15 m, and
writes src/data/local_data/wof_neighborhoods/:

  index.json      format, licences per source, tile list with boxes
  <tile>.json     records whose box centre falls in that quadtree tile
  files.js        their URLs, for bundlers
  ATTRIBUTION.md  per-source credits

Usage:
  python scripts/build-wof-neighborhoods.py --cache /tmp/wof-neighborhoods [--verify]

Requires shapely==2.1.2 on GEOS 3.13.1 (checked). --verify rebuilds in memory
and fails unless every shipped file matches byte for byte.

Downloads go to --cache and are checked against the pinned SHA-256. The
neighbourhood archive is about 400 MB.
"""
import argparse
import collections
import hashlib
import json
import math
import subprocess
import tarfile
from pathlib import Path

from shapely import make_valid
from shapely.affinity import scale
from shapely.geometry import MultiPolygon, shape

import pack_geometry

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / 'src/data/local_data/wof_neighborhoods'
# The legacy distribution is frozen (last published 2025-10-14) and only
# offers `-latest` names; the SHA-256 pins make a changed file fail loudly.
DIST = 'https://data.geocode.earth/wof/dist/legacy'
ARCHIVES = {
    'neighbourhood': {
        'url': DIST + '/whosonfirst-data-neighbourhood-latest.tar.bz2',
        'sha256': '8e5e413aacf2244e4e4167fbd9be860bc407ae6de8b733e47f13abe6d3d10455',
    },
    'macrohood': {
        'url': DIST + '/whosonfirst-data-macrohood-latest.tar.bz2',
        'sha256': 'f5fbfabcb8229b83242dbd38530c27e61867e8b3b097e3393d9c841962a99679',
    },
    'microhood': {
        'url': DIST + '/whosonfirst-data-microhood-latest.tar.bz2',
        'sha256': 'e8197fa576e8831be8f091ac7e219d29224d89404ab0c56d377339e42a8f29ac',
    },
}
# The registry at a fixed commit.
SOURCES = {
    'url': 'https://raw.githubusercontent.com/whosonfirst/whosonfirst-sources/'
           'e17af153c144fe6e08aa8db2607b4bf8aecd448d/data/sources-spec-latest.json',
    'sha256': 'd8a5dd873d26eee11583de4438185c046dec33848d5bde27047ca4bff44d9c39',
}
TOLERANCE_M = 15
PRECISION = 5
TILE_MAX_BYTES = 200_000
TILE_MAX_DEPTH = 16
LICENSE_POLICY = json.loads((ROOT / 'scripts/wof-open-licenses.json').read_text())
ALLOWED_LICENSES = frozenset(LICENSE_POLICY['licenses'])
REVIEWED_SOURCES = LICENSE_POLICY.get('reviewedSources', {})
FIELDS = ['id', 'name', 'country', 'type', 'bbox', 'aliases', 'source', 'rings', 'label']


def fetch(cache, name, url, sha256):
    path = cache / name
    if not path.exists():
        print('Downloading', url, flush=True)
        # Plain urllib requests are refused by the WOF host; curl is not.
        subprocess.run(['curl', '--fail', '-L', '-o', str(path), url], check=True)
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    if digest.hexdigest() != sha256:
        raise ValueError(f'{name}: SHA-256 {digest.hexdigest()} is not the pinned {sha256}')
    return path


# ── geometry ────────────────────────────────────────────────────────────

def simplify(geometry):
    """Simplify at TOLERANCE_M in local metres, snap to the pack grid, keep it
    valid, and order parts largest first. Returns (rings, label) where the
    label is a point inside the largest part, or ([], None)."""
    geometry = MultiPolygon(pack_geometry.polygon_parts(make_valid(geometry) if not geometry.is_valid else geometry))
    if geometry.is_empty:
        return [], None
    lat = geometry.centroid.y
    sx = 111320 * max(0.001, math.cos(math.radians(lat)))
    sy = 110574
    metric = scale(geometry, xfact=sx, yfact=sy, origin=(0, 0))
    metric = metric.simplify(TOLERANCE_M, preserve_topology=True)
    geometry = scale(metric, xfact=1 / sx, yfact=1 / sy, origin=(0, 0))
    # To whole pack units (10^-PRECISION degrees), where GEOS is exact.
    units = scale(geometry, xfact=10 ** PRECISION, yfact=10 ** PRECISION, origin=(0, 0))
    parts = pack_geometry.ordered_parts(pack_geometry.settle(units))
    if not parts:
        return [], None
    rings = [
        [pack_geometry.encode_polyline(pack_geometry.open_ring(p.exterior.coords))]
        + [pack_geometry.encode_polyline(pack_geometry.open_ring(r.coords)) for r in p.interiors]
        for p in parts
    ]
    # Check what ships: the geometry decoded from the encoded strings.
    decoded = [[pack_geometry.decode_polyline(r) for r in poly] for poly in rings]
    why = pack_geometry.problems(decoded)
    if why:
        raise ValueError(f'encoded geometry invalid: {why}')
    point = parts[0].representative_point()
    point = shape({'type': 'Point', 'coordinates': [round(point.x) / 10 ** PRECISION, round(point.y) / 10 ** PRECISION]})
    return rings, [point.x, point.y]


# ── records ─────────────────────────────────────────────────────────────

def read_archive(path, records):
    with tarfile.open(path, 'r|bz2') as archive:
        for member in archive:
            if not member.name.endswith('.geojson') or '-alt-' in member.name:
                continue
            feature = json.load(archive.extractfile(member))
            if feature['geometry']['type'] not in ('Polygon', 'MultiPolygon'):
                records.pop(feature['properties']['wof:id'], None)
                continue
            records[feature['properties']['wof:id']] = feature


def keep(properties):
    deprecated = properties.get('edtf:deprecated', 'uuuu') not in ('uuuu', '', None)
    superseded = bool(properties.get('wof:superseded_by', []))
    return properties.get('mz:is_current', -1) != 0 and not deprecated and not superseded


def source_table(spec):
    lookup = {}
    for source in spec.values():
        for key in (source.get('name'), source.get('prefix')):
            if key:
                lookup[key] = source
    return lookup


def verify_source_reviews(lookup):
    """Pin exceptional source decisions to the exact reviewed registry evidence."""
    registry_commit = SOURCES['url'].split('/')[-3]
    for key, review in REVIEWED_SOURCES.items():
        source = lookup.get(key)
        if not source:
            raise ValueError(f'{key}: reviewed source is absent from the pinned registry')
        if review.get('registryCommit') != registry_commit:
            raise ValueError(f'{key}: review does not match the pinned registry commit')
        if review.get('registrySha256') != SOURCES['sha256']:
            raise ValueError(f'{key}: review does not match the pinned registry SHA-256')
        if review.get('rawLicenseType') != source.get('license_type'):
            raise ValueError(f'{key}: reviewed raw licence no longer matches the registry')
        text = source.get('license_text') or ''
        if review.get('licenseTextSha256') != hashlib.sha256(text.encode()).hexdigest():
            raise ValueError(f'{key}: reviewed licence text no longer matches the registry')
        if review['rawLicenseType'] not in ALLOWED_LICENSES:
            raise ValueError(f'{key}: reviewed raw licence is not admitted by policy')


def licence_allowed(value):
    """Only exact raw registry strings reviewed in the policy are accepted."""
    return isinstance(value, str) and value in ALLOWED_LICENSES


def source_allowed(key, source):
    return (key != 'unknown' and bool(source) and
            licence_allowed(source.get('license_type')))


def build_records(archives, lookup):
    raw = {}
    for kind in ('neighbourhood', 'macrohood', 'microhood'):
        read_archive(archives[kind], raw)
        print(kind, len(raw), flush=True)
    features = []
    excluded = collections.Counter()
    for wof_id in sorted(raw):
        properties = raw[wof_id]['properties']
        if not keep(properties):
            continue
        key = properties.get('src:geom', 'unknown')
        if not source_allowed(key, lookup.get(key)):
            excluded[key] += 1
            continue
        name = properties['wof:name']
        aliases = sorted({
            alias
            for k, values in properties.items()
            if k.startswith('name:') and isinstance(values, list)
            for alias in values
            if isinstance(alias, str) and alias != name
        })
        if not name.strip() and not aliases:
            continue  # nothing to ask for it by
        geometry = shape(raw[wof_id]['geometry'])
        if geometry.is_empty:
            continue
        rings, label = simplify(geometry)
        if not rings:
            continue
        country = properties.get('iso:country', properties.get('wof:country'))
        features.append([
            wof_id, name, country, properties['wof:placetype'],
            [round(v, PRECISION) for v in geometry.bounds], aliases, key, rings, label,
        ])
    return features, excluded


# ── tiles ───────────────────────────────────────────────────────────────

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def tiles(features, key='', box=(-180.0, -90.0, 180.0, 90.0)):
    size = sum(len(compact(f).encode()) for f in features)
    if size <= TILE_MAX_BYTES or len(key) >= TILE_MAX_DEPTH:
        yield key or 'world', features
        return
    west, south, east, north = box
    mx, my = (west + east) / 2, (south + north) / 2
    quads = [[], [], [], []]
    for f in features:
        x = (f[4][0] + f[4][2]) / 2
        y = (f[4][1] + f[4][3]) / 2
        quads[(1 if x >= mx else 0) + (2 if y >= my else 0)].append(f)
    boxes = [(west, south, mx, my), (mx, south, east, my), (west, my, mx, north), (mx, my, east, north)]
    for i, quad in enumerate(quads):
        if quad:
            yield from tiles(quad, key + str(i), boxes[i])


def union_box(features):
    return [
        min(f[4][0] for f in features), min(f[4][1] for f in features),
        max(f[4][2] for f in features), max(f[4][3] for f in features),
    ]


# ── credits ─────────────────────────────────────────────────────────────

def licence_label(key, source):
    licence = source['license_type']
    if key == 'karmashapes':
        return 'CC BY 4.0'
    return {
        'CC-BY': 'CC BY', 'Attribution 3.0 Unported': 'CC BY 3.0', 'Public domain': 'Public Domain',
        'Open Government License - British Columbia, v2.0': 'Open Government Licence - British Columbia, v2.0',
    }.get(licence, licence)


def attribution(counts, lookup):
    lines = [
        '# Neighborhood boundary credits',
        '',
        "Neighborhood boundaries from [Who's On First](https://whosonfirst.org/docs/licenses/) "
        'and contributors, used under the licences below. Modified: boundaries simplified to about 15 m, repaired and re-encoded.',
        '',
        '| Source | Records | Licence | Terms |',
        '|---|---:|---|---|',
    ]
    for key, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        source = lookup[key]
        name = source.get('fullname') or key
        terms = source.get('license') or ''
        link = f'[terms]({terms})' if terms.startswith('http') else terms
        lines.append(f'| {name} (`{key}`) | {count:,} | {licence_label(key, source)} | {link} |')
    via = [(key, lookup[key]) for key in sorted(counts) if lookup[key].get('src:via')]
    if via:
        lines += ['', '## Upstream sources', '']
        for key, source in via:
            lines += [f'### {source.get("fullname") or key}', '']
            for v in source['src:via']:
                note = f' ({v["source_note"]})' if v.get('source_note') else ''
                context = f'{v["context"]}: ' if v.get('context') else ''
                lines.append(f'- {context}{v.get("source_name", "")}{note} {v.get("source_link", "")}'.rstrip())
            lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--verify', action='store_true', help='rebuild in memory and compare with the shipped pack')
    args = parser.parse_args()
    pack_geometry.require_pinned_tooling()
    args.cache.mkdir(parents=True, exist_ok=True)
    archives = {
        kind: fetch(args.cache, Path(a['url']).name, a['url'], a['sha256'])
        for kind, a in ARCHIVES.items()
    }
    spec = json.loads(fetch(args.cache, 'sources-spec-latest.json', SOURCES['url'], SOURCES['sha256']).read_text())
    lookup = source_table(spec)
    verify_source_reviews(lookup)
    features, excluded = build_records(archives, lookup)
    if len({f[0] for f in features}) != len(features):
        raise ValueError('duplicate WOF id')

    out = {}
    tile_list = []
    for key, members in tiles(features):
        members.sort(key=lambda f: f[0])
        out[f'{key}.json'] = compact({'tile': key, 'features': members}) + '\n'
        tile_list.append({'key': key, 'count': len(members), 'bbox': union_box(members)})
    counts = collections.Counter(f[6] for f in features)
    index = {
        'meta': {
            'title': "Who's On First neighbourhood, macrohood and microhood polygons",
            'archives': ARCHIVES,
            'sourcesRegistry': SOURCES,
            'license': 'Per source; see sources and ATTRIBUTION.md',
            'format': 'neighborhood-polylines-v1',
            'fields': FIELDS,
            'precision': PRECISION,
            'coordinateOrder': 'lon,lat',
            'toleranceM': TOLERANCE_M,
            'schema': (
                'tiles[]: key, count, bbox [w, s, e, n] of its records. <key>.json: tile, features[] as '
                'fields: WOF id, name, ISO country, placetype, bbox, aliases[] (other-language names), '
                'geometry source key, rings (polygons, largest first, each [outer, ...holes]; each ring '
                'an encoded polyline string: zigzag varint deltas of lon then lat at 10^-precision '
                'degrees), label [lon, lat] (a point inside the largest polygon)'
            ),
            'sources': {
                key: {
                    'name': lookup[key].get('fullname') or key,
                    'license': licence_label(key, lookup[key]),
                    'terms': lookup[key].get('license') or '',
                    'records': counts[key],
                }
                for key in sorted(counts)
            },
            'script': 'scripts/build-wof-neighborhoods.py',
        },
        'tiles': tile_list,
    }
    out['index.json'] = json.dumps(index, ensure_ascii=False, indent=1) + '\n'
    out['ATTRIBUTION.md'] = attribution(counts, lookup)
    # Literal URLs, so a bundler emits every tile as an asset.
    out['files.js'] = '\n'.join([
        '// Generated by scripts/build-wof-neighborhoods.py; do not edit.',
        "export const INDEX_URL = () => new URL('./index.json', import.meta.url);",
        'export const TILE_URLS = {',
        *[f"  t{t['key']}: () => new URL('./{t['key']}.json', import.meta.url)," for t in tile_list],
        '};',
    ]) + '\n'
    if args.verify:
        # Reproducibility: a rebuild must match what ships, byte for byte.
        shipped = {p.name for p in PACK.glob('*.json')} | {'ATTRIBUTION.md', 'files.js'}
        differ = sorted(
            name for name in shipped | set(out)
            if not (PACK / name).exists() or name not in out
            or (PACK / name).read_bytes() != out[name].encode('utf-8')
        )
        if differ:
            raise SystemExit(f'rebuild differs from the shipped pack: {differ[:10]}')
        print(f'wof_neighborhoods: rebuild matches all {len(out)} shipped files')
        return
    PACK.mkdir(parents=True, exist_ok=True)
    for old in PACK.glob('*.json'):
        old.unlink()
    for name, text in out.items():
        (PACK / name).write_text(text, encoding='utf-8')
    print(f'wof_neighborhoods: {len(features)} records in {len(tile_list)} tiles; '
          f'excluded {sum(excluded.values())} with an unapproved licence: {dict(excluded)}', flush=True)


if __name__ == '__main__':
    main()
