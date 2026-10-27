# CONAE / FIRMS intensity integration check — 2026-10-27

## Reviewed revisions and scope

- #1146: `ca522bc316e796a2600f3f7b063f864518b125ef`
- #1426: `38d29f2beb22b5200b794751b32f1f21a0409e25`
- #1426 upstream base: `15de9d738c4a85be1a96726c6114181caef87eeb`

The two heads were merged locally on `integration/conae-intensity`. No merge,
commit, comment or other change was made to #1426 or upstream main. Only the
CONAE author's branch receives the corrective changes and regression gates.
This is deterministic fixture validation, not proof of live-provider reachability.

## Reproduced findings and fixes

1. Empty filtered sets stopped `renderCurrentLod` before removing previous
   entities/billboards/cards/pick indexes/context records. A zero-result view
   could therefore disagree with the counter and agent queries. The empty
   result now clears those resources. `empty-render.test.mjs` failed before
   the change (`false !== true`) and passes afterward.
2. Unpublished FRP was assigned a measured color: yellow on #1146 alone, blue
   at the 0 MW ramp stop in the joint tree. Unknown observations now use neutral
   gray (`#94a3b8`) in sprites, card accents and cells with no published FRP.
   Mixed cells retain the maximum of available measurements; an unknown value
   never overwrites a real maximum. Measured zero retains a measured color.
   The new regression failed before the correction (`yellow !== unknown`).
3. The existing FIRMS English-data-label regression failed on both the CONAE
   head and the initial joint tree. Restore English FIRMS tool/context labels
   and the display translation key in es/ru/zh-CN. CONAE thermal wording and
   attribution remain intact. Cards retain locale-specific formatting.

## Joint fixture matrix

The five observations are CONAE with unknown FRP/confidence, CONAE with 50 MW
and unknown confidence, FIRMS with 0 MW/high, 20 MW/nominal and 300 MW/low.

| Minimum FRP | Confidence | Shown | Unknown-data rule |
| --- | --- | ---: | --- |
| 0 MW | All | 5 | Both CONAE observations retained |
| 20 MW | All | 3 | Unpublished FRP excluded; published CONAE FRP retained |
| 0 MW | Nominal+ | 2 | Unpublished confidence excluded |
| 0 MW | High | 1 | Unpublished confidence excluded; measured zero retained |
| 20 MW | High | 0 | Previous render resources removed |

These are measurement requirements, not a reclassification of null confidence
as low or null FRP as a measured zero. Reset restores the original observations
with both nulls intact. The joint gate asserts the same locations and counts
for ingestion, analyst records and `get_active_fires`.

All six measured colors (0/5/20/50/100/300 MW), neutral unknown, selected and
ambient card content, cell counts/maxima, UTC `acqMs`, provider attribution and
unconfirmed-thermal-anomaly copy are covered. CONAE-only ingestion remains
keyless. Legacy token `w` options and compact share codes round-trip all five
filter combinations, including restoration before the initial ingestion.

## Merge-resolution contract

When combining these still-open PRs, preserve both source state and the new
filter/all-record state in `state.js`; keep CONAE's detection nouns and null
measurement copy in cards; keep both sources, the unconfirmed-fire disclaimer
and CONAE `acqMs` handling in `hazards.js`, alongside #1426's input filters.
In the joint model, check for unpublished FRP before `frpRampStop`; use
`cell.maxFrp` (not normalized heat) for #1426's measured cell colors. Retain the
neutral guard for null. Preserve the shared empty-result rendering fix.
Combine both locale additions and remove obsolete `FIRE · {frp} MW` and
`▲ {frp} MW` keys only in the joint tree.

The integration gates are deliberately under `scripts/`, outside baseline unit
discovery, since they require #1426's unmerged filter and compact-share APIs:

```sh
node --test scripts/qa-conae-intensity.mjs
node scripts/qa-conae-intensity-browser.mjs
```

The browser gate starts its own Vite server and intercepts `/api/firms` with
mixed fixtures. `PUPPETEER_EXECUTABLE_PATH` can select Chrome Headless Shell.
It verifies the real module's controls/counter/analyst results, empty overlay
entries and actual compact-link startup restoration. It never needs NASA keys.

## Validation evidence

Node 24.22.1. The corrected CONAE branch's full ordinary plan passed **8,625**
tests, with **2** platform/environment skips and no failures. Its separate
focus-allocation probe passed, as did all **14** world-overlay allocation probes.
The corrected joint tree's ordinary plan passed **8,849**, with **2** skips and
no failures. The optional joint matrix passed all **4** tests; the focused
CONAE/empty-render/interaction suite passed all **29** tests.

Production build, formatting, package/import boundaries and es/ru/zh-CN catalog
checks passed on the CONAE branch. A dedicated Chrome Headless Shell run passed
four mixed-source browser filter cases and restored 20 MW / High from an actual
short-link navigation. The loading screen was allowed to clear before capturing
the final screenshot. Source transport/parser/keyless aggregation tests remain
part of the full suites. This does not verify the live CONAE endpoint or NASA
credentials. Broader browser and joint allocation results are recorded below
when complete; incomplete runs must not be described as passing gates.

Final joint results: the focus allocation probe plus all 14 world-overlay
allocation probes passed. Production build, formatting (1,532 source files),
import/package boundaries and all 2,749 es/ru/zh-CN messages passed in the joint
tree. The complete `qa-firms.mjs --fixtures` browser gate passed **9/9**, including
painted detection/cell cards, keyless/stale states, selected-fire refresh and
CONAE-only selection with null confidence, source attribution and `acqMs`.
The separate tracking gate was also started as a broader smoke check; it is
not part of the mixed thermal matrix and must not be inferred from the 9/9.

The final locally retained integration revision is `cd5951ec` on
`integration/conae-intensity`. Browser runs blocked or lacked external map/font
assets; screenshots establish app lifecycle only, not basemap visual acceptance.
