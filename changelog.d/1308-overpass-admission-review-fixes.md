- Keep Overpass-backed layers working behind a reverse proxy: `/api/overpass`
  now uses the keyless same-site gate, admits forwarding headers and still
  refuses cross-site requests. Direct loopback requests keep their own
  admission window; proxied requests, including those a local reverse proxy
  relays over loopback, are admitted as remote traffic keyed by their socket,
  and IPv6 peers are keyed by /64, so neither LAN peers nor proxied users can
  exhaust the owner's admission. The upstream budget stays shared, so an owner
  cache miss can still be rate-limited (asturksever, #1308).
- Give the tracking arrival check a wall-clock budget per observed frame and
  retry only an inconclusive timeout: a timeout keeps every angle it
  measured, including a late frame's, and a wrong one fails without retry, so slow software-rendered
  frames no longer fail the check and a real violation is never retried into a
  pass (asturksever, #1308).
