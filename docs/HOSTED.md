# Hosted profile

`npm run build && npm run start:hosted` serves the built app and the same
providers as the dev server from one Node process, behind sign-in. It is
meant for you and people you invite, not open public access.

## Required settings

| Variable | Meaning |
| --- | --- |
| `GEV_AUTH_MODE` | `tokens` or `supabase`; the server refuses to start without it |
| `GEV_SESSION_SECRET` | 32+ random characters; signs the session cookie |
| `GEV_ACCESS_TOKENS` | tokens mode: `alice:<24+ char token>:admin,bob:<token>` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | supabase mode: project URL and publishable key |
| `SUPABASE_JWT_SECRET` | supabase mode, legacy HS256 projects only; newer projects are verified through their JWKS |

## Recommended

| Variable | Meaning |
| --- | --- |
| `GEV_DATABASE_URL` | Postgres (Supabase works: use the pooled connection string with `sslmode=require`) so history survives redeploys |
| `GEV_ALLOWED_USERS` | supabase mode: comma-separated emails or user ids allowed in; sign-up is disabled on the login page either way |
| `GEV_ADMIN_USERS` | emails, user ids or token names that may edit recorder regions |
| `GEV_PUBLIC_ORIGIN` | e.g. `https://eye.example.com`; pins the allowed Origin for writes |
| `GEV_QUOTAS` | per-user limits, e.g. `/api/realtime/token=10/3600,*=900/60` |
| `GEV_TRUST_PROXY=1` | behind Fly/Render/Cloudflare, use forwarded client IP and host |

Browser-visible keys (`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`) are baked in
at build time and must be referrer-restricted to your domain (SECURITY.md).

## What changes when hosted

- Every page and API call needs a session; unauthenticated API calls get 401.
- Writes must carry your own Origin; cookies are HttpOnly, SameSite=Lax, Secure.
- Each user has their own watchlists, fences, rules, webhooks and alerts.
- Per-user quotas protect the operator's API allowances; 429 with Retry-After.
- Not mounted: in-app key setup (writes `.env`), local receivers (LAN
  devices), realtime debug log, and the alert simulator.
- DelDOT live video defaults off (`CCTV_DELDOT_ENABLED=0`): its terms do not
  clearly allow redistribution.

## Deploy on Fly.io

```bash
fly launch --no-deploy            # uses the included fly.toml and Dockerfile
fly secrets set GEV_AUTH_MODE=tokens \
  GEV_SESSION_SECRET="$(openssl rand -base64 48)" \
  GEV_ACCESS_TOKENS="you:$(openssl rand -hex 24):admin" \
  GEV_DATABASE_URL="postgres://…"
fly deploy
```

Any container host works the same way (Render, Railway, a VPS): run the
image, set the secrets, expose port 8080, health check `GET /healthz`.

## Before inviting anyone else

Check each data source's terms for your use (DATA_SOURCES.md). In
particular: Cesium ion's free plan is for eligible non-commercial use;
OpenSky data is non-commercial; adsb.lol is ODbL, which applies share-alike
to databases derived from it, and the recorded track store counts as one;
CC BY camera providers need their attribution kept.
