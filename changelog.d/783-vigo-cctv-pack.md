- Add Concello de Vigo (Galicia, Spain) traffic cameras as an opt-in CCTV
  pack. The camera list is the keyless `camaras-trafico` ArcGIS FeatureServer
  on `datos.vigo.org` (about 60 cameras); frames are stills on
  `camaras.vigo.org`, upgraded from the catalog's `http://` links to HTTPS and
  pinned to that origin. That host sends no `Content-Type`, so for it alone the
  frame proxy recognises JPEG, PNG, GIF and WebP by their leading bytes; every
  other host must still declare a raster image type. The dataset's ODC-BY
  licence covers the camera list but the city has not confirmed the frames may
  be shown by a third-party app, so the pack is off unless
  `CCTV_VIGO_ENABLED=1`. The required credit "Fuente de los datos: Ayuntamiento
  de Vigo" appears in the CCTV panel and the Data attribution list
  (fquinzan-GZ, #783).
