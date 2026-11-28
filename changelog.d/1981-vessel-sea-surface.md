- Let vessel models float on a moving sea surface.
  `createApplicationCatalog({ seaSurface })` takes an optional sea surface,
  asked once a frame for its height and slope at a longitude and latitude:
  each AIS vessel model is raised by the height under it and tilted so its
  deck lies on the slope (`fleetModelTilt`). Without one, models stand level
  as before (samehkhamis, #1981).
