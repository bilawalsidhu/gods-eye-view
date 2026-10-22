# T13b — vessels on Navara

Review base: `42c4c41a`; reviewed commits `132a49df..7962c139`. Validation: 2026-10-22, headless Chromium / Metal, local dev server on port 4193. All vessel evidence is synthetic; it does not assert availability of the live AISStream service.

**Acceptance remains open:** the city uncapped-work gate is reproducibly 1.1087× (limit 1.1×); functional vessel parity is validated.

## Implementation and review fixes

Vessel chevrons use one growing sprite bank and a runtime atlas; cards retain the shared overlay host. Selection uses the existing vessel click rules through the engine dispatcher. Navara trails use `engine.lines`; Cesium keeps its entity-polyline trail to retain visibility under photoreal tiles.

Review exposed an upload notification lost when a bank is created after an empty commit or grows. CPU records and cards existed while GPU chevrons did not. The bank now schedules its upload in both cases. The world-focus event now uses the shell's engine, so clicking a vessel on Navara actually flies to it. Hidden and removed model instances are rejected before accepting GPU picks with unknown radii.

The benchmark now fails its process when a threshold fails, compares unrounded ratios, starts timing before layer listeners, and seeds/verifies all 12000 vessels at every pose. Previously the area-filtered source silently reduced the population near a port.

## Parity checklist

| Item                | Evidence                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. View             | `qa-vessels-engines`: 20/20. Equatorial global/city/orbit/port visible counts: 6105/951/1037/178 on both engines. Card cohorts: 11/9/142/38 on both. Anchors agree to displayed 0.00 px. City/orbit/port solid chevron fill samples differ by 0 per channel. |
| 2. Selection        | Real clicks select the chevron and full card; empty sea and Escape clear selection. Clicking a flight transfers ownership to flights and clears vessel inspection.                                                                                           |
| 3. Focus            | Actual camera travel asserted, then cross-engine position <=1 m and heading/pitch <=0.1 degrees. Measured differences round to 0.000000 m / 0.000000 degrees.                                                                                                |
| 4. Follow           | Vessels do not follow, matching Cesium; another layer's follow releases vessel selection.                                                                                                                                                                    |
| 5. Queries/voice    | find/select/nearby/all/detectable/hasContact answers agree for the same MMSI. Visibility and view-state voice actions pass; viewer-only actions still refuse on Navara.                                                                                      |
| 6. Share            | Layer enabled state restores on either engine. Selected-vessel identity is not encoded in existing share links (pre-existing limitation, not claimed supported).                                                                                             |
| 7. Layer QA         | Datum 4/4 per engine; Rotterdam and Houston cards pass per engine.                                                                                                                                                                                           |
| 8. Idle             | AIS owns its continuous-render hold only while enabled; release is asserted.                                                                                                                                                                                 |
| 9. Lifecycle/errors | Ten enable/disable cycles leave no additional mover sets; no console errors.                                                                                                                                                                                 |

W1 totals: Cesium 18/18, Navara 19/19. `--compare` reports parity. Regression checks: Navara flights 24/24, military 26/26.

## Gates

- Node 26 and calibrated Node 24.14: 7106 ordinary tests, 7105 pass, 1 skip, 0 fail. Node 24 allocation probes: 1 focus + 14 overlay tests pass.
- Boundaries and formatting pass; build and panel build pass.
- Main chunk: 2895623 bytes raw, 898872 gzip; no three/Navara in initial chunks.
- Cesium engine contract: 73/73. Navara first run 78/79 (tile-sharpen metric); isolated repeat 77/79 (sharpen passes, idle and JFK surface height fail). Final isolated repeat: **79/79 pass**. Earlier failures remain recorded as intermittent contract failures.
- Engine shell: Cesium 23/23, Navara 25/25, cross 4/4.

## Performance

Uncapped results (3-run medians):

| Scene  | Cesium work p95 ms | Navara work p95 ms |  Ratio | Gate |
| ------ | -----------------: | -----------------: | -----: | ---- |
| global |                6.1 |                5.2 | 0.8525 | PASS |
| city   |                4.6 |                5.1 | 1.1087 | FAIL |
| orbit  |                6.4 |                5.5 | 0.8594 | PASS |

