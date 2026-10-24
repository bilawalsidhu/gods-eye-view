import { t } from '../i18n/index.js';

/** Account controls for the existing console. Only opaque account IDs reach it. */
export function mountChatGptControls({
  root,
  view,
  readJson,
  onChanging,
  onChange,
  onError,
}) {
  const panel = root.getElementById('agent-chatgpt');
  if (!panel)
    return {
      refresh: async () => null,
      setVisible() {},
      setBusy() {},
      destroy() {},
    };
  const accounts = root.getElementById('agent-chatgpt-account');
  const login = root.getElementById('agent-chatgpt-login');
  const logout = root.getElementById('agent-chatgpt-logout');
  const status = root.getElementById('agent-chatgpt-status');
  let snapshot = null;
  let selected = null;
  let timer = null;
  let destroyed = false;
  let busy = false;
  let updating = false;
  let pollGeneration = 0;

  const post = (route, body = {}) =>
    readJson(`/api/agent/chatgpt/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  function paint(data) {
    if (destroyed) return;
    if (selected === null || snapshot?.binding !== data.binding)
      selected =
        data.active ||
        ((data.accounts || []).some((a) => a.id === selected)
          ? selected
          : data.accounts?.[0]?.id) ||
        '';
    snapshot = data;
    accounts.replaceChildren();
    for (const account of data.accounts || []) {
      const option = root.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      accounts.appendChild(option);
    }
    const add = root.createElement('option');
    add.value = '';
    add.textContent = t('Add a ChatGPT account');
    accounts.appendChild(add);
    accounts.value = selected;
    status.textContent = data.pending
      ? t('Complete sign-in in your browser.')
      : data.error ||
        (data.configured && selected === data.active
          ? t('ChatGPT account connected')
          : t('Sign in to use your ChatGPT plan.'));
    setBusy(busy);
  }

  function setBusy(value) {
    busy = value;
    accounts.disabled = busy || updating || snapshot?.pending;
    login.disabled = busy || updating || snapshot?.pending;
    logout.disabled =
      busy || updating || (!snapshot?.configured && !snapshot?.pending);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!snapshot?.pending || destroyed) return;
    const generation = pollGeneration;
    timer = setTimeout(async () => {
      try {
        const previous = snapshot.binding;
        const data = await readJson('/api/agent/chatgpt/status');
        if (destroyed || generation !== pollGeneration) return;
        paint(data);
        if (data.binding !== previous) await onChange();
        schedulePoll();
      } catch (error) {
        if (!destroyed) onError(error.message);
      }
    }, 1500);
  }

  async function refresh() {
    const data = await readJson('/api/agent/chatgpt/status');
    if (destroyed) return null;
    paint(data);
    schedulePoll();
    return { ...data, configured: data.configured && selected === data.active };
  }

  async function signIn() {
    if (busy || updating) return;
    // Open during the click gesture; the returned URL is a local one-time
    // redirect. OAuth tokens and authorization URLs never enter this module.
    const popup = view?.open?.('about:blank', '_blank');
    if (popup) popup.opener = null;
    updating = true;
    setBusy(busy);
    try {
      const data = await post('login', { account: selected || null });
      if (destroyed) {
        popup?.close();
        return;
      }
      if (!/^\/api\/agent\/chatgpt\/authorize\?ticket=[\w-]+$/.test(data.path))
        throw new Error(t('Could not start ChatGPT sign-in.'));
      if (popup) popup.location.href = data.path;
      else {
        paint({ ...snapshot, pending: true });
        const link = root.createElement('a');
        link.href = data.path;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t('Continue with ChatGPT');
        status.replaceChildren(link);
        // Keep the usable link visible until the user opens it.
        link.addEventListener(
          'click',
          () => {
            void refresh().catch((error) => onError(error.message));
          },
          { once: true },
        );
        return;
      }
      await refresh();
    } catch (error) {
      popup?.close();
      if (!destroyed) onError(error.message);
    } finally {
      updating = false;
      setBusy(busy);
    }
  }

  async function selectAccount() {
    if (busy || updating) return;
    onChanging();
    selected = accounts.value;
    updating = true;
    setBusy(busy);
    try {
      if (snapshot.accounts.find((a) => a.id === selected)?.signedIn)
        paint(await post('select', { account: selected }));
      await onChange();
    } catch (error) {
      onError(error.message);
    } finally {
      updating = false;
      setBusy(busy);
    }
  }

  async function signOut() {
    if (busy || updating) return;
    onChanging();
    pollGeneration += 1;
    clearTimeout(timer);
    updating = true;
    setBusy(busy);
    try {
      const data = await post('logout');
      paint(data);
      await onChange();
      if (!data.revoked)
        onError(
          t(
            'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.',
          ),
        );
    } catch (error) {
      onError(error.message);
    } finally {
      updating = false;
      setBusy(busy);
    }
  }

  login.addEventListener('click', signIn);
  accounts.addEventListener('change', selectAccount);
  logout.addEventListener('click', signOut);
  return {
    refresh,
    setBusy,
    setVisible(visible) {
      panel.hidden = !visible;
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      login.removeEventListener('click', signIn);
      accounts.removeEventListener('change', selectAccount);
      logout.removeEventListener('click', signOut);
    },
  };
}
