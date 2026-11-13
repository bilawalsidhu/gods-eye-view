- Add Icelandic road cameras from the Icelandic Road and Coastal Administration
  (Vegagerðin) as a CCTV pack. The camera list is one keyless JSON request to
  `gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1` (about 500 views at 166
  stations); frames are JPEG stills in `www.vegagerdin.is/vgdata/vefmyndavelar/`,
  and only links inside that directory are registered. The catalog is fetched
  over https with redirects refused and a 2 MiB body cap. An explicit facing in
  the view description ("til vesturs", "í suður", "séð austur") sets a
  high-confidence heading; other views keep the low-confidence fallback pose.
  IRCA publishes the images under CC BY 4.0, credited in the Data attribution
  popover. Loads the 250 views nearest Reykjavík, Akureyri, Egilsstaðir,
  Ísafjörður and Selfoss; `CCTV_ICELAND_MAX_SOURCES` changes that cap and
  `CCTV_ICELAND_ENABLED=0` turns the pack off (daikaginza, #1617).
