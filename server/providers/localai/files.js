import fs from 'node:fs';
import path from 'node:path';

/** Bytes currently held in unfinished Hugging Face downloads. */
function incompleteDownloadBytes(modelsDir, fsImpl = fs) {
  let total = 0;
  let repos = [];
  try {
    repos = fsImpl.readdirSync(modelsDir);
  } catch {
    return 0;
  }
  for (const repo of repos) {
    if (!repo.startsWith('models--')) continue;
    const blobs = path.join(modelsDir, repo, 'blobs');
    let names = [];
    try {
      names = fsImpl.readdirSync(blobs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.incomplete')) continue;
      try {
        total += fsImpl.statSync(path.join(blobs, name)).size;
      } catch {
        // A completed download may be renamed between the directory read and stat.
      }
    }
  }
  return total;
}

export { incompleteDownloadBytes };
