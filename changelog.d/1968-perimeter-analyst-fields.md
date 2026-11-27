- Analyst queries on Fire Perimeters refuse a field the layer's source does
  not carry (`FIELD_UNAVAILABLE`) instead of answering zero, and count a fire
  at a fixed `analystPoint` when the source gives one, so an area count no
  longer changes with the camera (German, @gekh, #1968).
