#!/usr/bin/env python3
'''Maintainer-only UCS Satellite Database pack build (openpyxl).

Reads the UCS Excel release and writes the compact pack the satellites layer
loads: one row per satellite, keyed by NORAD number, with string-table indexes
for the repeated text columns. Starlink rows are left out: the layer files
every STARLINK object under its own class and operator without them.

Usage: python scripts/build-ucs-satellites.py "<path>/UCS-Satellite-Database 5-1-2023.xlsx"
'''
import argparse
import json
import logging
from pathlib import Path
import re

import openpyxl

LOG = logging.getLogger('build-ucs-satellites')

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / 'src/data/local_data/ucs_satellites'
VERSION = 'UCS-Satellite-Database 5-1-2023'
DATA_CURRENT_TO = '2023-05-01'
URL = 'https://www.ucsusa.org/satellite_database'

# Output column -> spreadsheet header.
COLUMNS = {
    'operator': 'Operator/Owner',
    'operatorCountry': 'Country of Operator/Owner',
    'purpose': 'Purpose',
}
STARLINK = re.compile(r'\bstarlink\b', re.I)


def clean(value: object) -> str:
    '''One cell as tidy text; UCS's placeholders for nothing become ''.'''
    text = re.sub(r'\s+', ' ', str(value or '')).strip()
    return '' if text.lower() in ('', 'none', 'n/a') else text


def build(xlsx: Path) -> dict:
    '''Read the release's first sheet into the pack the layer loads.'''
    sheet = openpyxl.load_workbook(xlsx, read_only=True, data_only=True).worksheets[0]
    rows = sheet.iter_rows(values_only=True)
    header = {str(h).strip(): i for i, h in enumerate(next(rows)) if h}
    names = [header['Current Official Name of Satellite'], header['Name of Satellite, Alternate Names']]
    norad_col = header['NORAD Number']
    tables = {key: [''] for key in COLUMNS}
    index = {key: {'': 0} for key in COLUMNS}
    records = {}
    source_rows = skipped_starlink = invalid_norad = 0
    for row in rows:
        if not any(row):
            continue
        source_rows += 1
        if any(STARLINK.search(clean(row[i])) for i in names):
            skipped_starlink += 1
            continue
        try:
            norad = int(float(row[norad_col]))
        except (TypeError, ValueError):
            invalid_norad += 1
            continue
        if norad <= 0:
            invalid_norad += 1
            continue
        record = [norad]
        for key, column in COLUMNS.items():
            text = clean(row[header[column]])
            if text not in index[key]:
                index[key][text] = len(tables[key])
                tables[key].append(text)
            record.append(index[key][text])
        # A duplicate NORAD number keeps the first row, as UCS lists it.
        records.setdefault(norad, record)
    ordered = [records[n] for n in sorted(records)]
    return {
        'meta': {
            'source': 'Union of Concerned Scientists Satellite Database',
            'version': VERSION,
            'url': URL,
            'dataCurrentTo': DATA_CURRENT_TO,
            'license': 'Free, unrestricted use; acknowledgement requested (UCS database manual, section 3)',
            'curation': {
                'sourceRows': source_rows,
                'starlinkRowsDropped': skipped_starlink,
                'invalidNoradDropped': invalid_norad,
                'duplicateNoradDropped': source_rows - skipped_starlink - invalid_norad - len(ordered),
                'columns': COLUMNS,
            },
            'recordCount': len(ordered),
        },
        'fields': ['noradId', *COLUMNS],
        'strings': tables,
        'records': ordered,
    }


def main() -> None:
    '''Build the pack from the release given on the command line.'''
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    parser = argparse.ArgumentParser(description='Build the UCS satellite pack from the UCS Excel release.')
    parser.add_argument('xlsx', type=Path, help='UCS-Satellite-Database <version>.xlsx')
    pack = build(parser.parse_args().xlsx)
    PACK.mkdir(parents=True, exist_ok=True)
    out = PACK / 'ucs_satellites.json'
    # LF on every platform: the repository stores text with LF endings.
    out.write_text(
        json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8',
        newline='\n',
    )
    LOG.info('%s: %d records, %d bytes', out.relative_to(ROOT), pack['meta']['recordCount'], out.stat().st_size)


if __name__ == '__main__':
    main()
