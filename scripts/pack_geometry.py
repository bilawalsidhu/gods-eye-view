#!/usr/bin/env python3
"""Maintainer-only topology check and repair for the bundled outline packs.

  python scripts/pack_geometry.py check census|wof   every shipped feature,
      decoded as a whole MultiPolygon, is valid under GEOS, keeps at least
      three distinct vertices per ring, and lists its largest part first
  python scripts/pack_geometry.py repair census       rewrite the Census place
      files so every feature passes `check` (run by build-census-places.mjs)

Geometry is checked and repaired in the packs' own integer units (10^-d
degrees), where GEOS arithmetic is exact: a vertex that lies on another edge
after rounding is seen as the touch it is.

Requires Shapely 2.1.2 on GEOS 3.13.1, pinned so repairs are reproducible.
"""
import argparse
import json
import sys
from pathlib import Path

import shapely
from shapely import make_valid, set_precision
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'src/data/local_data'
SHAPELY_VERSION = '2.1.2'
GEOS_VERSION = (3, 13, 1)


def require_pinned_tooling():
    if shapely.__version__ != SHAPELY_VERSION or shapely.geos_version != GEOS_VERSION:
        raise RuntimeError(
            f'Use shapely=={SHAPELY_VERSION} on GEOS {".".join(map(str, GEOS_VERSION))}; '
            f'found {shapely.__version__} on GEOS {shapely.geos_version}'
        )


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


# ── encodings ────────────────────────────────────────────────────────────

def decode_deltas(encoded):
    """[x0, y0, dx1, dy1, …] → [(x, y), …] in pack units (Census/admin packs)."""
    x = y = 0
    ring = []
    for i in range(0, len(encoded) - 1, 2):
        x += encoded[i]
        y += encoded[i + 1]
        ring.append((x, y))
    return ring


def encode_deltas(coords):
    out = []
    px = py = 0
    for fx, fy in coords:
        x, y = round(fx), round(fy)
        out += [x - px, y - py]
        px, py = x, y
    return out


def decode_polyline(encoded):
    """Zigzag varint deltas, 5-bit groups offset by 63, lon then lat; pack units."""
    values = []
    last = [0, 0]
    i = 0
    while i < len(encoded):
        n = shift = 0
        while True:
            b = ord(encoded[i]) - 63
            i += 1
            n |= (b & 31) << shift
            shift += 5
            if b < 32:
                break
        axis = len(values) % 2
        last[axis] += ~(n >> 1) if n & 1 else n >> 1
        values.append(last[axis])
    return list(zip(values[::2], values[1::2]))


def encode_polyline(coords):
    out = []
    last = [0, 0]
    for x, y in coords:
        for i, value in enumerate([round(x), round(y)]):
            n = value - last[i]
            last[i] = value
            n = (n << 1) ^ (n >> 63)
            while n >= 32:
                out.append(chr((32 | (n & 31)) + 63))
                n >>= 5
            out.append(chr(n + 63))
    return ''.join(out)


# ── geometry ─────────────────────────────────────────────────────────────

def polygon_parts(geometry):
    if geometry.geom_type == 'Polygon':
        return [] if geometry.is_empty else [geometry]
    if hasattr(geometry, 'geoms'):
        return [p for g in geometry.geoms for p in polygon_parts(g)]
    return []


def open_ring(coords):
    coords = [tuple(c[:2]) for c in coords]
    return coords[:-1] if len(coords) > 1 and coords[0] == coords[-1] else coords


def ordered_parts(geometry):
    """Polygon parts oriented (outer counter-clockwise), largest area first."""
    parts = [orient(p, 1.0) for p in polygon_parts(geometry)]
    return sorted(parts, key=lambda p: (-p.area, p.bounds))


def on_grid(geometry):
    """Snap to whole pack units keeping the result valid; polygon parts only."""
    snapped = set_precision(geometry, 1, mode='valid_output')
    return MultiPolygon(polygon_parts(snapped))


