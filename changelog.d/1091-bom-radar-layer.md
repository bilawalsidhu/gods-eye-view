- Add an opt-in **AU rain radar** layer (Weather group): Bureau of Meteorology
  radar for every Australian radar in BoM's anonymous-FTP listing, looped from
  the last 12 frames and shown in the viewer's local time. It is off unless the server
  operator sets `BOM_RADAR_ENABLED=1`, because BoM allows personal or
  in-organisation use only (no redistribution; public deployments need BoM
  permission). The local server fetches frames live over one shared FTP
  connection, keeps them in a bounded in-memory cache and never writes imagery
  to disk. The FTP client is a new runtime dependency, `basic-ftp`, so existing
  checkouts need `npm install` after pulling. The nearest radar and a range
  suited to the camera altitude are chosen from each radar's `.map`
  georeferencing; it draws on globe maps and on Google 3D Tiles (bennypixel, #1091).
