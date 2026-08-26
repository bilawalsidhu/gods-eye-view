/**
 * Feature flags endpoint backed by Cloudflare KV.
 *
 * GET  /api/flags           → all flags as JSON
 * GET  /api/flags?name=foo  → single flag value
 * POST /api/flags           → set a flag (name, value, expiresAt in body)
 *
 * Flags are namespaced under "flags:" in KV.
 * Admin-only: in production this would require authentication.
 */
import type { Env } from '../lib/shared.js';
import { errorResponse } from '../lib/shared.js';

interface FeatureFlag {
	value: boolean | string | number;
	description?: string;
	updatedAt: number;
	expiresAt?: number;
}

const FLAG_PREFIX = 'flags:';

function flagKey(name: string): string {
	return `${FLAG_PREFIX}${name}`;
}

async function getFlag(env: Env, name: string): Promise<FeatureFlag | null> {
	if (!env.CACHE) return null;
	try {
		const raw = await env.CACHE.getWithMetadata<FeatureFlag>(flagKey(name), 'json') as
			{ value: FeatureFlag | null; metadata: FeatureFlag | null };
		if (!raw.value) return null;
		if (raw.value.expiresAt && Date.now() > raw.value.expiresAt) {
			await env.CACHE.delete(flagKey(name));
			return null;
		}
		return raw.value;
	} catch {
		return null;
	}
}

async function getAllFlags(env: Env): Promise<Record<string, FeatureFlag>> {
	if (!env.CACHE) return {};
	const list = await env.CACHE.list({ prefix: FLAG_PREFIX });
	const result: Record<string, FeatureFlag> = {};
	for (const key of list.keys) {
		if (!key.name) continue;
		const name = key.name.slice(FLAG_PREFIX.length);
		const flag = await getFlag(env, name);
		if (flag) result[name] = flag;
	}
	return result;
}

async function setFlag(
	env: Env,
	name: string,
	value: boolean | string | number,
	opts: { description?: string; expiresAt?: number } = {}
): Promise<void> {
	if (!env.CACHE) return;
	const flag: FeatureFlag = {
		value,
		description: opts.description,
		updatedAt: Date.now(),
		expiresAt: opts.expiresAt,
	};
	await env.CACHE.put(flagKey(name), JSON.stringify(flag), {
		expirationTtl: opts.expiresAt ? Math.ceil((opts.expiresAt - Date.now()) / 1000) : 86400,
	});
}

export async function handleFeatureFlags(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const name = url.searchParams.get('name');

	if (request.method === 'GET') {
		if (name) {
			const flag = await getFlag(env, name);
			if (!flag) return errorResponse(`Flag not found: ${name}`, 404);
			return Response.json({ name, ...flag });
		}
		// Return all flags
		const flags = await getAllFlags(env);
		return Response.json(flags);
	}

	if (request.method === 'POST') {
		let body: { name?: string; value?: boolean | string | number; description?: string; expiresAt?: number };
		try {
			body = await request.json() as typeof body;
		} catch {
			return errorResponse('Invalid JSON body', 400);
		}
		if (!body.name || body.value === undefined) {
			return errorResponse('Missing required fields: name, value', 400);
		}
		await setFlag(env, body.name, body.value, {
			description: body.description,
			expiresAt: body.expiresAt,
		});
		return Response.json({ ok: true, name: body.name, value: body.value });
	}

	return errorResponse('Method Not Allowed', 405);
}
