- Coalesce identical concurrent terrain-height requests without adding cache or
  freshness policy. Each caller can cancel independently; the shared transport
  stops when the final waiter leaves, and abandoned keys cannot hide a retry
  (kvnloo, #889; cancellation review: quanticsoul4772).
