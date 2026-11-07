- Name the type and registration of civil aircraft. OpenSky reports neither,
  so the server now loads the Mictronics aircraft database (ODC-By 1.0,
  refreshed weekly) and fills them in: about 90% of civil flights get a type,
  aircraft draw in their own class, area queries list types, single lookups
  answer without spending adsbdb's budget, and `find_aircraft` searches civil
  registrations (quanticsoul4772, #1230).
