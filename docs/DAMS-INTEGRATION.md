# Integrating the independent dam contributions

The candidate order is **#1009 (NVE) → #1152 (Acaray/Yacyretá) → #1149 (IGN)**.
The source branches remain independent until their predecessors land. #1009 is
owned by trygvehhh; changes to its branch or review are for its author/maintainers.
A combined branch in radianx's fork is validation evidence, not a request to
merge all three contributions as one upstream PR.

Use one `INFRASTRUCTURE_SUPPLEMENT_URLS['local-dams']` array. Keep the main OSM
URL first, then append Norway and Argentina. Preserve `nveDamFields`, translated
NVE cards, the NVE voice fields and schema pins from #1009, and the shared
`loadInfrastructureFeatures` result (`{ features, error }`) from #1149 in both
renderer and analyst callers. Never replace an existing supplement list.
Repeated URLs load once. Features are concatenated; display names are not keys.
An optional source failure preserves every healthy source, reports the error,
and leaves the partial result uncached for retry. Main failure and abort reject.

The combined label is `OpenStreetMap / OpenInfraMap · NVE · IGN Argentina`.
Attribution is independent: OSM contributors / ODbL via Open Infrastructure Map;
NVE / NLOD; IGN's own reuse terms. Keep all three entries in DATA_SOURCES and the
credits panel. Map `props.source === 'nve'` explicitly, keep its full stable
`nve-dam-*` ID (a dam number can be shared), and leave absent dates null.
`find_infrastructure` credits only sources in the returned rows after limiting;
empty results have null attribution. NVE facts and IGN provenance coexist.

## Snapshot counts

| Composition | OSM features | NVE features | IGN features | Total features | Analyst records |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original OSM | 704 | 0 | 0 | 704 | 703 |
| #1152 | 706 | 0 | 0 | 706 | 705 |
| #1149 | 704 | 0 | 121 | 825 | 824 |
| #1009 | 704 | 4,141 | 0 | 4,845 | 4,844 |
| #1009 + #1152 | 706 | 4,141 | 0 | 4,847 | 4,846 |
| #1149 + #1152 | 706 | 0 | 121 | 827 | 826 |
| All three | 706 | 4,141 | 121 | 4,968 | 4,967 |

The one-record gap is OSM relation 19953989 (runtime ID `-19953989`,
`HE Podlubnik - Centrala`), whose MultiLineString has no supported representative
point; it is not a newly removed duplicate. Cesium entity counts
can differ from feature counts because multipart geometries expand.
The combined totals are snapshot expectations, to be checked against the actual
combined tree, not claims about the standalone branch's installed sources.

Deduplication stays auditable at acquisition: #1009 keeps one fuller record for
NVE dam 4390 at the same position; #1149 excludes two OSM overlaps and two
non-dam source classifications, retaining both uncertain unnamed pairs. Do not
merge nearby structures or namesakes across sources without identity evidence.
Rebuild IGN against #1152's actual OSM file and retain the exclusion audit.

At landing, reconcile README, DATA_SOURCES, INFRASTRUCTURE-LAYERS, CURRENT-STATE,
the dam-pack READMEs, factory source-label assertions and dataset-count pins to
the sources actually present. Regional tests must tolerate healthy sibling packs.
Run the dataset/checksum builders offline, source/analyst/renderer/voice tests,
repository checks, full unit suite, build, tracking and infrastructure browser
gates on the resolved candidate. Preserve each original PR head as a merge
parent in the verification branch; do not rewrite the other contributor's commits.

The original OSM relation 19953989 has both Polygon and MultiLineString
representations with the same source ID. Preserve both geometries; the analyst
source returns its supported Polygon once. Do not collapse geometries by ID.
Selected map contexts and renderer analyst records retain each provider, just
as `find_infrastructure` does.
