# God's Eye View — Accessibility conformance ledger

Updated: September 20, 2026

Status of this console against WCAG 2.1, criterion by criterion. This is the
authoritative accessibility record; the fix history lives in
[PLAN.md](PLAN.md) (Phase 4) and the audit harness is `scripts/qa-a11y.mjs`.

## How to read this

Conformance claims here are of three kinds, and each entry says which:

- **Automated** — the axe-core audit (`scripts/qa-a11y.mjs`, axe 4.13.0),
  run against the live app in two states (boot, panel-expanded), reporting
  **0 violations** across the `wcag2a`, `wcag2aa`, `wcag21aa`, and
  best-practice rule sets (re-verified 2026-09-20 after the sonarjs
  refactor waves). The 2 `incomplete` results per state are axe's
  `color-contrast` / `color-contrast-enhanced` probes, which cannot
  statically evaluate text composited over live globe imagery — not
  failures; the compensating evidence is the pinned worst-case composite
  measurement below.
- **Pinned test** — a unit test in the repo asserts the property, so
  regressions fail CI.
- **Manual assessment** — human judgment recorded here with its rationale.
  This is where most AAA claims live, for a structural reason: **axe-core
  4.13.0 contains zero rules tagged `wcag21aaa`** (verified against the
  installed package), and only three rules carry the WCAG 2.0 `wcag2aaa`
  tag (`header-present`, `identical-links-same-purpose`,
  `meta-refresh-no-exceptions`). Automated AAA coverage is therefore
  near-zero industry-wide; a AAA claim that stops at "the axe AAA pass was
  clean" is not a claim. The ledger below does the manual work explicitly.

## Pinned evidence (tests that fail CI on regression)

| Property | Test |
| --- | --- |
| Worst-case text contrast over the full composite (imagery ← glass ← text alpha), scrim floor ≥ 0.8 | `src/uiContrast.test.mjs` |
| Zero click-only custom controls; every ARIA interactive role on a non-semantic element carries `tabindex="0"` | `src/inputAccessibleNames.test.mjs` |
| Shell landmark roles (`application` / `banner` / labeled `region`s), no duplicate banner | `src/shellLandmarks.test.mjs` |
| Async layer-chip state folded into accessible names; polite live-region announcements for self-driven transitions | `src/data/manager.test.mjs` |

## WCAG 2.1 Level A / AA — gate: PASS

Axe audit clean in both audited states (above); the specific defects found
and fixed along the way (focus-visible rings on the DISPLAY rail controls,
accessible names on nameless sliders and the search input, decorative-glyph
`aria-hidden`, launcher landmark/role corrections) are recorded in PLAN.md
Phase 4. Contrast is verified by measurement, not by bare swatch: the full
composite was measured (imagery ← `--glass-bg` ← text alpha), the old
tokens failed worst-case AA (2.96:1 / 3.24:1), and the scrim-first fix
(0.72 → 0.82 glass, text alphas → 0.7) yields 9.69:1 / 5.67:1 worst case
and 8.19:1 for `--text-dim` on `--bg-dark`, with identity hues untouched.

## WCAG 2.1 Level AAA — criterion ledger

Verdicts: **MET**, **PARTIAL** (met with a documented, bounded deviation),
**N/A** (criterion cannot apply to this product), **UNMET** (known gap,
accepted with rationale or queued).

