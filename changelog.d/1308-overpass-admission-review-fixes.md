- Keep Overpass-backed layers working behind a reverse proxy: `/api/overpass`
  now uses the keyless same-site gate, admits forwarding headers and still
  refuses cross-site requests; loopback keeps its own admission window and
  IPv6 peers are keyed by /64, so a few LAN peers cannot lock the owner out
  (asturksever, #1308).
- Give the tracking arrival check a wall-clock budget per observed frame and
  retry an inconclusive timeout, so slow software-rendered frames no longer
  fail it (asturksever, #1308).
