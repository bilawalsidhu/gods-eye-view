#!/usr/bin/env python3
"""Offline, deterministic BSEE import. See the dataset README for acquisition."""
import argparse
import collections
import datetime
import hashlib
import io
import json
from pathlib import Path
import zipfile

import pyproj
import shapefile


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(platforms, structures, grid, release_date, retrieved_date):
    counts = collections.Counter()
    with zipfile.ZipFile(structures) as archive:
        rows = archive.read('platstru.DAT').decode('ascii').splitlines()
    joined = {}
    for row in rows:
        if len(row) != 148:
            raise ValueError(f'Unexpected fixed-width row length: {len(row)}')
        key = f'{int(row[8:16])}:{int(row[81:84])}'
        if key in joined:
            raise ValueError(f'Duplicate structure key: {key}')
        joined[key] = row
    counts['structureRows'] = len(rows)
    # EPSG:15851, NAD27 to WGS 84 (79), Gulf OCS, stated accuracy 5 m.
    # Explicit lon/lat axis order and exact grid: never silently fall back.
    transform = pyproj.Transformer.from_pipeline(
        '+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad '
        f'+step +proj=hgridshift +grids={Path(grid).resolve()} '
        '+step +proj=unitconvert +xy_in=rad +xy_out=deg')
    def date(value):
        return value.isoformat() if value else None
    def fixed_date(value):
        return datetime.datetime.strptime(value, '%d-%b-%Y').date() if value.strip() else None
    records = []
    seen = set()
    with zipfile.ZipFile(platforms) as archive:
        prj = archive.read('platform.prj').decode()
        if pyproj.CRS(prj).to_epsg() != 4267:
            raise ValueError('Expected NAD27 / EPSG:4267 source CRS')
        reader = shapefile.Reader(**{ext: io.BytesIO(archive.read(f'platform.{ext}')) for ext in ('shp', 'shx', 'dbf')})
        expected = ['STRUCTURE_', 'COMPLEX_ID', 'STRUCTURE1', 'INSTALL_DA', 'REMOVAL_DA']
        if [field[0] for field in reader.fields[1:]] != expected:
            raise ValueError('BSEE shapefile schema changed')
        for item in reader.iterShapeRecords():
            counts['shapeRows'] += 1
            props = item.record.as_dict()
            key = f'{props["COMPLEX_ID"]}:{props["STRUCTURE_"]}'
            if key in seen:
                raise ValueError(f'Duplicate shapefile key: {key}')
            seen.add(key)
            row = joined.get(key)
            # Either source recording a removal is sufficient to exclude it.
            if props['REMOVAL_DA'] or (row and fixed_date(row[43:54])):
                counts['removedExcluded'] += 1
                continue
            if item.shape.shapeType != shapefile.POINT:
                raise ValueError('Expected point geometry')
            lon, lat = item.shape.points[0]
            if not (-97.22 <= lon <= -81.17 and 23.82 <= lat <= 30.25):
                counts['outsideGulfExcluded'] += 1
                continue
            lon, lat = transform.transform(lon, lat, errcheck=True)
            kind = row[84:89].strip() if row else None
            if kind == 'MOPU':
                counts['mobileProductionExcluded'] += 1
                continue
            if row is None:
                counts['unmatchedIncluded'] += 1
            records.append(dict(id=key, complexId=str(props['COMPLEX_ID']),
                structureNumber=str(props['STRUCTURE_']), name=props['STRUCTURE1'].strip() or None,
                lon=round(lon, 6), lat=round(lat, 6), typeCode=kind,
                installed=date(props['INSTALL_DA']), removed=None,
                revised=date(fixed_date(row[30:41])) if row else None,
                area=row[:2].strip() if row else None, block=row[2:8].strip() if row else None))
    records.sort(key=lambda r: r['id'])
    counts['included'] = len(records)
    metadata = dict(releaseDate=release_date, retrievedDate=retrieved_date,
        coverage='BSEE U.S. Gulf federal waters; not a global inventory',
        sourceUrl='https://www.data.bsee.gov/Main/Mapping.aspx',
        structuresUrl='https://www.data.bsee.gov/Main/Platform.aspx',
        licenseUrl='https://www.data.bsee.gov/Mapping/Files/platform_meta.html',
        inputCrs='EPSG:4267', outputCrs='EPSG:4326', operation='EPSG:15851',
        operationAccuracyMeters=5, counts=dict(sorted(counts.items())))
    provenance = dict(metadata, inputs=[
        dict(url=url, sha256=digest(file)) for url, file in [
            ('https://www.data.bsee.gov/Mapping/Files/platform.zip', platforms),
            ('https://www.data.bsee.gov/Platform/Files/platstrufixed.zip', structures),
            ('https://cdn.proj.org/us_noaa_conus.tif', grid)]],
        tools=dict(pyshp=shapefile.__version__, pyproj=pyproj.__version__, proj=pyproj.proj_version_str))
    return dict(schemaVersion=1, metadata=metadata, records=records), provenance


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['platforms', 'structures', 'grid', 'release-date', 'retrieved-date', 'output']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--verify-manifest', help='Fail if input bytes or dates differ from an archived provenance file')
    args = parser.parse_args()
    if args.verify_manifest:
        expected = json.loads(Path(args.verify_manifest).read_text())
        for entry, file in zip(expected['inputs'], [args.platforms, args.structures, args.grid], strict=True):
            if digest(file) != entry['sha256']:
                raise ValueError(f'Input checksum differs: {file}')
        if (args.release_date, args.retrieved_date) != (expected['releaseDate'], expected['retrievedDate']):
            raise ValueError('Snapshot dates differ from the manifest')
    data, provenance = build(args.platforms, args.structures, args.grid, args.release_date, args.retrieved_date)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
    (output / 'platforms.json').write_text(payload)
    provenance['outputSha256'] = hashlib.sha256(payload.encode()).hexdigest()
    (output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(provenance, indent=2))
