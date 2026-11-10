import { execFileSync, spawn } from 'node:child_process';

export function readProcesses() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1 << 24,
    })
      .trim()
      .split('\n')
      .flatMap((line) => {
        const match = line
          .trim()
          .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        return match
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                elapsed: match[4],
                command: match[5],
                line: line.trim(),
              },
            ]
          : [];
      });
  } catch {
    return [];
  }
}

/** Include the group even when its leader has already exited. */
export function processTree(pid, processes) {
  const ids = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const row of processes) {
      if (!ids.has(row.pid) && (ids.has(row.ppid) || row.pgid === pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  } while (changed);
  return processes.filter((row) => ids.has(row.pid));
}

/** Sequential callers get captured output and a deadline for the whole tree. */
export function runScenario(command, args, { timeout, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const groups = new Set(child.pid ? [child.pid] : []);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let error = null;
    let done = false;
    const rememberGroups = () => {
      const processes = readProcesses();
      for (const pid of [...groups]) {
        const rows = processTree(pid, processes);
        if (processes.length && !rows.length && pid !== child.pid)
          groups.delete(pid);
        for (const row of rows) groups.add(row.pgid);
      }
    };
    const finish = (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(watch);
      resolve({
        status,
        signal,
        error,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    };
    const stop = (code, message) => {
      if (done) return;
      error = Object.assign(new Error(message), { code });
      rememberGroups();
      // Chrome detaches into another group; retain it before Node can exit.
      for (const pid of [...groups].reverse()) {
        try {
          if (pid > 0) process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(null, 'SIGKILL');
    };
    const capture = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 1 << 26) stop('ENOBUFS', 'Scenario output exceeded 64 MiB');
      else chunks.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (failure) => {
      error = failure;
    });
    child.on('close', finish);
    // Keep detached descendants identifiable if Chrome's leader exits first.
    const watch = setInterval(rememberGroups, 1000);
    const deadline = setTimeout(
      () => stop('ETIMEDOUT', `Scenario timed out after ${timeout} ms`),
      timeout,
    );
  });
}
