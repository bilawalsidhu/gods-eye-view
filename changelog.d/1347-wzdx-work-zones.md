- Add **US Work Zones**, a keyless Movement layer of current work zones and
  detours from eight US state and county DOT feeds in the Work Zone Data
  Exchange (WZDx 4.0-4.2) format: Minnesota, Indiana, Kansas, North Dakota,
  Maryland, Kentucky, Mississippi and Maricopa County (AZ), each CC0 in its own
  feed header. The server reads them into one snapshot shared by every client
  every five minutes; a failed feed keeps its last events as stale for up to
  six hours. Ground-clamped lines and markers are coloured by lane impact, not
  speed, and open a card with road, direction, impact, dates, worker presence
  and the publisher. Ended work and work starting more than a week ahead is
  left out. US only (daikaginza, #1347).
