- FIRMS fire data loads on hosts where IPv6 is unreachable and IPv4 is slow to
  connect: a request whose every address fails to connect retries once over
  IPv4, and FIRMS warnings name the underlying connection errors instead of
  only `fetch failed` (jeffblakely, #1078).
