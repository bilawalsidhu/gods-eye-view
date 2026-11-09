# Owner flags

`owner_flags.png` is one sheet of every owner country a satellite can be
marked with (`OWNER_COUNTRY_CODES` in `src/layers/satellites/classes.js`),
drawn at 40 × 30 px (twice the orbital readout's 20 × 15) in sorted code
order, 16 to a row, each followed by 2 transparent pixels so a scaled flag
never smooths into its neighbour. `src/ui/ownerFlag.js` loads it once at startup and draws
each flag from its cell; the layout is `src/ui/ownerFlagSheet.js`.

**Source:** the 4:3 SVGs of [flag-icons](https://github.com/lipis/flag-icons)
7.5.0 (a devDependency, used only to build the sheet).

**License:** flag-icons is MIT licensed (© Panayiotis Lipiridis). Country
flags themselves are not copyrightable designs in most jurisdictions.

**Regenerate:** `node scripts/build-owner-flags.mjs` (after adding an owner
country, or updating flag-icons). With the same flag-icons and sharp versions
a rerun reproduces both files byte for byte.
