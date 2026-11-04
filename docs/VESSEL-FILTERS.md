# Vessel list and display filters

Enable **Live Vessels** in Data Layers to show the **Vessels** app in the right
rail. Turning Live Vessels off hides both the app and its menu button. The Data
Layers row offers four independent toggles and a **List & filters** shortcut:

- **Declutter** reduces icon density at camera altitudes of 100 km and above.
  Choose Balanced or Sparse in the app. Zooming closer shows every matching
  vessel; turning this filter off also restores every matching in-view vessel.
- **Underway only** shows vessels with a reported speed above 1 knot. This is a
  speed-based filter, not an inference of AIS navigational status.
- **Vessel types** enables the app's type checklist. Cargo, tanker and passenger
  types are initially selected. Unknown AIS types have their own checkbox.
- **Speed range** applies inclusive minimum and maximum speeds in knots.
  Unknown speeds, including AIS's unavailable value of 102.3, do not match an
  enabled speed filter. Turning a toggle off preserves its configured values.

Selected vessels bypass manual filters and decluttering. Civilian vessel names
remain hidden on the map until selected; military vessels retain the existing
ambient-name exception. Display filtering does not delete source records or
alter analyst queries, ingestion, history or feed polling.

The app lists all loaded vessels matching the manual filters, including vessels
hidden by decluttering, with 50 rows per page. Search name, MMSI, IMO, destination
or vessel type, then click a row to inspect it. The total counts the loaded feed;
it does not imply worldwide coverage.

Decluttering uses stable identity-hashed winners in Earth-fixed cells, and a
padded camera frustum keeps nearby vessels ready during pans. It runs on the
existing vessel visibility cadence, with an immediate pass for filter changes.
The list refreshes once a second only while the app is open and the document is
visible. It creates no new source poller or continuous render hold.

Preferences are saved locally under `gev:vessel-display-filters:v1`. Search text
and pagination are transient. Turning off the feed preserves filter preferences.

Verification:

```sh
node --import=./build/registerVue.js --test \
  src/data/vesselDisplayFilters.test.mjs \
  src/layers/vessels/displayFilters.test.mjs \
  src/ui/vesselPanel.test.mjs src/ui/vesselPanelView.test.mjs
node scripts/qa-vessel-filters.mjs
```

The browser check supplies 400 synthetic vessels through production
reconciliation and rendering, exercises each quick toggle and combined filters,
selects a hidden vessel from the searchable list, and checks app availability
across feed disable/enable transitions.