| SC | Name | Verdict | Basis |
| --- | --- | --- | --- |
| 1.2.6 | Sign Language (Prerecorded) | N/A | No prerecorded video content exists in the product. Manual. |
| 1.2.7 | Extended Audio Description | N/A | No prerecorded video content. Manual. |
| 1.2.8 | Media Alternative (Prerecorded) | N/A | No prerecorded media. (Cinematic clip capture is an output feature, not content presented to the user.) Manual. |
| 1.2.9 | Audio-only (Live) | N/A | No live audio-only media. Radio streams are user-initiated playback of external stations, start/stop under user control. Manual. |
| 1.4.6 | Contrast (Enhanced) | PARTIAL | AA contrast is met and pinned; AAA's 7:1 for normal-size text is not — `--text-secondary` worst case is 5.67:1 over glass-over-white imagery. Rationale: the background is arbitrary satellite imagery and the accent/IR/NVG/FLIR hues are pinned visual identities; the scrim-first policy (glass 0.82, alphas 0.7) raises contrast as far as identity allows. Automated: axe's `color-contrast-enhanced` probe returns `incomplete` over live imagery by design. Pinned: `uiContrast.test.mjs`. |
| 1.4.7 | Low or No Background Audio | N/A | Nothing plays audio the user did not start. Manual. |
| 1.4.8 | Visual Presentation | PARTIAL | The criterion targets prose passages; this console presents short readouts and panel labels, not blocks of text, so line-length/justification rules map weakly. No text-size lock is imposed; browser zoom operates normally. Manual. |
| 1.4.9 | Images of Text (No Exception) | MET | All UI text is real DOM text. Icon glyphs are decorative `aria-hidden` companions to text labels. Manual + markup census. |
| 2.1.3 | Keyboard (No Exception) | MET | A pinned census finds ZERO click-only custom controls in `index.html`; every interactive element exposes a native button or `tabindex` + role; focus-visible rings restored on the DISPLAY rail. Pinned: `inputAccessibleNames.test.mjs`. |
| 2.2.3 | No Timing | MET | No time limits on any interaction; data auto-refresh updates readouts without truncating sessions or input. Manual. |
| 2.2.4 | Interruptions | MET | Self-driven UI transitions (chip → loading → error → recovery) announce through a single clipped `role="status"` / `aria-live="polite"` region; nothing asserts focus or uses assertive announcement. Pinned: `manager.test.mjs`. |
| 2.2.5 | Re-authenticating | N/A | No authentication; state survives via share links and localStorage. Manual. |
| 2.2.6 | Timeouts | MET | No session timeouts; inactivity never discards user work (annotations persist locally). Manual. |
| 2.3.2 | Animation from Interactions | MET | `prefers-reduced-motion: reduce` is honored in 7 CSS blocks (`style.css`) plus JS callers (camera verbs, split-flap, logo gaze, cockpit cloud effects, first-run). Automated where CSS applies. |
| 2.3.3 | Animation from Interactions | MET | Same mechanism as 2.3.2, covering interaction-triggered motion (camera flights, panel transitions). |
| 2.4.8 | Location | N/A | The criterion targets wayfinding across a set of web pages; this is a single-view console with no page hierarchy. The equivalent information — where in the world the camera is — is the product's core readout (location bar + HUD geocode context). Manual. |
| 2.4.9 | Link Purpose (Link Only) | MET | Automated: axe's `identical-links-same-purpose` (one of its three `wcag2aaa` rules) ran clean in both states. |
| 2.4.10 | Section Headings | MET | Automated: axe's `header-present` rule ran clean; panels and the HUD carry heading structure. |
| 2.5.5 | Target Size (Enhanced) | UNMET | Dense tactical console: chips, sliders, and panel toggles sit below the 44×44 CSS px target. Accepted deviation — every control has a keyboard path (pinned census), and pointer density is a design requirement of the HUD. Queued consideration: raise hit areas without visual growth on the highest-frequency controls. |
| 2.5.6 | Concurrent Input Mechanisms | MET | Keyboard, pointer, and voice operate simultaneously; nothing restricts one mode while another is active. Manual. |
| 3.1.5 | Reading Level | N/A | No prose content; UI copy is labels and short operational readouts. Manual. |
| 3.1.6 | Abbreviations | UNMET | Domain acronyms (ADS-B, AIS, TLE, GTFS-RT) appear in labels without an in-product expansion mechanism. Accepted for the console's expert audience; full names live in the data-sources documentation. |
| 3.2.5 | Change on Request | MET | Context changes (basemap, style, layers, camera) occur only on explicit user action; no meta-refresh or auto-navigation. Automated: axe's `meta-refresh-no-exceptions` ran clean. |
| 3.3.5 | Help | PARTIAL | The first-run launcher orients new users; there is no per-control contextual help. Accepted gap; candidate for a future cycle (tooltips on the DISPLAY rail are the natural form). |
| 3.3.6 | Error Prevention (All) | MET | The product has no form submissions carrying legal/financial consequence; data entry is limited to search fields where errors are correctable by re-entry. Manual. |

### Tally

MET 12 · PARTIAL 3 · N/A 8 · UNMET 2 (25 AAA criteria total).

The two UNMET criteria (2.5.5 target size, 3.1.6 abbreviations) and the
three PARTIALs (1.4.6, 1.4.8, 3.3.5) are bounded, documented deviations
rooted in the product's nature — a dense real-time console over arbitrary
imagery for an expert audience — not open defects. They are re-assessed
whenever this file is updated.

## Regression harness

```bash
node scripts/qa-a11y.mjs            # gate mode; exits non-zero on violations
node scripts/qa-a11y.mjs --report-only
```

Report lands in `qa-shots/a11y/report.json`. The harness audited states are
boot and panel-expanded; the `wcag2aaa`/`wcag21aaa` tags are passed to axe
for future-proofing (axe 4.13.0 matches no `wcag21aaa` rules — see the
tooling note above), and the AAA assurance of record is this ledger.
