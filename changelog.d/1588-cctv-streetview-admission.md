- Restrict billed CCTV Street View fallbacks to registered catalog cameras and
  server-owned location/pose; ignore untrusted client coordinate overrides.
- Share a per-process admission service across CCTV plugin instances with
  configurable 16/client, 32/global attempts per minute and a rolling 512
  attempts/day cap by default. Admission refusals return HTTP 204 so clients
  retain their displayed frame; invalid/forwarded requests still get a synthetic image.
- Coalesce in-flight calls to the same camera/pose, bound concurrency and image
  response bytes, and cool down failed attempts without storing Google's
  completed image payloads. Server and client share camera heading/pitch defaults.
- Preserve upstream snapshot priority, forwarded-request refusal and existing
  HLS/player routes. These in-memory counters are not provider billing limits
  and reset on restart or across separate server processes.
- The per-minute windows are fixed (up to ~2x near a reset boundary), while
  the daily attempt budget is a sliding 24-hour count. At most eight distinct
  calls run concurrently; extra requests are declined without queuing. The
  cooldown map keeps at most 256 poses, so eviction may shorten a cooldown.
