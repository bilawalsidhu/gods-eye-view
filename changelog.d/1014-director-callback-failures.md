- Director clock listeners, interaction observers and scene release failures
  no longer leave the director inconsistent: each scene is released once, and
  a phase error is kept (with the release failure logged) when cleanup also
  fails (deepeshbind, #1014).
