- Add the Ocean Currents layer: the HYCOM / CoastWatch / IOOS HF-radar surface
  current field served in the wind layer's manifest and grid shape and drawn
  through the wind renderer, which gains a no-data value, regional grids, a
  per-field speed scale from the field's median speed and per-path speed
  colour. Globe views use a cached 1 degree global lattice, regional views the
  fetched sub-grid, coastal views an HF-radar analysis over the global field;
  the legend names the tier, its age and the radar holdout RMSE. Streamline
  density follows a line-coverage target so zooming in keeps the same amount
  of line on screen, and a view that crosses a tier line refetches at once.
  The three field fetchers read upstream bodies through a streaming byte cap
  (MarioDanielPanuco, #1188).
