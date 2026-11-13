- Add 112 French networks to the Transit layer, from Nice, Dijon, Angers,
  Brest, Le Mans, Metz, Amiens, Avignon and Valenciennes to small-town
  networks, the liO, Aléop and Rémi regional coaches, Réunion, Martinique and
  French Guiana. Each is the keyless vehicle feed of a transport.data.gouv.fr
  record under Licence Ouverte 2.0 or ODbL, recorded in the registry and
  DATA_SOURCES.md. Trams and boats take their own mode, feeds that publish
  km/h (Dijon, Le Mans, Bourg-en-Bresse, Blois, Montluçon) are converted to
  m/s, and internal route keys read as the line on the vehicle. Networks
  already in the layer are not added a second time (#1716).
- Add 139 more keyless feeds to the Transit layer from the open GTFS-Realtime
  catalogues, most of them United States agencies (Sacramento, Spokane,
  Cleveland, St. Louis, Madison, Louisville, Fresno, Broward County and many
  smaller systems), plus Zagreb, Bilbao's metro, Chișinău, Parma and a few
  Québec networks. Operators whose terms were read are credited as those
  terms ask; feeds with no stated licence say so in the registry and
  DATA_SOURCES.md. Feeds whose terms need a key, registration or permission
  (New York City buses, Detroit, Pittsburgh and others) are left out (#1716).
