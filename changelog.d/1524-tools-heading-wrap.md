- The agent and voice query tools report a direction that rounds to 360 as 0:
  vessel course and heading, aircraft course, transit bearing, camera heading
  and satellite azimuths now round through the shared heading helper the
  layers use, which wraps into 0–359 (@quanticsoul4772, #1524).
