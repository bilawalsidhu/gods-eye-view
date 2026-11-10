import { processTree, readProcesses } from './process.mjs';

/** Bound shutdown even when Chrome leaves descendants holding its pipes. */
export async function closeBrowser(browser, { deadlineMs = 5000 } = {}) {
  const start = performance.now();
  let child;
  let closed = false;
  let killed = false;
  let timer;
  try {
    child = browser.process();
  } catch {}
  try {
    closed = await Promise.race([
      Promise.resolve()
        .then(() => browser.close())
        .then(
          () => true,
          () => false,
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      }),
    ]);
  } catch {}
  clearTimeout(timer);
  if (process.env.QA_EXIT_DIAGNOSTICS !== '1') {
    try {
      if (Number.isInteger(child?.pid) && child.pid > 0) {
        // The group can outlive its leader, so probe the group itself.
        process.kill(-child.pid, 0);
        process.kill(-child.pid, 'SIGKILL');
        killed = true;
      }
    } catch {}
    for (const name of ['stdout', 'stderr']) {
      try {
        child?.[name]?.destroy();
      } catch {}
    }
  }
  return { closed, killed, ms: performance.now() - start };
}

export async function exitAfterFlush(code = process.exitCode ?? 0) {
  process.exitCode = code;
  if (process.env.QA_EXIT_DIAGNOSTICS === '1') return;
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise((resolve) => {
          if (stream.destroyed) return resolve();
          stream.write('', resolve);
        }),
    ),
  );
  process.exit(code);
}

export function diagnoseExit(pids) {
  if (process.env.QA_EXIT_DIAGNOSTICS !== '1') return;
  setTimeout(() => {
    console.error('QA EXIT resources', process.getActiveResourcesInfo());
    const processes = readProcesses();
    console.error('QA EXIT Chrome: pid ppid pgid elapsed command');
    for (const pid of pids) {
      const rows = processTree(pid, processes);
      console.error(`Chrome ${pid}:`);
      for (const row of rows) console.error(row.line);
      if (!rows.length) console.error('(no remaining processes)');
    }
  }, 5000).unref();
}
