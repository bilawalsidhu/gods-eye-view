/**
 * KV-backed cache for offline-first API responses.
 *
 * Stores JSON responses in Cloudflare KV with TTL. When the upstream fetch fails
 * (network error, timeout), stale data can be served from KV if within maxAge.
 *
 * Usage:
 *   const cached = await kvGet<T>(env.CACHE, 'key', { maxAge: 300_000 });
 *   if (cached.ok) return cached.data;
 *   // ...fetch from upstream, then:
 *   await kvSet(env.CACHE, 'key', data, { ttl: 300_000 });
 */

export interface KvGetResult<T> {
	ok: true;
	data: T;
	fromCache: true;
	age: number; // ms since cached
}

export interface KvMissResult {
	ok: false;
	fromCache: false;
}

export type KvResult<T> = KvGetResult<T> | KvMissResult;

export interface KvCacheOptions {
	/** Max acceptable age of cached data in ms. Older = miss. Default: 5 minutes. */
	maxAge?: number;
	/** TTL for new entries in ms. Default: 1 hour. */
	ttl?: number;
}

/** Retrieve a JSON value from KV. Returns null on miss or if older than maxAge. */
export async function kvGet<T = unknown>(
	cache: KVNamespace | undefined,
	key: string,
	opts: KvCacheOptions = {}
): Promise<KvMissResult | KvGetResult<T>> {
	if (!cache) return { ok: false, fromCache: false };
	const { maxAge = 5 * 60 * 1000 } = opts;

	try {
		const entry = await cache.getWithMetadata<KvMetadata<T>>(key, 'json') as { value: KvMetadata<T> | null; metadata: KvMetadata<T> | null };
		if (!entry.value) return { ok: false, fromCache: false };

		const meta = entry.metadata ?? entry.value;
		const age = Date.now() - meta.createdAt;
		if (age > maxAge) {
			// Too stale — treat as miss but don't delete (could still serve with flag)
			return { ok: false, fromCache: false };
		}

		return { ok: true, data: entry.value.data, fromCache: true, age };
	} catch {
		return { ok: false, fromCache: false };
	}
}

interface KvMetadata<T> {
	createdAt: number;
	expiresAt: number;
	data: T;
}

/** Store a JSON value in KV with TTL metadata. */
export async function kvSet<T = unknown>(
	cache: KVNamespace | undefined,
	key: string,
	data: T,
	opts: KvCacheOptions = {}
): Promise<void> {
	if (!cache) return;
	const { ttl = 60 * 60 * 1000 } = opts;
	const now = Date.now();
	const entry: KvMetadata<T> = {
		data,
		createdAt: now,
		expiresAt: now + ttl,
	};
	try {
		await cache.put(key, JSON.stringify(entry), {
			expirationTtl: Math.ceil((ttl + 60_000) / 1000), // seconds; extra 60s buffer for clock skew
		});
	} catch (err) {
		console.warn(`[kvSet] failed to cache ${key}:`, err);
	}
}

/** Delete a key from KV. */
export async function kvDel(
	cache: KVNamespace | undefined,
	key: string
): Promise<void> {
	if (!cache) return;
	try {
		await cache.delete(key);
	} catch (err) {
		console.warn(`[kvDel] failed to delete ${key}:`, err);
	}
}

/** Build a cache key for an API route. */
export function cacheKey(prefix: string, params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) search.set(k, String(v));
	}
	return `${prefix}:${search.toString()}`;
}
