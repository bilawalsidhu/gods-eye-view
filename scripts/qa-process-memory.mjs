import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** RSS for an isolated browser tree, plus an optional server PID. Shared pages may be counted twice. */
export function processMemory(browserPid, serverPid = 0) {
  if (!['darwin', 'linux'].includes(process.platform))
    return { unavailable: 'RSS sampling supports macOS/Linux' };
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        return (
          match && {
            pid: Number(match[1]),
            parent: Number(match[2]),
            rssBytes: Number(match[3]) * 1024,
            name: path.basename(match[4]),
          }
        );
      })
      .filter(Boolean);
    const owned = new Set([browserPid]);
    let previous;
    do {
      previous = owned.size;
      for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
    } while (owned.size !== previous);
    const processes = rows.filter((row) => owned.has(row.pid));
    return {
      browserRssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0),
      processes,
      serverRssBytes:
        rows.find((row) => row.pid === serverPid)?.rssBytes ?? null,
    };
  } catch (error) {
    return { unavailable: error.code || 'ps failed' };
  }
}
