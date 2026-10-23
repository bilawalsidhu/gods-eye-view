# ChatGPT plan usage for typed GEV commands

This provider extends the GEV COMMAND console from darrendignam's PR #976.
It uses the official open-source Sign in with ChatGPT preview. A ChatGPT
subscription alone does not grant generic API access: the user must authorize
plan usage, have an eligible account and select an available model. OpenAI API
keys, billing and limits remain separate. There is no automatic paid API fallback.

## Use

1. Run GEV locally and open GEV COMMAND.
2. Select **ChatGPT plan**, then **Continue with ChatGPT**. Authorization opens
   in your browser. If a popup is blocked, use the link shown in the console.
3. Review the permissions and plan usage allowance on OpenAI's authorization
   page. Return to GEV when the loopback callback confirms the connection.
4. Choose a model from that account's catalog and send a command. No voice
   session, microphone permission or API key is needed for this provider.
5. Use STOP to cancel inference and prevent remaining queued tool calls. It
   cannot undo an action that has already run, or forcibly interrupt every
   existing application action while that action is in progress.

The account selector keeps workspace registrations distinct even if they share
an email. Switching clears the conversation. A command remains bound to its
original account; if another tab changes accounts, reload the models and start
a new conversation. Closing the dialog only hides it; use STOP to cancel.

**Sign out / cancel sign-in** stops pending authorization or signs out the active
account. It keeps the client registration for a later login. If remote revocation
cannot be confirmed, the console says so; disconnect the app in ChatGPT Settings.
Other saved accounts remain signed in until explicitly selected and signed out.

The UI links to ChatGPT Settings for plan usage and access management. A limit
or permission error stops the request; switching to an API-key or local provider
requires an explicit user choice. Plan usage is not reported as free inference.

## Credentials and privacy

GEV stores its own account registrations and rotating tokens in
`~/.config/gods-eye-view/chatgpt/accounts.json`. `GEV_CHATGPT_AUTH_DIR` may select
a different private directory outside the repository. Do not copy credentials
from Codex or set an OAuth token as `OPENAI_API_KEY`. Nothing in this feature
reads or updates Codex's `auth.json` or changes the existing Realtime integration.

Writes use a fresh hardened file, fsync and atomic rename. Unix credentials are
owner-only; Windows reuses Provider Settings' verified DACL hardener. The directory
and file must not be symlinks. A lock serializes token refresh across processes;
after an abnormal termination, stop all GEV instances before removing a stranded
`accounts.lock`. Never remove the lock while an instance may be refreshing.

Commands, relevant tool results and conversation context are sent to OpenAI.
The conversation and encrypted reasoning continuation remain in browser memory,
with size/history bounds inherited from GEV COMMAND; they are not saved to browser
storage. `store:false` disables stored Responses continuation; it does not mean
inference happens offline or independently establish a provider retention policy.
This flow does not import your existing ChatGPT conversations.

## Protocol and integration boundaries

- OAuth uses a GEV-owned dynamic client, a stable opaque host UUID, PKCE S256,
  fresh state/nonce, an HTTP `127.0.0.1` callback and verified ID tokens. Granted
  plan-use scopes are checked separately from identity.
- ChatGPT management and inference refuse remote/LAN clients, foreign origins,
  forwarded/proxy requests and non-local Host headers. `HOST=0.0.0.0` does not
  expose this account's allowance. Remote hosted deployments are outside scope.
- The public `/v1/models` OAuth catalog and `/v1/responses` endpoint are fixed.
  No ChatGPT `backend-api`, arbitrary gateway, Codex token reuse or
  `/chat/completions` OAuth request is used.
- Responses uses HTTP/SSE, `store:false`, `stream:true`, namespaced function
  tools and replayed input. Unsupported preview fields and hosted tools are
  omitted. Only a completed response is converted into the shared validator's
  tool calls; functions execute through #976's existing browser action runner.
- API-key OpenAI/OpenRouter and local Ollama remain available. #1223's DeepSeek
  and MiMo provider work could be adapted independently to the same transport
  contract; this PR does not copy that panel or change HUD Summary.

## Verification and release gate

Run `node --test src/agent/*.test.mjs server/providers/agent/chatgpt/*.test.mjs`,
and `node scripts/qa-agent-chatgpt.mjs` for the real console with fixture
responses in en/es/ru/zh-CN at two viewport sizes. Then run the repository baseline: `npm test`, `npm run build`, `npm run test:track`
with a dev server, plus `node scripts/qa-agent-console.mjs --offline` for console
chrome. `--offline` does not certify inference. The focused tests use temporary
credential stores, locally signed fixture JWTs and synthetic Responses streams.
They never require real credentials or make a paid model call.

Before marking this integration ready, test with an eligible account: first
registration, returning sign-in, model discovery, a tool/result round trip,
refresh, STOP, quota/permission errors, two-account switching and revocation.
Record model/plan and sanitized outcomes, never tokens or authorization URLs.
Live OAuth and native Windows credential protection have not been certified by
these fixtures. The branch depends on #976; rebase the complementary commit after
that PR lands and rerun the relevant gates.

The protocol follows OpenAI's documentation reviewed on 2026-10-23:
[registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[accounts](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
and [function namespaces](https://developers.openai.com/api/docs/guides/function-calling).
