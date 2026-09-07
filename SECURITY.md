# Security

SatView is a local-first visualization of public and third-party data. Report
exploitable issues privately through
[GitHub private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new).

## Identity and trust boundary

The browser calls same-origin BFF routes only. Azure Maps and Microsoft Foundry
access tokens are acquired inside the BFF with `DefaultAzureCredential` and are
never returned to browser code. Foundry realtime setup returns only a
short-lived, session-scoped client secret.

Deployed environments use a managed identity and Entra whole-app
authentication. Grant the identity only the Azure Maps and Foundry data-plane
roles it needs. For local development, run `az login`; the same
`DefaultAzureCredential` chain then uses the Azure CLI session. `AZURE_CLIENT_ID`
selects a user-assigned managed identity when required; it is an identifier, not
a secret.

## Server-owned provider credentials

Private non-Azure credentials remain in the BFF process:

| Setting | Purpose |
|---|---|
| `AISSTREAM_API_KEY` | Live vessel websocket |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional authenticated flight data |
| `FIRMS_MAP_KEY` | NASA active-fire detections |
| `TOMTOM_API_KEY` | Optional live traffic flow |

In Azure, store `AISSTREAM_API_KEY` and any other retained shared credentials in
Key Vault and expose them to the app through managed-identity-authorized secret
references. For local use, put them in an untracked `.env` or the process
environment. Never use a `VITE_*` variable for a secret.

## BFF hardening

- Map tiles, search, routes, attribution, Foundry, and AIS use fixed same-origin
  contracts; the browser cannot submit an arbitrary upstream URL.
- Proxy responses are bounded, timed out, and return sanitized errors.
- Credential-bearing responses use `Cache-Control: no-store`.
- The Vite development server forwards Azure and AIS paths to the BFF; retained
  compatibility routes remain explicitly allow-listed.
- Production ingress requires Entra authentication for the whole application.
- The Entra app registration must enable ID tokens and register
  `https://<container-app-host>/.auth/login/aad/callback`; unauthenticated
  navigation is redirected through the built-in Container Apps login flow.

## Local network exposure

`npm run dev` starts Vite on `http://localhost:4173` and the BFF on
`http://localhost:3000`. Both bind locally by default. `HOST=0.0.0.0` is an
explicit development-only opt-in that exposes the BFF's provider access to the
network; use it only on a trusted network. Vite is not a production security
boundary.

## Responsible use

Data can be delayed, incomplete, inferred, or wrong. Respect provider terms and
privacy, keep model tools narrowly scoped, and do not use the application for
safety-critical or operational decisions.
