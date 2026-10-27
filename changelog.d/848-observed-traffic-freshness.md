- Keep CCTV observed-traffic age labels aligned with each source's configured
  freshness budget: stale records stay marked STALE even in a mixed partial
  snapshot, and longer source windows are not prematurely marked stale.
  Presentation only; no new camera collection or traffic actuation. (#848)

- Resolve equal-time CCTV camera observations and equal-count class labels
  in locale-independent code-unit order, so language settings or provider
  record order do not change the rate displayed for the same evidence.
  Read-only presentation; no additional camera collection or inference. (#848)
