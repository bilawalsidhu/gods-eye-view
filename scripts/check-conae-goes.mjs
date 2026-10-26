#!/usr/bin/env node
// Explicit, read-only live acceptance check. Unit tests never call CONAE.
import { createConaeGoesSource } from '../server/providers/conae-goes.js';

try {
  const snapshot = await createConaeGoesSource().getSnapshot();
  let newest = null;
  for (const fire of snapshot.fires) newest = Math.max(newest ?? 0, fire.acqMs);
  console.log(
    JSON.stringify(
      {
        source: snapshot.sourceLabel,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        observations: snapshot.count,
        newestAcquisition: newest ? new Date(newest).toISOString() : null,
        stale: snapshot.stale,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
