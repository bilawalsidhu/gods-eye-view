# TLE/OMM sources (collected 2026-11-08)

Files: `<norad>.tle` (3-line TLEs, sorted by epoch, deduplicated on numeric element content, checksums verified),
`<norad>.omm.json` (full Space-Track OMM records from OMPub/RSO), `index.csv` (epoch, lines, and every source that carried each element set).
All content is untrusted downloaded data; nothing from it was executed.

## Worked
1. **OMPub/RSO "Orbital Witness" daily archive** (main source; one element set per object per day, the latest Space-Track GP_HISTORY row each day).
   Ledger: https://raw.githubusercontent.com/OMPub/RSO/node/ledger.json
   Bundles: https://github.com/OMPub/RSO/releases/download/rso-archive-YYYY-MM-DD/rso-archive-YYYY-MM-DD.tar.gz (catalog.json.gz inside)
   Downloaded 2026-09-18 through 2026-10-27. Source tag in index.csv: `OMPub_RSO:<archive date>`. Found through KeepTrack's public OpenAPI (`/v4/rso/{date}` proxies these releases).
2. **jazzpi/ssa**, `data/cosmos-2612-iceye-x36.csv` (Space-Track OMM CSV with TLE lines; epochs 2026-10-16 to 2026-10-19, several per day, including revised re-issues of the same epoch).
   https://raw.githubusercontent.com/jazzpi/ssa/HEAD/data/cosmos-2612-iceye-x36.csv
3. Single snapshots found in other GitHub repos (searched across full git history):
   - code-lab-org/tatc `docs/validation/socrates_2026-10-25.tle` (59103, epoch 2026-10-24)
   - Atharvchaskar008/EDITH `deploy/showcase/runs/20261009T2252Z/catalog.json`, `addons/a_history/out/catalog_enriched.json` (epochs 2026-10-08/09)
   - shishird-03/Orbitguard `data/catalog.tle` (epochs 2026-10-15)
   - Out of window (earlier in 2026): Proxy939/AstraShield `data/cache/celestrak_active.tle`, ColaBear101/SattrackSlop `data/catalogue.txt`, Sky-OuO/Pc_TCN `data/collected_tle_datas_2026*.json`, kris70lesgo/helix `coral/data/helix_core/satellites.jsonl`
4. Current element sets only (Nov 7-8 2026, outside the window): n2yo.com satellite pages, orbitalradar.com/satellite/<id>, celestrak gp.php?CATNR=68762, tle.ivanstanojevic.me, db.satnogs.org API.

## Failed / not useful
- web.archive.org: every connection reset through the agent proxy (CDX and snapshots). archive.org/wayback/available reported no snapshots of celestrak gp.php?CATNR=59103/68762 for Oct 2026.
- CelesTrak: serves current data only. Connections were reset some of the time (gp.php?CATNR=59103, last-30-days, supplemental).
- SatNOGS DB `/api/tle/?norad_cat_id=`: latest TLE only, no history. For 68762 it returned an empty list.
- KeepTrack: /satellite/<id> pages are behind a Cloudflare challenge (403). The v4 API needs a key (401), and its OpenAPI has no per-object history endpoint. The v2 API was shut down (410).
- tle.ivanstanojevic.me, n2yo, orbitalradar: latest set only.
- Marco Langbroek blog (sattrackcam.blogspot.com), keeptrack.space deep-dive, integrityisr.com, diplomacyandlaw.com: analysis only, no TLE text.
- zendir-dev/space-range-scripts and DigitalArsenal/space-data-network-modules: derived or illustrative data only (May 2026), or a local archive that is not in the repo.
