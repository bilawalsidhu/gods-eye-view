- Restrict billed CCTV Street View fallbacks to registered catalog cameras and
  server-owned location/pose; ignore untrusted client coordinate overrides.
- Share a per-process admission service across CCTV plugin instances with
  configurable 16/client, 32/global attempts per minute and a rolling 512
  attempts/day cap by default. Refused requests degrade to a synthetic image.
- Coalesce in-flight calls to the same camera/pose, bound concurrency and image
  response bytes, and cool down failed attempts without storing Google's
  completed image payloads.
- Preserve upstream snapshot priority, forwarded-request refusal and existing
  HLS/player routes. These in-memory counters are not provider billing limits
  and reset on restart or across separate server processes.
