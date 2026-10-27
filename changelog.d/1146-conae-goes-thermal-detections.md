- Add optional CONAE GOES thermal detections to Active Fires with
  `CONAE_GOES_ENABLED=1`. The source works without a NASA key, uses an independent
  bounded cache and preserves FIRMS when CONAE is unavailable (and vice versa).
  GOES observations retain their UTC-3 acquisition times converted to UTC,
  CONAE attribution and unknown confidence; they are not confirmed wildfires.
  Active Fires reports partial satellite failures even with CONAE disabled,
  retaining available FIRMS detections. CONAE failures log their network/HTTP
  or parsing reason and retain the existing stale-cache/backoff policy.
  (radianx, #1146).

Includes Simplified Chinese UI copy and locale regressions, preserving source attribution, interpolation and locale-specific number/date formatting.

Unpublished FRP now has a neutral gray visual instead of implying measured
low intensity. Empty refresh/filter results remove previous render resources
and context registrations. FIRMS context labels retain their English tool-data
contract and localized display. Adds unit regressions and optional mixed-source
intensity/share-link integration gates for temporarily combining PR #1426.
