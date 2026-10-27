- Harden the Tarktee (Estonia) DATEX2 camera catalog fetches: refuse redirects,
  cancel both response streams when either response fails or overflows the 4 MB
  byte cap, and deduplicate camera IDs before per-pack prioritization
  (yaka0007, #1233).
