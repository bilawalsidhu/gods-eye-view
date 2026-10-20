- Harden the Tarktee (Estonia) DATEX2 camera catalog fetches: refuse redirects,
  abort pending siblings and cancel received or late response streams when either
  request fails before headers or overflows the 4 MB
  byte cap, retain the shared 30 s dual-XML fetch deadline, and deduplicate camera
  IDs before per-pack prioritization (yaka0007, #1233).
