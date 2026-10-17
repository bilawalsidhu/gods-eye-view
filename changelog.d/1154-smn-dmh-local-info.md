- Local Info and regional briefs prefer nearby SMN ground-station observations
  around Argentina, with station, distance, source-clock time and attribution.
  Missing, expired or distant observations fall back to Open-Meteo. No new layer
  is added; atmospheric effects retain their existing Open-Meteo provider.
  (radianx, #1154).

- Localize Local Info provenance and keep news/model caching shared by geographic cell while reselecting SMN observations at the exact query point. (radianx, #1154).

- Reconcile SMN and DMH observations in overlapping coverage, select stations at each exact query point, coalesce model fallback, and keep independent provenance, expiry and clearing in Local Info. Add integration, UI and tool regressions. (radianx, #1153, #1154).
