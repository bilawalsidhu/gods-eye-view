- Brazilian-registered aircraft (PP, PR, PS, PT, PU) show their build year,
  seat count and type of operation on the tracked label, from ANAC's open
  aircraft registry (RAB). General aviation that adsbdb does not know is
  matched on its callsign mark when the transponder is Brazilian. Only
  technical columns are read; owner and operator data never leave the file
  (IMBrandao, #1554).

- Parallel lookups after restart now share the RAB disk-cache read before
  deciding whether ANAC needs another download (IMBrandao, #1554).
