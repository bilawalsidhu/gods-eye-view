import { createClient } from '@supabase/supabase-js';

export function createCloudClient(env = import.meta.env ?? {}) {
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  if (
    !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ||
    !key.startsWith('sb_publishable_')
  )
    throw new Error('Invalid public Supabase configuration');
  return createClient(url, key, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
export const cloud = createCloudClient();
export async function unwrap(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}
export function placeFromCloud(row, sources) {
  const source = sources.find((s) => s.id === row.source_id);
  return {
    ...row,
    source: source?.name ?? row.source_id,
    sourceUrl: row.source_url,
    reviewed: row.reviewed_at?.slice(0, 10) ?? 'Not reviewed',
    attribution: source?.attribution,
    licence: source?.licence,
    licenceUrl: source?.licence_url,
    kind: source?.kind ?? 'reference',
    stale:
      Date.now() - new Date(row.observed_at).getTime() >
      (source?.stale_after_days ?? 90) * 86400000,
  };
}
export function validateSavedView(view) {
  return (
    view &&
    Number.isFinite(view.latitude) &&
    Math.abs(view.latitude) <= 90 &&
    Number.isFinite(view.longitude) &&
    Math.abs(view.longitude) <= 180 &&
    Number.isFinite(view.height) &&
    view.height >= 1 &&
    view.height <= 50000000 &&
    ['heading', 'pitch', 'roll'].every(
      (k) => Number.isFinite(view[k]) && Math.abs(view[k]) <= 7,
    )
  );
}
