- Changelog entries are now one file per pull request. A change adds
  `changelog.d/<pull request>-<slug>.md` instead of editing the top of
  `CHANGELOG.md`, which two pull requests in flight could not share — it was the
  most frequent merge conflict in the open queue, and for six of them the only
  one. `npm run changelog` splices the directory into `CHANGELOG.md` at release
  time and empties it; `npm run changelog:check` reports the batch and changes
  nothing. Fragment text is copied through unchanged (daikaginza, #787).
