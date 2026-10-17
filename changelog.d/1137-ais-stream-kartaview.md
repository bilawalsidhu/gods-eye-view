- Prune AISStream static vessel records when vessels expire or are evicted,
  throttle cache pruning to eliminate event loop starvation under high message
  rates, detach abort listeners upon task dequeue in the street-level limiter,
  and harden sequence stepping against unhandled onStep errors (subbareddy123sub,
  #1137).
