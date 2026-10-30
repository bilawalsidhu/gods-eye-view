Adds an offline Director-to-Blender camera bridge related to #1081.

- Exports existing scene documents to a portable camera manifest.
- Preserves scene/shot IDs, WGS84 origin, ENU meters, lens, fps and timing.
- Imports editable Blender shot cameras with quaternion keys and timeline markers.
- Transfers cameras only; no imagery, terrain or buildings are exported.
- Uses Director seek interpolation and authored timing.

Validation:
- 12 focused JavaScript tests and four Python checks passed.
- Blender 5.2.2: 216 projections matched before save and 216 after reload.
- Full unit/allocation suite: 8,810 passed, 11 skipped, zero failed.
- That Windows run used a separate upstream test-path correction.
- Live Director checks: 12/12; tracking: 109/109 passed.
- Production build, formatting and package-boundary checks passed.
