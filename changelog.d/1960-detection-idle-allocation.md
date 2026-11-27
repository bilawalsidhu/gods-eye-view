- The idle globe with Satellites and Flights on allocated about 130 MB/s, most
  of it in the detection overlay's paint: a new position object per aircraft
  per paint, a copy of every icon id, and new arrays, maps and strings in the
  label solve. Positions are now written into kept vectors
  (`motionPosition`'s optional result) and the overlay reuses its arrays,
  maps and query objects, with nothing drawn differently (samehkhamis, #1960).