def settle(geometry):
    """A valid MultiPolygon of `geometry` (in pack units) on whole units."""
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    geometry = on_grid(MultiPolygon(polygon_parts(geometry)))
    for _ in range(3):
        if geometry.is_valid:
            break
        geometry = on_grid(make_valid(geometry))
    return geometry


def rings_ok(polygons):
    return all(len(set(ring)) >= 3 for poly in polygons for ring in poly)


def problems(polygons):
    """Why decoded `polygons` ([[outer, *holes], …]) fail the pack contract."""
    if not polygons or not rings_ok(polygons):
        return 'ring with fewer than three distinct vertices'
    try:
        geometry = MultiPolygon([Polygon(p[0], p[1:]) for p in polygons])
    except Exception as error:  # noqa: BLE001 - malformed input is a finding
        return f'unbuildable: {error}'
    if not geometry.is_valid:
        return shapely.is_valid_reason(geometry)
    areas = [part.area for part in geometry.geoms]
    if max(areas) > areas[0]:
        return 'largest part is not first'
    return None


# ── packs ────────────────────────────────────────────────────────────────

def census_features():
    folder = DATA / 'us_census_places'
    decimals = json.loads((folder / 'index.json').read_text())['meta']['decimals']
    for path in sorted(folder.glob('[A-Z][A-Z].json')):
        pack = json.loads(path.read_text(encoding='utf-8'))
        yield path, pack, decimals


def census_polygons(feature):
    return [[decode_deltas(r) for r in poly] for poly in feature['polygons']]


def wof_features():
    folder = DATA / 'wof_neighborhoods'
    index = json.loads((folder / 'index.json').read_text(encoding='utf-8'))
    for tile in index['tiles']:
        pack = json.loads((folder / f'{tile["key"]}.json').read_text(encoding='utf-8'))
        for feature in pack['features']:
            yield feature, index['meta']['precision']


def check(pack):
    bad = []
    total = 0
    if pack == 'census':
        for _, data, decimals in census_features():
            for feature in data['features']:
                total += 1
                why = problems(census_polygons(feature))
                if why:
                    bad.append((feature['geoid'], feature['name'], why))
    else:
        for feature, precision in wof_features():
            total += 1
            polygons = [[decode_polyline(r) for r in poly] for poly in feature[7]]
            why = problems(polygons)
            if why:
                bad.append((feature[0], feature[1], why))
    for row in bad[:20]:
        print('invalid', *row)
    print(f'{pack}: {total} features, {len(bad)} failing')
    return not bad


def repair_census():
    repaired = 0
    for path, data, decimals in census_features():
        changed = False
        for feature in data['features']:
            polygons = census_polygons(feature)
            if not problems(polygons):
                continue
            geometry = MultiPolygon([Polygon(p[0], p[1:]) for p in polygons if len(set(p[0])) >= 3])
            parts = ordered_parts(settle(geometry))
            feature['polygons'] = [
                [encode_deltas(open_ring(p.exterior.coords))]
                + [encode_deltas(open_ring(r.coords)) for r in p.interiors]
                for p in parts
            ]
            why = problems(census_polygons(feature))
            if why:
                raise ValueError(f'{feature["geoid"]} {feature["name"]}: still {why}')
            repaired += 1
            changed = True
        if changed:
            path.write_text(compact(data) + '\n', encoding='utf-8')
    print(f'us_census_places: {repaired} features repaired to valid GEOS topology')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['check', 'repair'])
    parser.add_argument('pack', choices=['census', 'wof'])
    args = parser.parse_args()
    require_pinned_tooling()
    if args.command == 'repair':
        if args.pack != 'census':
            parser.error('the WOF build repairs its own geometry')
        repair_census()
        sys.exit(0 if check('census') else 1)
    sys.exit(0 if check(args.pack) else 1)


if __name__ == '__main__':
    main()
