- Transit adds two keyless Australian GTFS-Realtime feeds: TransLink Cairns
  and Adelaide Metro (marked BETA by its operator), both CC BY 4.0 with text
  credits. TransLink vehicles now show trains, Gold Coast light rail and
  ferries by route id instead of all appearing as buses; Adelaide Metro trains,
  trams and the SeaLink ferry are identified the same way. Adelaide's gateway
  returns base64 protobuf inside JSON unless asked for
  `application/x-google-protobuf`, so that feed sends its own Accept header
  (willrenzo39, #1169).
