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

Writes use a fresh hardened file, fsync and atomic rename. Unix credentials and
their directory must be owned by the current user with no group/other permissions.
Windows reuses Provider Settings' DACL hardener and a non-mutating verifier:
every read checks the directory and account file; transactions also recheck the
lock and destination after an awaited update. Existing unsafe or unverifiable
permissions are rejected, not silently repaired. Newly created directories,
empty lock files and empty temporary files are hardened before use. The directory
and file must not be symlinks, and credential files must not have hard-link aliases.
A lock serializes token refresh across processes;
after an abnormal termination, stop all GEV instances before removing a stranded
`accounts.lock`. Never remove the lock while an instance may be refreshing.

### Windows storage review (2026-10-23)

The review found a defense-in-depth gap: the original Windows writer checked its
temporary file's DACL, but `read()` checked only file type and size on Windows.
A later ACL change could therefore leave a store readable or writable by another
local principal while GEV continued using it. No remote exploit or cross-user
token theft was demonstrated by this review. Exploitability depends on the
effective permissions, directory ancestry and privileges on the actual machine.

| Condition | Storage behavior after this change |
| --- | --- |
| Existing account file or directory has an unsafe/unverifiable Windows ACL | Reject before reading token bytes or invoking the transaction callback; do not repair permissions. |
| A new directory, lock or empty temporary file cannot be hardened | Reject; never write credentials to that temporary file. |
| Permissions change while a transaction awaits refresh | Recheck before committing; reject and retain the previous committed account file. A remotely rotated token may then require a new sign-in. |
| Temporary-file verification, write, fsync or rename fails | Reject; attempt cleanup and preserve the previously committed store. |
| A held lock is replaced | Refuse the commit and leave the replacement lock in place. |
| A competing process holds the lock | Wait up to the configured deadline, then reject; do not steal the lock. |

The Windows verifier requires inheritance disabled and exactly three explicit
FullControl allow entries: the current process user's SID, SYSTEM and the local
Administrators group. It rejects inherited entries, extra principals, denials,
missing/reduced grants and propagation-only entries. The owner must also be one
of these trusted principals: an otherwise restricted DACL does not protect a
file whose untrusted owner can rewrite that DACL. The same policy applies to the
store directory, because a writable directory can allow entry replacement or
lock deletion independently of the child file's write permissions.

The verifier shares the hardener's canonical, absolute Windows tool resolution
and isolated PowerShell module environment. It never invokes `icacls` to repair
an existing ACL. Ambiguous tool paths, identity/ACL query errors, nonzero exits,
signals and timeouts fail closed. Case-insensitive environment aliases cannot
override the verification target, expected SID or trusted module path.

Reads use an open descriptor and compare it with the pathname around ACL
verification and reading; transactions recheck their held lock before writing.
These checks detect ordinary replacements and in-place changes. A reader racing
an atomic commit can receive a storage error and retry, instead of accepting
inconsistent data. These are **not atomic Windows handle-based ACL checks** and
do not claim to eliminate all adversarial TOCTOU races. The configured directory
must be on a local filesystem that supports the checked Windows ACLs, beneath
trusted parent directories; this implementation does not audit all ancestors.
Malware running as the user, SYSTEM or an administrator remains outside this
storage boundary, as do privileged backups and already-open foreign handles.
ACLs are access control, not encryption at rest.

**Existing Windows installations:** a directory created by an earlier build may
still use inherited ACLs and will now be refused, even if its account file passes.
If storage is refused, stop GEV, inspect the directory and its parents, and revoke
GEV's authorization in ChatGPT Settings if exposure is possible. Reauthorization
in a fresh private GEV directory is preferable to trusting possibly modified
records. Select an absent final directory via `GEV_CHATGPT_AUTH_DIR` so GEV can
create and harden it. Remove only obsolete GEV account data after resolving any
exposure; do not remove Codex's `auth.json` or API-key configuration. Fixing an ACL
cannot retract credentials already copied or prove that saved data was unaltered.

Microsoft documents [file access checks and security descriptors](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights),
[directory deletion and DACL/owner rights](https://learn.microsoft.com/en-us/windows/win32/wmisdk/file-and-directory-access-rights-constants),
and [owner access rights](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/access-mask).

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

For storage-specific validation, run:

```sh
node --test src/keySetupHardening.test.mjs server/providers/common/credential-file.test.mjs server/providers/agent/chatgpt/store.test.mjs
```

Portable regressions cover simulated Windows ACL rejection, read-before-verify
prevention, hardening/query failures, temporary-file cleanup, changes during
awaited updates, lock replacement, timeout, queue recovery, and concurrent writes
from independent store objects and separate Node processes. POSIX mode checks run
on POSIX hosts. Simulated ACL outcomes do not execute or certify PowerShell/NTFS.
The native-only tests use synthetic files and real Windows tools to apply the
policy and then broaden a file/directory DACL, enable inheritance or add a deny
entry; those tests are skipped outside Windows. The existing Windows onboarding
CI job now runs both storage test files in addition to the shared hardener tests.

Native Windows execution remains a release gate until a successful run is
recorded. It should also include a second non-administrator account attempting
read/write/delete, ordinary and elevated launches, a 32-bit caller where
supported, and a custom path under trusted parents. Review unexpected ownership,
reparse points and filesystem ACL support there. CI being `action_required` means
execution needs authorization; it is not evidence that these tests passed or failed.

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
