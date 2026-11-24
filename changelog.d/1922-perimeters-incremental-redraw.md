- Fire Perimeters redraws only the pieces that changed when the timeline
  steps: with an id on every piece (WFIGS now gives one), new pieces are
  added, gone ones removed and aged ones recoloured in place. On a synthetic
  peak day of 1,000 pieces an hourly step's longest task on Cesium drops from
  about 450 ms to under 80 ms (German, @gekh, #1922).
