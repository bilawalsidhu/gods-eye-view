# Coordinated layer-token allocation

Based on upstream main `2470b39f88c6566ff82fc1c1e9d05757df3546e8` (35 reservations).
This proposal preserves every published ID/token pair and reserves one contiguous
batch before the feature PRs land. It does not activate any layer.

| PR    | Layer ID                   | Reserved token |
| ----- | -------------------------- | -------------- |
| #1316 | `local-usgs-water`         | `9`            |
| #1316 | `local-usgs-lakes`         | `00`           |
| #1316 | `local-usgs-springs`       | `01`           |
| #1143 | `caba-traffic-enforcement` | `02`           |
| #1565 | `river-levels`             | `03`           |
| #1583 | `shipwrecks`               | `04`           |
| #1584 | `air-accidents`            | `05`           |

The next free token after this batch is `06`. The existing checker requires
contiguous allocation: assigning only `02` or `03` against current main would
fail while `9` is free. Merge this ledger batch first, then retain all 42
reservations on each feature branch. Feature PR order is then unrestricted.
This is a proposal until maintainers accept it. Recheck fresh main before landing;
if a competing assignment has already been published, that published mapping wins.

## Feature-branch updates

- Byrd-IT (#1316): retain `9/00/01`, adopt the complete ledger and its pinned
  42-reservation test. Rebase and recalculate runtime layer counts and any voice
  schema pins for the actual merged feature set.
- radianx (#1143): replace provisional `6` with `02` in the runtime registry,
  token tests, CABA documentation and PR description; retain published Sea Marks
  `6`, Ski Pistes `7`, Drone Airspace `8`, and all other upstream registrations.
- IMBrandao (#1565/#1583/#1584): replace provisional `9` with `03/04/05`
  respectively in the registry, token tests, CURRENT-STATE, changelog and PR
  descriptions or example links wherever referenced. Retain all ledger rows.

Ledger-only reservation leaves 35 runtime layers and voice tools unchanged.
If only these five feature PRs subsequently land, the final runtime registry has
42 layers (+3 USGS and +1 for each other PR). The application catalog is separate: it stays at 37 for this ledger-only batch
and would reach 44 with those same seven feature layers. In isolation against
this base, USGS needs 38 registry / 40 catalog entries, and each one-layer PR
needs 36 registry / 38 catalog entries. Intermediate counts reflect only
features actually merged; do not set runtime counts to the reservation count.
Recompute schema hashes only when the actual tool/schema content changes.

Run `npm run layer-token:check -- --base-ref upstream/main`, ledger/codec tests,
and affected catalog/composition/share tests after each rebase. Do not weaken the
allocator or add compatibility aliases for a token already owned by another ID.

## Shared links

All mappings already published on main remain unchanged, including `6` for
Sea Marks. The new reservations are not active decoder entries until their
features land; unknown enabled-layer tokens continue to reject the payload.
Old CABA preview links using `6` and three incompatible IMBrandao previews using
`9` cannot all retain their meaning in schema v2: the URL has no branch identity.
Regenerate those preview links with their assigned tokens. USGS previews using
`9/00/01` keep their mapping under this proposal. ID-based local state does not
need a token migration. Never reassign a published or retired token.

Pre-reserving makes all seven assignments permanent if this coordination PR
lands, even if a feature is later withdrawn. That costs seven namespace slots
but needs no allocator exception, alias, or URL-version change.
