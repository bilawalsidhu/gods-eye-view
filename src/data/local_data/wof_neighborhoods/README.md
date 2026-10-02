# Who's On First neighborhoods pack

Neighborhood outlines for area annotations ("outline Notting Hill", "outline
Le Marais"), read by `src/data/placeBoundaries.js`. The San Francisco
DataSF pack in `../neighborhoods/` is used first inside San Francisco.

| File | Contents |
|------|----------|
| `index.json` | format, licence of every geometry source, and the tile list with each tile's box |
| `<tile>.json` | records whose box centre falls in that quadtree tile (keys are quadrant digits from the whole world) |
| `ATTRIBUTION.md` | per-source credits |
| `files.js` | every file's URL, so bundlers emit them (generated) |
| `whosonfirst-LICENSE.md`, `quattroshapes-LICENSE.md` | upstream notices, unchanged |

61,755 named neighbourhood, macrohood and microhood polygons in 218 tiles.

**Source:** [Who's On First](https://whosonfirst.org/) and contributors:
`whosonfirst-data-{neighbourhood,macrohood,microhood}-latest.tar.bz2` from
<https://data.geocode.earth/wof/dist/legacy/> and the WOF sources registry;
URLs and SHA-256 hashes are in `index.json` `meta` and in the build script.
The registry is read at a fixed commit. The legacy archives are only
published under `-latest` names; that distribution has not changed since
2025-10-14, and the hashes make a changed file fail the build.

**License:** per geometry source, as listed in `ATTRIBUTION.md` and in
`index.json` `meta.sources` (CC BY family, ODC-By, Open Government licences,
CC0, PDDL and public domain). Records whose source licence is assumed,
unknown or unresolved in the registry are not included. See DATA_SOURCES.md.

**Regenerate** (maintainer tool; requires Python with shapely==2.1.2 on
GEOS 3.13.1, checked):

```sh
python scripts/build-wof-neighborhoods.py --cache /tmp/wof-neighborhoods
python scripts/build-wof-neighborhoods.py --cache /tmp/wof-neighborhoods --verify
python scripts/pack_geometry.py check wof
```

`--verify` rebuilds in memory and fails unless every shipped file matches.

**Schema:** each tile has `tile` and `features[]`, each
`[id, name, country, type, bbox, aliases, source, rings, label]`: WOF id,
name, ISO country, placetype, `[w, s, e, n]`, other-language names,
geometry source key, polygons (largest first, each `[outer, ...holes]`) and
a `[lon, lat]` point inside the largest polygon. A ring is an encoded
polyline string: longitude then latitude at 10^-5 degrees, zigzag varint
deltas, 5-bit groups offset by 63.

**Curation:** current, non-deprecated, named polygon records; simplified to
about 15 m, snapped to 5 decimals and kept valid under GEOS (checked on the
geometry decoded from the shipped strings).
