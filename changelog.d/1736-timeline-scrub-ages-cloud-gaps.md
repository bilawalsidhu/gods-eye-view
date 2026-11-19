- Fix three time readings on the world timeline. A scrub near now goes live
  only within two minutes of now, however long the track: with a layer whose
  source covers years, any time in the last few weeks used to snap to live.
  Fire cards and fire details count a detection's age from the end of the
  24 hours shown, and from now only when live, so a window that ended months
  ago reads "new 3h" rather than "new 105d". Weather and satellite cloud
  frames stay shown, and the latest reads late, for at least one and a half
  of the feed's own frame spacings, so a feed whose frames come an hour apart
  no longer goes blank for half of every hour (samehkhamis, #1736).
