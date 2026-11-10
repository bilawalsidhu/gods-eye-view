- "Show me X on Street View" (or on Mapillary, KartaView or Panoramax): a
  `show_street_level` voice and typed action flies to the place, switches to
  Google 3D when the source needs it, lights that source in Street Level,
  turns the layer on and opens the nearest photo, reporting which step failed.
  Views and share links carry the same request (`street_level`, `sl=`), so
  `show_in_gods_eye_view` and a link can open a panorama at a place. Street
  View lookups from a geocoded place search up to 250 m; clicks keep 50 m. A
  plain link with `sl=google` arms Street View and leaves the billed load to a
  press of OPEN GOOGLE STREET VIEW, which aims at the view centre again once
  the visitor has moved more than 1 km away; embedded views open it, and the
  God's Eye View panel only for a result issued in the last five minutes. On
  a phone, a photo that opens or a link that arms opens the Cameras sheet;
  in cockpit, clean view, recording or scene playback the action says the
  panel is hidden instead of loading a photo nobody sees. Embedded photos
  remain available over the clean globe. Mapillary's
  nearest-photo search asks for 100 photos, so the nearest and the filter's
  pick come from the spot's photos rather than an arbitrary eight. The source the
  action lights stays lit like a chip click. An unavailable map stack now
  reports the controller's own reason instead of always asking for a Cesium
  ion token. When nothing is found and a 360°, flat or SINCE filter the source
  honours is on, the answer names the filter. Cancelled lookups clear their
  loading state over an existing photo and release their caller abort listeners.
  Embedded photos show loading errors inside the overlay, and the OPEN prompt
  uses the recipient's selected language. A link's photos never save its
  layers as the recipient's preferences, and a link pasted into an open tab
  opens or arms them too. With no place named, the action looks under the
  screen centre as OPEN does; an armed OPEN aimed at the sky opens nothing; a
  failing source is reported as an error, not as missing imagery; and
  Mapillary's nearest search gives up after 12 seconds. On a phone the panel
  scrolls into view, and in embed mode EXPAND stays open while cockpit,
  recording and scene playback hide the photo. The action checks again after
  every wait: a navigation or a drag of the globe, or a mode that hides the
  panel, stops it before a photo loads for a place the user left or in a
  panel nobody sees, also between finding a photo and loading it. A request
  that finds nothing closes the previous photo, and one that finds a photo
  replaces it in place, so EXPAND stays. A link whose restore flight the
  visitor interrupted, or a posted view the user overtook, leaves their
  camera and photo alone, and a photo found but not loaded keeps its error.
  Mapillary's timeout message is translated. The panel's later results open a billed photo only when they are
  fresh too (Said Turksever, @asturksever, #1113).
