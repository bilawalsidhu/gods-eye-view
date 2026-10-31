- Add a Prohibited & Restricted Airspace layer for FAA prohibited (P) and
  restricted (R) special-use airspace. The keyless `/api/drone-airspace` proxy
  pages the public SUA FeatureServer, keeps a one-hour snapshot, and serves
  stale data when a refresh fails. Zones draw as ground polygons (red
  prohibited, orange restricted); selection shows name, altitude range, times
  of use and agency, and the row legend states the layer is informational only
  and does not include the UAS Facility Map or UAS flight restrictions. Off by
  default; share-link token `6` (mvanhorn, #1086).
