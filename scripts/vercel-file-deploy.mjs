#!/usr/bin/env node
/**
 * scripts/vercel-file-deploy.mjs — create a PREVIEW deployment of this branch
 * in an existing Vercel project through the REST file-upload flow (no git
 * source, no CLI), for operators running OUTSIDE the agent build environment
 * (whose `vercel` CLI is a guardrail shim and which must not call the Vercel
 * deployment API itself — see docs/audit/deployment-verification.md §9).
 *
 *   VERCEL_TOKEN=<token> node scripts/vercel-file-deploy.mjs \
 *     --team team_aft8hHPiYnHp6I534L3DQScA \
 *     --project prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO --name ondemand-eand-spatial \
 *     [--target preview] [--dry-run] [--poll-seconds 600]
 *
 * Flow (Vercel REST API):
 *   1. file set = `git ls-files` minus docs/, tests, .github/, pinokio/,
 *      .env*, node_modules/ (never uploaded) plus dist/** when present —
 *      enough for Vercel to run vercel.json's buildCommand itself.
 *   2. for every file: sha1 → POST /v2/files?teamId=…  (headers
 *      Authorization: Bearer, x-vercel-digest: <sha1>, Content-Length)
 *   3. POST /v13/deployments?teamId=…&skipAutoDetectionConfirmation=1 with
 *      { name, project, target, files:[{file, sha, size}],
 *        projectSettings:{ framework:'vite' } } — NO env / build env values:
 *      the deployment inherits the project's environment variables.
 *   4. poll GET /v13/deployments/{id}?teamId=… until READY | ERROR |
 *      CANCELED; on ERROR print GET /v3/deployments/{id}/events?teamId=…
 *
 * The token is read from the environment only, sent only in the
 * Authorization header, and never printed (all output passes redact()).
 * `--target production` is refused: this script never promotes.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.VERCEL_TOKEN || '';
const API = 'https://api.vercel.com';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}
const has = (flag) => process.argv.includes(flag);
const redact = (s) =>
  TOKEN ? String(s).split(TOKEN).join('<redacted>') : String(s);
const log = (line) => process.stderr.write(`${redact(line)}\n`);

const EXCLUDE_PREFIXES = [
  'docs/',
  '.agents/',
  '.github/',
  'pinokio/',
  'node_modules/',
  'screenshots/',
  'qa-shots/',
];
const EXCLUDE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/,
  /\.test\.[cm]?js$/,
  /^scripts\/qa-/,
  /^\.gev-/,
];

function collectFiles(includeDist) {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files = tracked.filter(
    (f) =>
      !EXCLUDE_PREFIXES.some((p) => f.startsWith(p)) &&
      !EXCLUDE_PATTERNS.some((re) => re.test(f)) &&
      existsSync(path.join(ROOT, f)) &&
      statSync(path.join(ROOT, f)).isFile(),
  );
  if (includeDist && existsSync(path.join(ROOT, 'dist'))) {
    const walk = (dir) => {
      for (const entry of execFileSync('find', [dir, '-type', 'f'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)) {
        files.push(path.relative(ROOT, entry));
      }
    };
    walk(path.join(ROOT, 'dist'));
  }
  return [...new Set(files)].sort();
}

async function api(method, pathname, { body, headers = {}, raw } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  const team = arg('--team', '');
  const project = arg('--project', '');
  const name = arg('--name', '');
  const target = arg('--target', 'preview');
  const pollSeconds = Number(arg('--poll-seconds', '600'));
  const dryRun = has('--dry-run');
  if (target !== 'preview') {
    log('refusing: this script only creates preview deployments');
    process.exitCode = 2;
    return;
  }
  if (!team || !project || !name) {
    log('usage: --team <teamId> --project <projectId> --name <projectName>');
    process.exitCode = 2;
    return;
  }
  const files = collectFiles(true);
  const entries = files.map((file) => {
    const buf = readFileSync(path.join(ROOT, file));
    return {
      file,
      sha: createHash('sha1').update(buf).digest('hex'),
      size: buf.length,
      buf,
    };
  });
  log(
    `files: ${entries.length}, bytes: ${entries.reduce((n, e) => n + e.size, 0)}`,
  );
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        entries.map(({ file, sha, size }) => ({ file, sha, size })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!TOKEN) {
    log('VERCEL_TOKEN is not set in the environment');
    process.exitCode = 2;
    return;
  }
  const who = await api('GET', '/v2/user');
  log(`GET /v2/user -> ${who.status}`);
  if (!who.ok) {
    process.exitCode = 1;
    return;
  }
  let uploaded = 0;
  for (const e of entries) {
    const r = await api(
      'POST',
      `/v2/files?teamId=${encodeURIComponent(team)}`,
      {
        raw: true,
        body: e.buf,
        headers: {
          'x-vercel-digest': e.sha,
          'Content-Length': String(e.size),
          'Content-Type': 'application/octet-stream',
        },
      },
    );
    if (!r.ok) {
      log(
        `upload failed for ${e.file}: HTTP ${r.status} ${r.text.slice(0, 200)}`,
      );
      process.exitCode = 1;
      return;
    }
    uploaded += 1;
  }
  log(`uploaded ${uploaded} files`);
  const create = await api(
    'POST',
    `/v13/deployments?teamId=${encodeURIComponent(team)}&skipAutoDetectionConfirmation=1`,
    {
      body: {
        name,
        project,
        target,
        files: entries.map(({ file, sha, size }) => ({ file, sha, size })),
        projectSettings: { framework: 'vite' },
      },
    },
  );
  log(`POST /v13/deployments -> ${create.status}`);
  if (!create.ok) {
    process.stdout.write(`${redact(JSON.stringify(create.json, null, 2))}\n`);
    process.exitCode = 1;
    return;
  }
  const id = create.json.id;
  const url = create.json.url;
  log(`deployment ${id} https://${url} state=${create.json.readyState}`);
  const started = Date.now();
  let state = create.json.readyState;
  while (
    !['READY', 'ERROR', 'CANCELED'].includes(state) &&
    Date.now() - started < pollSeconds * 1000
  ) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await api(
      'GET',
      `/v13/deployments/${encodeURIComponent(id)}?teamId=${encodeURIComponent(team)}`,
    );
    state = st.json?.readyState ?? state;
    log(`${new Date().toISOString()} ${id} ${state}`);
  }
  const out = { id, url: `https://${url}`, readyState: state };
  if (state === 'ERROR') {
    const ev = await api(
      'GET',
      `/v3/deployments/${encodeURIComponent(id)}/events?teamId=${encodeURIComponent(team)}`,
    );
    out.events = (Array.isArray(ev.json) ? ev.json : []).slice(-60);
  }
  process.stdout.write(`${redact(JSON.stringify(out, null, 2))}\n`);
  process.exitCode = state === 'READY' ? 0 : 1;
}

main().catch((err) => {
  log(`error: ${err?.message || err}`);
  process.exitCode = 1;
});
