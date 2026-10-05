// Is this workspace's Cloudflare Pages site live, and is what it serves what this source produces?
//
// Three independent signals, because each one can pass while another fails:
//   1. Reachable   -- every entry page returns 200, following the redirect Pages issues for .html
//   2. Current     -- the content-hashed asset references served match the local build's
//   3. Commit      -- the commit Cloudflare recorded for the live deployment vs this workspace's
//
// Signal 2 is only meaningful if the local build is itself current, so a stale build is detected
// first and reported rather than quietly producing a false pass.
//
// This script never deploys and never writes anything. It is self-contained so it keeps working in
// a project opened on its own or spun out into its own repository.

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERDICT = { ok: 'ok', notDeployed: 'not deployed', down: 'down', stale: 'stale', noBuild: 'no build' };

// Minimal reader for the two keys a Pages project declares. Not a general TOML parser -- it only
// has to understand the files this repository writes, and say so when it cannot.
export function parseWranglerTarget(toml) {
  if (typeof toml !== 'string') return null;
  const value = (key) => toml.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1] ?? null;
  const name = value('name');
  if (!name) return null;
  return { name, output: value('pages_build_output_dir') ?? 'dist', url: `https://${name}.pages.dev` };
}

// Cloudflare Pages serves /solar.html as a 308 to /solar. Requesting the extensionless form
// directly avoids relying on redirect handling, and index.html is the site root.
export function pageUrl(base, file) {
  const name = basename(file).replace(/\.html$/i, '');
  return name === 'index' ? `${base}/` : `${base}/${name}`;
}

// Vite fingerprints every emitted asset, so the set of references in a page is a fingerprint of the
// build that produced it.
export function assetRefs(html) {
  return new Set((html ?? '').match(/assets\/[A-Za-z0-9._-]+/g) ?? []);
}

export function compareAssets(live, local) {
  const missing = [...local].filter((ref) => !live.has(ref));
  const extra = [...live].filter((ref) => !local.has(ref));
  return { match: missing.length === 0 && extra.length === 0, missing, extra };
}

export function verdictFor(pages) {
  if (pages.some((page) => page.status !== 200)) return VERDICT.down;
  if (pages.some((page) => !page.assets.match)) return VERDICT.stale;
  return VERDICT.ok;
}

export function exitCodeFor(verdict) {
  return verdict === VERDICT.ok || verdict === VERDICT.notDeployed ? 0 : 1;
}

async function newestMtime(path, skip = new Set(['node_modules', '.git', '.vite', '.wrangler'])) {
  let newest = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs > newest) newest = info.mtimeMs;
      }
    }
  };
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (info.isDirectory()) await walk(path);
  else newest = info.mtimeMs;
  return newest;
}

// A build older than its own sources means the asset comparison below is measuring the wrong thing.
export async function localBuildIsStale(workspace, output) {
  const built = await newestMtime(join(workspace, output));
  if (!built) return null;
  const sources = await Promise.all(['src', 'public', 'index.html'].map((entry) => newestMtime(join(workspace, entry))));
  const newestSource = Math.max(...sources, 0);
  return newestSource > built ? { built: new Date(built), source: new Date(newestSource) } : false;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Best effort: wrangler may be absent, unauthenticated, or the workspace may not be in a repo.
// None of those make the reachability and asset checks any less valid, so failure is a note.
function deployedCommit(workspace, project) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', 'pages', 'deployment', 'list', '--project-name', project], { cwd: workspace, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0 || !result.stdout) return null;
  // The first data row is the newest deployment; the Source column holds the short commit.
  for (const line of result.stdout.split('\n')) {
    const cells = line.split('│').map((cell) => cell.trim());
    const commit = cells.find((cell) => /^[0-9a-f]{7,40}$/.test(cell));
    if (commit && line.includes('Production')) return commit;
  }
  return null;
}

async function fetchPage(url) {
  try {
    const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'protogen-deployment-check' } });
    return { status: response.status, finalUrl: response.url, html: await response.text() };
  } catch (error) {
    return { status: 0, finalUrl: url, html: '', error: error.message };
  }
}

export async function checkWorkspace(workspace) {
  const label = basename(workspace);
  const toml = await readFile(join(workspace, 'wrangler.toml'), 'utf8').catch(() => null);
  const target = parseWranglerTarget(toml);
  if (!target) return { label, workspace, verdict: VERDICT.notDeployed, pages: [] };

  const outputDir = join(workspace, target.output);
  const files = (await readdir(outputDir).catch(() => null))?.filter((file) => file.toLowerCase().endsWith('.html'));
  if (!files?.length) {
    return { label, workspace, target, verdict: VERDICT.noBuild, pages: [], note: `no built pages in ${target.output}/ — run npm run build first` };
  }

  const buildStale = await localBuildIsStale(workspace, target.output);
  const pages = [];
  for (const file of files.sort()) {
    const url = pageUrl(target.url, file);
    const live = await fetchPage(url);
    const local = await readFile(join(outputDir, file), 'utf8');
    pages.push({ file, url, status: live.status, finalUrl: live.finalUrl, error: live.error, assets: compareAssets(assetRefs(live.html), assetRefs(local)) });
  }

  return {
    label,
    workspace,
    target,
    pages,
    buildStale,
    localCommit: git(['log', '-1', '--format=%h', '--', '.'], workspace),
    deployedCommit: deployedCommit(workspace, target.name),
    verdict: verdictFor(pages),
  };
}

export function report(result) {
  const lines = [];
  const mark = { [VERDICT.ok]: '✓', [VERDICT.notDeployed]: '–', [VERDICT.down]: '✗', [VERDICT.stale]: '!', [VERDICT.noBuild]: '?' }[result.verdict];
  lines.push(`${mark} ${result.label} — ${result.verdict}${result.target ? ` (${result.target.url})` : ''}`);
  if (result.verdict === VERDICT.notDeployed) {
    lines.push('    No wrangler.toml, so this workspace publishes nowhere. That is intentional for the template.');
    return lines;
  }
  if (result.note) lines.push(`    ${result.note}`);
  for (const page of result.pages) {
    const suffix = page.status === 200 ? (page.assets.match ? 'assets match the local build' : 'assets DIFFER from the local build') : page.error ?? 'unreachable';
    lines.push(`    ${page.status || 'ERR'}  ${page.url}  — ${suffix}`);
    // Nothing was served, so an asset diff would just restate that. Only compare what we received.
    if (page.status !== 200) continue;
    for (const ref of page.assets.missing) lines.push(`         local has ${ref}, live does not`);
    for (const ref of page.assets.extra) lines.push(`         live has ${ref}, local build does not`);
  }
  if (result.buildStale) {
    lines.push(`    ! Local build is older than its sources (built ${result.buildStale.built.toISOString().slice(0, 16)}, source ${result.buildStale.source.toISOString().slice(0, 16)}).`);
    lines.push('      The asset comparison above is against stale output — rebuild before trusting it.');
  }
  if (result.deployedCommit) {
    const same = result.localCommit && result.deployedCommit.startsWith(result.localCommit);
    lines.push(`    Deployed commit ${result.deployedCommit}${result.localCommit ? ` · workspace at ${result.localCommit}${same ? '' : ' (differs)'}` : ''}`);
  } else lines.push('    Deployed commit unavailable (wrangler not installed, not authenticated, or no git history).');
  if (result.verdict !== VERDICT.ok) lines.push(`    To publish: npm run build && npm run deploy`);
  return lines;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkWorkspace(workspace);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(report(result).join('\n'));
  process.exit(exitCodeFor(result.verdict));
}