Vsync results (3-run medians):

| Scene  | Cesium interval p95 ms | Navara interval p95 ms |  Ratio | Long frames C/N | Gate |
| ------ | ---------------------: | ---------------------: | -----: | --------------: | ---- |
| global |                     19 |                   18.9 | 0.9947 |             0/0 | PASS |
| city   |                   18.7 |                   19.5 | 1.0428 |             0/1 | PASS |
| orbit  |                   19.7 |                   19.1 | 0.9695 |             0/1 | PASS |

All runs use 12000 resident contacts (validated after each measured window), `look=minimal`, 3 runs per engine, global/city/orbit poses, 10 seconds per measurement. Uncapped gate: work p95 ratio <=1.1. Vsync gates: interval p95 ratio <=1.1 and >33 ms frames <= Cesium +2 per 10 seconds.

A focused city repeat with a **12-second warm-up**, three runs per engine, reproduced exactly the same median: Cesium 4.6 ms, Navara 5.1 ms, ratio **1.1087**, FAIL. The threshold was not relaxed and this task is not marked fully accepted. A 10-second CPU sampling profile on the Navara city pose attributes 42% of samples to `uniformMatrix4fv`, 3.1% to `updateMatrixWorld`, 1.7% to mover camera updates, and 0.6% to vessel `updateVisibility`. This points to scene/driver submission as the dominant cost and matches the separately recorded military-city concern; it does not establish a vessel-only performance fix.

A narrow experiment replacing the per-frame canvas DOM height read with the renderer's cached CSS size did not improve Navara city work p95 (5.1 ms; Cesium 4.5 ms; ratio 1.1333 across three runs). It was reverted; the validated production code remains `cdc7c8d`.

Raw per-run scene measurements and gate outcomes are retained in [performance.json](performance.json). The existing benchmark defines its long-frame counter at >33.4 ms (reported by the harness as “>33 ms”); that cutoff was preserved.

## Known limitations and first-run failures

- The original global camera at longitude -40 / latitude 30 / height 15000 km has the already-known Cesium/Navara nadir-frame mismatch: card anchors differ by up to 2.47 px and the chosen card cohort can differ. The equatorial global view isolates vessel rendering parity; this engine camera issue is not fixed here. Crowded global glyph colours remain informational because neighbouring glyphs overlap; isolated samples at the other three poses gate colour parity.
- The first Houston Cesium card capture had zero overlay entries despite retaining the injected rows and settled tiles. The isolated repeat passed (8 entries, 5 painted); the initial failure was retained in the QA log.
- Cesium `engine.lines` under photoreal tiles remains a separate blocker. Its vessel trails deliberately keep the existing entity path.
- This task does not implement satellites, launches, phase 4, or fix the separately recorded military-city tile-render cost.

## Local evidence and reproduction

Screenshots: [global](global-side-by-side.jpg), [city](city-side-by-side.jpg), [orbit](orbit-side-by-side.jpg), [port](port-side-by-side.jpg), Cesium left / Navara right.

Machine-readable results are under gitignored `qa-artifacts/t13-final/` and `qa-artifacts/vessels-engines/report.json`; card/datum captures are under `qa-shots/`. Use an explicitly supplied, unreserved dev URL for all scripts. Commands:

```sh
node scripts/qa-w1-layers.mjs --base-url=http://127.0.0.1:4193/ --layer=ais-live-vessels --engine=cesium
node scripts/qa-w1-layers.mjs --base-url=http://127.0.0.1:4193/ --layer=ais-live-vessels --engine=navara
node scripts/qa-vessels-engines.mjs --base-url=http://127.0.0.1:4193/
node scripts/qa-vessel-cards.mjs --url http://127.0.0.1:4193/ --engine navara --data synthetic
node scripts/qa-vessel-datum.mjs --url 'http://127.0.0.1:4193/?qaFeed=vessels:fixture' --engine navara
node scripts/qa-engine-bench.mjs --base-url=http://127.0.0.1:4193/ --scenario=w1-fleet --layer=ais-live-vessels --count=12000 --engine=both --navara-look=minimal --runs=3 --heap-seconds=0
# Repeat the last command with --vsync. Performance runs must be sequential.
```
