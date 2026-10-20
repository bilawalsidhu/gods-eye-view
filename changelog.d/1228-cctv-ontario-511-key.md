- Load Ontario 511 cameras again. 511on.ca's camera endpoint now requires a
  free developer key; set `ONTARIO_511_API_KEY` to enable the pack, which is
  otherwise skipped with one log line saying where to get a key
  (quanticsoul4772, #1228).
- Refuse Ontario catalog redirects and keep credential-bearing URLs and provider
  exception text out of failure logs; retain the Ontario licence attribution.
