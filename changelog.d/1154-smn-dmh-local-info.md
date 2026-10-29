- Local Info and regional briefs prefer nearby SMN ground-station observations
  around Argentina, with station, distance, source-clock time and attribution.
  Missing, expired or distant observations fall back to Open-Meteo. No new layer
  is added; atmospheric effects retain their existing Open-Meteo provider.
  (radianx, #1154).

- Translate station attribution in Local Info and select the nearest eligible observation for each query location, while sharing cached forecasts and news across nearby queries. (radianx, #1154).

- Reconcile SMN and DMH observations in overlapping coverage, select stations at each exact query point, coalesce model fallback, and keep independent provenance, expiry and clearing in Local Info. Add integration, UI and tool regressions. (radianx, #1153, #1154).

Includes Simplified Chinese, Traditional Chinese, Ukrainian, Italian and Brazilian Portuguese UI copy and locale regressions, preserving source attribution, interpolation and locale-specific number/date formatting.
