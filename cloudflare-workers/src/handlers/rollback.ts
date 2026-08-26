/**
 * Rollback mechanism and admin controls.
 *
 * Stores deployment metadata in KV. The CI/CD pipeline calls the deploy endpoint
 * after each successful deployment. The admin endpoint serves a simple HTML dashboard
 * for viewing history and triggering rollbacks.
 *
 * GET  /api/admin/rollback          → HTML dashboard
 * GET  /api/admin/rollback/history → JSON list of deployments
 * POST /api/admin/rollback/deploy  → record a new deployment
 * POST /api/admin/rollback/rollback → set current version to a previous deployment
 */
import type { Env } from '../lib/shared.js';
import { errorResponse } from '../lib/shared.js';

const DEPLOYMENTS_KEY = 'deployments:list';
const CURRENT_KEY = 'deployments:current';

interface Deployment {
	id: string;
	version: string;
	timestamp: number;
	status: 'success' | 'failed' | 'rollback';
	commit?: string;
	message?: string;
}

async function getDeployments(env: Env): Promise<Deployment[]> {
	if (!env.CACHE) return [];
	const raw = await env.CACHE.getWithMetadata<Deployment[]>(DEPLOYMENTS_KEY, 'json') as
		{ value: Deployment[] | null; metadata: Deployment[] | null };
	return raw.value ?? [];
}

async function saveDeployments(env: Env, deployments: Deployment[]): Promise<void> {
	if (!env.CACHE) return;
	// Keep only last 50 deployments
	const trimmed = deployments.slice(-50);
	await env.CACHE.put(DEPLOYMENTS_KEY, JSON.stringify(trimmed));
}

async function getCurrent(env: Env): Promise<Deployment | null> {
	if (!env.CACHE) return null;
	const raw = await env.CACHE.getWithMetadata<Deployment>(CURRENT_KEY, 'json') as
		{ value: Deployment | null; metadata: Deployment | null };
	return raw.value ?? null;
}

async function setCurrent(env: Env, deployment: Deployment): Promise<void> {
	if (!env.CACHE) return;
	await env.CACHE.put(CURRENT_KEY, JSON.stringify(deployment));
}

const HTML_DASHBOARD = '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="UTF-8"/>' +
'<title>GEV Admin — Rollback</title>' +
'<style>' +
'  body { font-family: JetBrains Mono, monospace; background: #0a0a0a; color: #e0e0e0; padding: 24px; }' +
'  h1 { color: #fff; }' +
'  table { border-collapse: collapse; width: 100%; max-width: 800px; margin-top: 16px; }' +
'  th, td { border: 1px solid #333; padding: 8px 12px; text-align: left; }' +
'  th { background: #1a1a1a; color: #888; }' +
'  tr.current td { background: rgba(59,130,246,0.15); }' +
'  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }' +
'  .badge-success { background: rgba(34,197,94,0.2); color: #22c55e; }' +
'  .badge-failed { background: rgba(239,68,68,0.2); color: #ef4444; }' +
'  .badge-rollback { background: rgba(251,191,36,0.2); color: #fbbf24; }' +
'  .badge-current { background: rgba(59,130,246,0.2); color: #3b82f6; }' +
'  button { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-family: inherit; }' +
'  button:hover { border-color: #666; }' +
'  .info { color: #888; margin-top: 8px; font-size: 12px; }' +
'</style>' +
'</head>' +
'<body>' +
'<h1>🚀 GEV Admin — Rollback</h1>' +
'<div id="app" style="max-width:800px"></div>' +
'<script>' +
'async function load() {' +
'  const res = await fetch("/api/admin/rollback/history");' +
'  const data = await res.json();' +
'  const currentId = data.current ? data.current.id : "";' +
'  let html = "<table><tr><th>Version</th><th>Commit</th><th>Status</th><th>Time</th><th>Action</th></tr>";' +
'  for (const d of [...data.history].reverse()) {' +
'    const isCurrent = d.id === currentId;' +
'    const badge = isCurrent' +
'      ? \'<span class="badge badge-current">CURRENT</span>\'' +
'      : d.status === "success"' +
'        ? \'<span class="badge badge-success">success</span>\'' +
'        : d.status === "failed"' +
'          ? \'<span class="badge badge-failed">failed</span>\'' +
'          : \'<span class="badge badge-rollback">rollback</span>\';' +
'    const btn = isCurrent ? "—" : "<button onclick=\\"doRollback(\'" + d.id + "\')\\">Rollback</button>";' +
'    const time = new Date(d.timestamp).toLocaleString();' +
'    const rowClass = isCurrent ? \' class="current"\' : "";' +
'    html += "<tr" + rowClass + "><td>" + d.version + (isCurrent ? " ★" : "") + "</td><td>" + (d.commit || "—") + "</td><td>" + badge + "</td><td>" + time + "</td><td>" + btn + "</td></tr>";' +
'  }' +
'  html += "</table>";' +
'  html += \'<p class="info">Current version: <strong>\' + (data.current ? data.current.version : "unknown") + "</strong></p>";' +
'  document.getElementById("app").innerHTML = html;' +
'}' +
'async function doRollback(id) {' +
'  if (!confirm("Rollback to this version?")) return;' +
'  await fetch("/api/admin/rollback/rollback", {' +
'    method: "POST",' +
'    headers: { "Content-Type": "application/json" },' +
'    body: JSON.stringify({ deploymentId: id }),' +
'  });' +
'  load();' +
'}' +
'load();' +
'</script>' +
'</body>' +
'</html>';

export async function handleRollback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace('/api/admin/rollback', '') || '/';

	// GET /api/admin/rollback → HTML dashboard
	if (request.method === 'GET' && (path === '/' || path === '')) {
		return new Response(HTML_DASHBOARD, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}

	// GET /api/admin/rollback/history → JSON
	if (request.method === 'GET' && (path === '/history' || path === '/list')) {
		const history = await getDeployments(env);
		const current = await getCurrent(env);
		return Response.json({ history, current });
	}

	// POST /api/admin/rollback/deploy → record deployment
	if (request.method === 'POST' && path === '/deploy') {
		let body: { version?: string; commit?: string; message?: string; status?: string };
		try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
		if (!body.version) return errorResponse('Missing version', 400);

		const deployment: Deployment = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			version: body.version,
			commit: body.commit,
			message: body.message,
			timestamp: Date.now(),
			status: (body.status as Deployment['status']) ?? 'success',
		};
		const deployments = await getDeployments(env);
		deployments.push(deployment);
		await saveDeployments(env, deployments);
		await setCurrent(env, deployment);
		return Response.json({ ok: true, deployment });
	}

	// POST /api/admin/rollback/rollback → perform rollback
	if (request.method === 'POST' && path === '/rollback') {
		let body: { deploymentId?: string };
		try { body = await request.json() as typeof body; } catch { return errorResponse('Invalid JSON', 400); }
		if (!body.deploymentId) return errorResponse('Missing deploymentId', 400);

		const deployments = await getDeployments(env);
		const target = deployments.find(d => d.id === body.deploymentId);
		if (!target) return errorResponse('Deployment not found', 404);

		const rollbackDeployment: Deployment = {
			...target,
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			timestamp: Date.now(),
			status: 'rollback',
		};
		deployments.push(rollbackDeployment);
		await saveDeployments(env, deployments);
		await setCurrent(env, rollbackDeployment);
		return Response.json({ ok: true, deployment: rollbackDeployment });
	}

	return errorResponse('Not Found', 404);
}
