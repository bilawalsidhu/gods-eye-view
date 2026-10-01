/** Login page for the hosted profile. Config is JSON-embedded, escaped. */

const safeJson = (v) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

const STYLE = `
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:radial-gradient(circle at 50% 30%,#0d1b2a,#05070b 70%);color:#e8eaed;font:15px/1.5 Inter,-apple-system,system-ui,sans-serif}
main{width:min(380px,calc(100vw - 32px));padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(12,12,20,.75)}
h1{font:600 13px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.3em;margin:0 0 6px;color:#00d4ff}
p{color:rgba(232,234,237,.6);margin:0 0 18px;font-size:13px}label{display:block;font-size:12px;color:rgba(232,234,237,.6);margin-bottom:6px}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:inherit;font:inherit}
button{margin-top:14px;width:100%;padding:10px;border-radius:10px;border:1px solid #00d4ff;background:rgba(0,212,255,.15);color:#00d4ff;font:inherit;cursor:pointer}
#msg{min-height:20px;margin-top:12px;font-size:13px;color:#f0a63c}`;

export function loginPage(page) {
  if (page.mode === 'tokens') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · God's Eye View</title><style>${STYLE}</style></head><body><main>
<h1>GOD'S EYE VIEW</h1><p>Private instance. Enter your access token.</p>
<form id="f"><label for="t">Access token</label><input id="t" name="token" type="password" autocomplete="current-password" required>
<button>Sign in</button><div id="msg" role="status"></div></form></main>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: document.getElementById('t').value }) });
  if (r.ok) location.replace('/'); else msg.textContent = r.status === 429 ? 'Too many attempts. Wait a minute.' : 'That token was not accepted.';
});
</script></body></html>`;
  }
  const cfg = safeJson({ url: page.supabaseUrl, key: page.anonKey });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · God's Eye View</title><style>${STYLE}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js" crossorigin="anonymous"></script></head><body><main>
<h1>GOD'S EYE VIEW</h1><p>Sign in with a one-time link sent to your email.</p>
<form id="f"><label for="e">Email</label><input id="e" type="email" autocomplete="email" required>
<button>Send sign-in link</button><div id="msg" role="status"></div></form></main>
<script>
const cfg = ${cfg};
const sb = supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false, detectSessionInUrl: true, flowType: 'implicit' } });
const msg = document.getElementById('msg');
async function finish(session) {
  const r = await fetch('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: session.access_token }) });
  if (r.ok) location.replace('/'); else msg.textContent = r.status === 403 ? 'This account is not allowed on this instance.' : 'Sign-in could not be verified.';
}
sb.auth.onAuthStateChange((_event, session) => { if (session) finish(session); });
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithOtp({ email: document.getElementById('e').value, options: { emailRedirectTo: location.origin + '/login', shouldCreateUser: false } });
  msg.textContent = error ? error.message : 'Check your email for the sign-in link.';
});
</script></body></html>`;
}
