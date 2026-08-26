/**
 * Shared utilities and types for Cloudflare Workers API proxies.
 */

/** Cloudflare Worker environment bindings. */
export interface Env {
	// Secrets (set via `wrangler secret put`)
	OPENSKY_USERNAME?: string;
	OPENSKY_PASSWORD?: string;
	AISSTREAM_API_KEY?: string;
	NASA_FIRMS_API_KEY?: string;
	TOMTOM_API_KEY?: string;
	LAUNCH_LIBRARY_2_TOKEN?: string;
	// KV cache binding
	CACHE?: KVNamespace;
	// Durable Object binding for AIS sessions
	AIS?: DurableObjectNamespace;
}

export interface CacheEntry<T = unknown> {
	data: T;
	createdAt: number;
	expiresAt: number;
}

/** In-memory cache (per-instance, not distributed). */
export class MemoryCache<T = unknown> {
	private map = new Map<string, CacheEntry<T>>();

	get(key: string): T | null {
		const entry = this.map.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expiresAt) {
			this.map.delete(key);
			return null;
		}
		return entry.data as T;
	}

	set(key: string, data: T, ttlMs: number): void {
		this.map.set(key, { data, createdAt: Date.now(), expiresAt: Date.now() + ttlMs });
	}

	del(key: string): void {
		this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}
}

/** JSON fetch with timeout. */
export async function fetchJson<T = unknown>(
	url: string,
	options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
	const { timeoutMs = 20000, ...fetchOptions } = options;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return res.json() as Promise<T>;
	} finally {
		clearTimeout(timeout);
	}
}

/** Create a JSON error response. */
export function errorResponse(message: string, status = 500): Response {
	return Response.json({ error: message }, { status });
}

/** Parse bbox query param (south,west,north,east). Returns null if invalid. */
export function parseBbox(value: string | null): [number, number, number, number] | null {
	if (!value) return null;
	const parts = value.split(',').map(Number);
	if (parts.length !== 4 || parts.some(isNaN)) return null;
	const [south, west, north, east] = parts;
	if (south < -90 || north > 90 || west < -180 || east > 180) return null;
	if (south >= north || west >= east) return null;
	return [south, west, north, east];
}

/** In-memory rate limiter (per-instance, not distributed). */
export class RateLimiter {
	private counts = new Map<string, { count: number; resetAt: number }>();

	constructor(private windowMs: number, private max: number) {}

	allow(key: string): boolean {
		const now = Date.now();
		let entry = this.counts.get(key);
		if (!entry || now > entry.resetAt) {
			entry = { count: 0, resetAt: now + this.windowMs };
			this.counts.set(key, entry);
		}
		if (entry.count >= this.max) return false;
		entry.count++;
		return true;
	}
}
