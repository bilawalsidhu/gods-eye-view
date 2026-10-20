- Make CCTV QA ground-sampling checks respect the active terrain regime and
  frame the actual calibration gizmo for the drag regression, preserving the
  photoreal completion floor and all drag invariants.
- Measure the tracking arrival regression on the first visible frame within
  250 ms, accounting for the 80 ms fleet cadence while rejecting a stale
  first-visible orientation instead of retrying until it is correct.
