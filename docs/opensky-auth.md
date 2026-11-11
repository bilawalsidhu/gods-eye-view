# OpenSky Auth Setup

God's Eye View uses explicit auth modes for `/api/flights`:

- `OPENSKY_AUTH_MODE=oauth` (default, recommended)
- `OPENSKY_AUTH_MODE=auto` (OAuth when configured, otherwise anonymous)
- `OPENSKY_AUTH_MODE=anon`

`OPENSKY_AUTH_MODE=basic` is retired (see below).

Reference: OpenSky REST API docs recommend OAuth2 Client Credentials flow.

## Quick Start (OAuth Client JSON)

Import credentials from JSON (`clientId`/`clientSecret` or `client_id`/`client_secret`) into Keychain:

```bash
./scripts/opensky-import-client.sh ~/Downloads/credentials.json
# or: npm run opensky:import -- ~/Downloads/credentials.json
```

Then launch:

```bash
./scripts/dev-fresh.sh
```

Expected startup lines:

- `OpenSky auth mode: oauth`
- `OpenSky OAuth: configured`

## Optional: Launch With File (No Keychain Import)

```bash
OPENSKY_CREDENTIALS_FILE=~/Downloads/credentials.json ./scripts/dev-fresh.sh
```

Launchers resolve OAuth creds in this order:

1. `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`
2. `OPENSKY_CREDENTIALS_FILE`
3. Keychain (`opensky-network` / `client_id`, `client_secret`)

The server itself reads 1 and 2, so `npm run dev`, `npm run preview` and
Pinokio also work with only `OPENSKY_CREDENTIALS_FILE` set in `.env`, on any
platform. It reads the file on each token refresh.

## Basic Auth (Retired)

OpenSky stopped accepting username/password (HTTP Basic) sign-in on
2026-03-18; its API now takes only OAuth2 client credentials. With
`OPENSKY_AUTH_MODE=basic` the server no longer sends `OPENSKY_USERNAME` /
`OPENSKY_PASSWORD`: it requests anonymously (reason `basic_retired`) and
logs once what to set instead. Create an API client on your OpenSky
account page and use its `credentials.json` as above.

## Troubleshooting

Inspect proxy headers:

```bash
curl -si http://localhost:4173/api/flights | grep -iE 'HTTP/|X-OpenSky-Auth'
```

Useful reasons:

- `oauth_invalid_or_missing`: OAuth client not found/usable
- `oauth_invalid_credentials`: OAuth client rejected by OpenSky
- `missing_oauth_creds`: auto mode found no OAuth client
- `basic_retired`: basic mode requested; answered anonymously
- `rate_limited`: OpenSky throttling
