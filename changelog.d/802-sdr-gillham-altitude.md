- The browser SDR now decodes 100 ft (Gillham, Q=0) altitudes. It decoded only
  the 25 ft form, so an aircraft whose transponder encodes altitude in 100 ft
  steps, or any aircraft above 50,175 ft, showed no altitude over WebUSB while
  a dump1090 feed of the same antenna showed one. A code that maps to no
  altitude still leaves the altitude unknown (Pedro Lobato, #802).
