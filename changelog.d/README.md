# Changelog fragments

One file per entry. A pull request adds a file here instead of editing
`CHANGELOG.md`, and a release concatenates them into it.

```
changelog.d/<pull request number>-<slug>.md
```

`723-atc-decision-layer.md`, for example. The slug is lowercase, words separated
by `-`. Two pull requests never pick the same filename, because the pull request
number is already unique — which is the point: new `CHANGELOG.md` entries go at
the top of the file, so two pull requests in flight write into the same few lines
and git has nothing to merge on.

Write the file exactly as the entry should read in `CHANGELOG.md`: a `-` bullet,
wrapped the way the surrounding entries are, crediting yourself and the pull
request.

```markdown
- Report which upstream declined a Street Traffic road load. The layer row now
  reads `Overpass rate-limited` instead of a general "Road data temporarily
  unavailable" (yourname, #665).
```

The text is spliced in unchanged apart from trailing whitespace, so what you
write here is what ships. Fragments are deliberately outside
`scripts/format-scope.json`, so `npm run format` never reflows one.

At release time:

```
npm run changelog:check   # list what would move, change nothing
npm run changelog         # move every fragment into CHANGELOG.md
```

The assembler refuses a batch rather than guessing: a filename that is not
`<pull request>-<slug>.md`, or two fragments claiming one pull request number,
stops the run before anything is written and names the files.

A documentation claim that needs a regression test — the way
`src/annotations/drawTool.test.mjs` asserts against `CHANGELOG.md` — should
assert against `docs/CURRENT-STATE.md` or `README.md` instead. A pull request
still edits those directly, so the text is in the file while the change is under
review; a fragment does not reach `CHANGELOG.md` until release.
