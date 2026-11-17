# Ports layer review evidence

Captured on 2026-11-17 with Chrome Headless Shell 156.0.8078.47.

- `live-globe.jpg`: live DOE NETL WPI markers, total count and partial-data notice.
- `live-facts.jpg`: selected Jebel Ali profile, separate throughput/capacity, source links and dates.
- `live-phone.jpg`: the same profile at a 390-pixel viewport, with no horizontal document overflow.
- `ports-demo.mp4`: accelerated 25-second fixture walkthrough of enabling the layer, navigation, selection, filtering, phone layout and disabling. The recording uses four synthetic WPI-shaped records and fixture imagery; it is not a live-data capture.

The live screenshots use the real DOE endpoint and imagery. The reviewed mirror returned 3,824 source records: 3,820 valid unique integer WPI identifiers, two non-integer identifiers and two duplicate identifiers. The exclusions are visible and the snapshot is labelled partial. Commercial supplements do not populate unknown WPI facility flags.

The implementation checkpoint (`0873415`) was published before browser verification. The full unit suite passed (14,435 passes including the allocation gates; four existing skips), as did the production build, formatting, translations, package boundaries and share-token checks. The focused ports source/lifecycle and Vue panel suite was rerun after the readability fix: 12 passes.

Reproduce the ports gate with a running development server:

```sh
node scripts/qa-ports.mjs
node scripts/qa-ports.mjs --live
node scripts/qa-ports.mjs --record
npm run test:track -- --offline-imagery
```

The stock tracking harness returned 97 passed, 6 failed and 4 skipped on both this feature and clean upstream `624c229`, with identical failure details. See [tracking-comparison.md](tracking-comparison.md); PR #1783 remains draft while that required gate is unresolved. No provider keys are needed for the ports layer. Filters are session-local; share token `03` restores only the enabled state.
