- Clear ISS joint samples and station-clock liveness when the opt-in
  NASA telemetry socket drops. A reconnected feed must supply new joint data
  rather than presenting the previous connection's angles as live
  (follow-up to ZloyS's #1767 and IMBrandao's #1690).
