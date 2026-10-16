# GSHHG land/sea mask

Bundled 1/8° three-state global land/sea bitmask — synchronous ocean-click
gating and drift-beaching fallback with no network dependency. Codec:
`src/data/landSeaMaskCodec.js`; loader: `src/data/landSeaMask.js`.

| File | Grid | States (2 bits/cell) |
|------|------|----------------------|
| `land-sea-mask.bin` | 2880×1440 (1/8°), row 0 starts at lat −90, col 0 at lon −180 | 0 water · 1 land · 2 coastal-mixed · 3 reserved |

**Source:** GSHHG v2.3.7 (Global Self-consistent, Hierarchical,
High-resolution Geography), intermediate resolution `gshhs_i.b` extracted from
[`gshhg-bin-2.3.7.zip`](https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-bin-2.3.7.zip)
(SOEST Hawaii, fetched 2026-08-29).
`gshhs_i.b` SHA-256: `7d44bf4e16efe6056ff9d147ac0af189bbf0c16a31608426ef63ff8a91c418db`

**License:** LGPL-3.0 (Wessel & Smith, GSHHG — see DATA_SOURCES.md for the
credit line).

**Level semantics** (GSHHG hierarchy → fill parity): L1 continents/islands →
land, L2 lakes → water (Great Lakes NDBC buoys stay clickable), L3
island-in-lake → land, L4 pond-on-island → water, **L5 Antarctica ice front →
land**, **L6 grounding line → skipped** (the ice front is the land boundary;
L1 excludes Antarctica entirely).

**Transform** (deterministic, `scripts/build-land-sea-mask.mjs`):

- Native .b binary parsed by `src/data/gshhg/parseGshhg.js` (11×int32
  big-endian per-polygon headers, micro-degree vertices; zero dependencies).
- Even-odd scanline rasterization at cell-center latitudes
  (`src/data/gshhg/rasterizeMask.js`), levels filled ascending; per-ring
  longitude unwrap with mod-2880 column writes (dateline-safe); the
  globe-circling Antarctica ring is closed through the south pole via
  artificial seam edges (fill-only, never marked coastal).
- Every real shoreline edge sampled at half-cell steps (0.0625°) marks its
  cells coastal-mixed; coastal overrides interior fill and is never trusted
  as land or water downstream (clicks probe, drift never beaches there).
- Packed 2 bits/cell, 4 cells/byte, LSB-first, behind a 16-byte `GEVM`
  header (`src/data/landSeaMaskCodec.js`).

**Size budget:** exactly 1,036,816 bytes (16-byte header + 2880·1440/4),
pinned by `src/data/landSeaMask.test.mjs`.

**Regenerate:**

    node scripts/build-land-sea-mask.mjs path/to/gshhs_i.b
