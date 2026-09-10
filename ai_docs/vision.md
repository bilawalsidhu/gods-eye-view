# i18n vision: English and Spanish

## Why we are doing this

God's Eye View should be usable by people who do not work primarily in English,
without weakening the speed, clarity, tactical visual language, or local-first
character of the application.

The first language beside English is Spanish. The initial Spanish locale should
be neutral international Spanish (`es`), with a glossary and catalog structure
that can later support regional variants or additional languages.

## Goal

Implement a durable i18n foundation and a complete Spanish translation of the
application-owned user interface while preserving the existing English
experience.

“Complete” means the normal user-facing product surfaces are covered:

- first-run onboarding and loading
- navigation, dock, Display, visual presets, map source, and Data Layers
- Cockpit and Context
- CCTV, radio, scenes, and Provider Settings
- loading, error, empty, retry, and toast states
- app-authored cards, telemetry labels, accessible names, and live regions
- locale-aware numbers, dates, durations, and relative times
- voice-control chrome and connection/execution status

The implementation must not alter internal layer IDs, status values, API
contracts, voice tool schemas, share-link formats, provider identifiers, or the
meaning of source attribution.

## Product principles

1. English remains the default, authoritative fallback, and compatibility
   baseline.
2. Translations are explicit and reviewable; do not infer them by replacing
   arbitrary English strings in the DOM.
3. Accessibility is part of localization. Visible labels, titles, placeholders,
   live regions, and accessible names must agree in the selected language.
4. Data truth is preserved. Provider names, callsigns, place names, headlines,
   source attribution, and raw upstream content remain as supplied.
5. The tactical interface has limited space. Spanish copy must be concise,
   glossary-consistent, and verified at desktop and narrow viewport sizes.
6. Adding another locale should require catalog work, not another UI rewrite.
7. The first release should be dependency-light and native to the existing
   vanilla JavaScript + Vite architecture.

## Intended user experience

On first visit, the app chooses a supported browser language when appropriate;
otherwise it uses English. The user can explicitly choose `EN` or `ES` from a
compact existing settings/dock surface. The choice is persisted locally and a
reload preserves the current share-link hash and camera state.

Locale precedence is:

```text
?lang=<locale> → saved preference → navigator.languages → English
```

Unsupported locales fall back to English. The document's `lang` and `dir`
attributes always reflect the active locale.

## What is intentionally out of scope

- Translating the entire README or developer documentation
- Translating provider/dataset names, callsigns, place names, news headlines,
  user annotations, or third-party attribution text
- Translating internal machine-readable values or changing URL/hash schemas
- Rewriting voice tools or server-side tool descriptions for Spanish
- Framework migration or a broad UI/component refactor
- Promising a Spain-specific or Latin-America-specific dialect in the first
  release

## Delivery strategy

The work should be implemented as a reviewable, upstream-friendly change rather
than an opaque bulk translation. Establish the i18n API and catalog contract
first, then parallelize independent extraction and translation work in isolated
Pi worktrees. A central integrator owns the merge, conflict resolution, full
test run, and browser verification.

The preferred team shape is one architect/integrator with no more than four
concurrent GLM-5.3-Flash workers:

- static shell and accessibility markup
- core UI, cockpit, Context, Display, and formatting
- data-layer presentation strings and statuses
- supporting surfaces, tests, documentation, and review tooling

Agents must have explicit file ownership. Multiple workers should not edit one
catalog or the same broad region of `src/ui.js` concurrently.

## Definition of success

The vision is achieved when:

- a user can select Spanish and complete the principal flows without an
  accidental mixture of English application copy;
- English remains visually and behaviorally equivalent to today;
- no missing translation keys occur in covered flows;
- Spanish accessible names and live-region messages are present;
- Spanish text fits the dense tactical layouts at desktop, constrained, and
  narrow viewport sizes;
- internal data, voice, API, and share-link behavior is unchanged;
- the repository build, unit tests, and tracking regression gate remain green;
- a native Spanish reviewer has checked terminology and tone;
- the PR includes screenshots, test evidence, scope, and explicit exclusions;
- future contributors can add a locale by extending catalogs and tests.

## Planning reference

The detailed engineering breakdown, file ownership, phases, estimates, Pi
workflow, and risk mitigations live in
[`i18n-implementation-plan.md`](./i18n-implementation-plan.md).

The expected implementation effort with a Pi team is approximately 24–40
elapsed hours for an upstream-ready change, with a model/API budget of roughly
$3–8 and a recommended orchestration cap of $15. Human native-language review
is separate from the model budget.

