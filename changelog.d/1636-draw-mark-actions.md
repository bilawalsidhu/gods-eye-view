- Draw rows take an application's own actions: `createApplicationTools({
  drawMarkActions })` adds buttons to drawn areas' and lines' rows, each given
  the shape's `[lon, lat]` geometry, with what it answers shown under the row.
  The standalone build passes none and is unchanged (samehkhamis, #1636).
