- Add one keyless RTD VehiclePositions feed for Denver / Boulder, with a 70 km
  activation radius, exact static-GTFS bus/light-rail/rail classification and
  text-only operator/license credit. Only RTD preserves nonblank route IDs
  exactly during snapshot decoding; other feeds retain default trimming, and
  blank IDs remain null. Unknown, padded and unassigned RTD routes remain
  unclassified. Reuses existing transit polling, freshness and security policies;
  no arrivals, alerts or proxy history retention are added. The current credit
  remains unchanged pending human/RTD guidance on the agreement's clause 4;
  text-only credit is not treated as legal clearance (T-ravis-H, #1088).
