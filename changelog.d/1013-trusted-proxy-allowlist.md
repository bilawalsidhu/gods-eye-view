- Support `GEV_TRUSTED_PROXY_IPS` to allow single-hop TLS-terminating reverse proxies
  (exact IPv4/IPv6 addresses and IPv4 CIDRs) to access cost-bearing endpoints while
  strictly rejecting multi-hop and extraneous proxy signals (#978, #1013). Proxied
  requests are excluded from ChatGPT OAuth loopback routes, and malformed CIDR/IP
  tokens fail closed.
