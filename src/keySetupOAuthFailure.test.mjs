// A failed ChatGPT OAuth check whose only reason is our own fallback sentence
// shows it alone; a server-sent reason keeps the «OAuth check failed» wrapper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthCheckFailureText, waitForChatGptOAuth } from './keySetup.js';
import { setLocale } from './i18n/index.js';

const failWith = (payload, ok = true) =>
  waitForChatGptOAuth({
    fetchImpl: async () => ({ ok, json: async () => payload }),
    sleep: () => assert.fail('failed login must stop polling'),
  }).then(
    () => assert.fail('expected a rejection'),
    (error) => error,
  );

test('a fallback-only OAuth failure is shown without the wrapper in every locale', async (t) => {
  t.after(() => setLocale('en'));
  const expected = {
    en: 'Could not check ChatGPT sign-in. Try again.',
    ru: 'Не удалось проверить вход в ChatGPT. Попробуйте ещё раз.',
    es: 'No se pudo comprobar el inicio de sesión de ChatGPT. Inténtalo de nuevo.',
  };
  for (const [locale, text] of Object.entries(expected)) {
    setLocale(locale);
    const loginFailed = await failWith({ available: false, loginFailed: true });
    assert.equal(oauthCheckFailureText(loginFailed), text);
    const httpFailed = await failWith({}, false);
    assert.equal(oauthCheckFailureText(httpFailed), text);
  }
});

test('a server-sent or network OAuth failure keeps the «OAuth check failed» wrapper', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('en');
  const server = await failWith({
    loginFailed: true,
    error: 'Sign-in is local only.',
  });
  assert.equal(
    oauthCheckFailureText(server),
    'OAuth check failed: Sign-in is local only.',
  );
  assert.equal(
    oauthCheckFailureText(new TypeError('Failed to fetch')),
    'OAuth check failed: Failed to fetch',
  );
  setLocale('ru');
  assert.match(
    oauthCheckFailureText(server),
    /^Не удалось проверить OAuth: Sign-in is local only\.$/,
  );
});
