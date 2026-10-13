"""Install the original GEM global hazard raster for local noncommercial use.

Dataset and licence stay outside Git. No third-party Python packages required.
"""
import hashlib
import json
import pathlib
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'output' / 'area-data'
METADATA = 'https://zenodo.org/api/records/8409647'
RASTER = 'v2023_1_pga_475_rock_3min.tif'


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(METADATA, timeout=30) as response:
        record = json.load(response)
    artifact = next(item for item in record['files'] if item['key'] == 'GEM-GSHM_PGA-475y-rock_v2023.zip')
    archive = DESTINATION / 'gem-hazard.zip'
    if not archive.exists():
        temporary = archive.with_suffix('.part')
        with urllib.request.urlopen(artifact['links']['self'], timeout=60) as response, temporary.open('wb') as target:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 50 * 1024 * 1024:
                    raise ValueError('Archive exceeds expected size')
                target.write(chunk)
        temporary.replace(archive)
    algorithm, expected = artifact['checksum'].split(':', 1)
    digest = hashlib.new(algorithm)
    with archive.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError('GEM archive checksum mismatch')
    with zipfile.ZipFile(archive) as source:
        for name in (RASTER, 'LICENSE.txt', 'README.txt'):
            if source.getinfo(name).file_size > 200 * 1024 * 1024:
                raise ValueError('Unexpected uncompressed size')
            temporary = (DESTINATION / name).with_suffix('.part')
            with source.open(name) as reader, temporary.open('wb') as writer:
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
            temporary.replace(DESTINATION / name)
    print('Installed GEM 2023.1:', DESTINATION / RASTER)
    print('Attribution: Johnson et al. (2023), doi:10.5281/zenodo.8409647. CC BY-NC-SA 4.0.')


if __name__ == '__main__':
    main()
