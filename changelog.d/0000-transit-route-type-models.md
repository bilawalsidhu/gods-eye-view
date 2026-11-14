- Draw transit vehicles as their kind, not one of five: trolleybuses, cable
  cars, funiculars, gondolas and monorails are modes of their own, with their
  own icon, colour, card word and fleet model. A vehicle record may carry its
  route's GTFS `route_type` (`routeType`), which settles its mode before the
  feed's route hints and picks the finer model (a coach for 200, a high-speed
  set for 101). Prague's trolleybuses and Petřín funicular, and Bucharest,
  Cluj and Turin's trams, trolleybuses and metro lines, now read as such from
  the route ids in each operator's routes.txt. Le Havre's funicular, which its
  routes.txt types as a bus, is a named correction that outranks the route
  type (samehkhamis, #0000).
