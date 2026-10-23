- Add a single audio claim (`src/data/audioOwnership.js`):
  `claimAudio(owner, { onRevoked })` / `releaseAudio(lease)`, mirroring
  `inputOwnership.js` but preempting instead of refusing — for sound, the thing
  the user just asked for is the thing that should be audible, and the incumbent
  is told to stop rather than the newcomer being silenced. Eight parts of the
  app produce audio today with nothing arbitrating between them; this is the
  seam that lets them agree on one at a time. No producer is wired to it yet
  (daikaginza, #721).
