// Pre-paint locale bootstrap — served as a classic script from the same
// origin so the app CSP ('self' only, no unsafe-inline) allows it. It applies
// the saved (or browser-detected) language to the static loading screen
// before the app module evaluates. The two strings below must mirror
// src/i18n — src/i18n/bootMarkup.test.mjs fails when they drift. Storage
// failures (privacy mode) fall through to browser detection.
(function () {
  var LOCALE_KEY = 'gods-eye-view.locale';
  var locale = null;
  try {
    var saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'zh-CN' || saved === 'en') locale = saved;
  } catch (e) {}
  if (!locale) {
    try {
      var tags =
        navigator.languages && navigator.languages.length
          ? navigator.languages
          : navigator.language
            ? [navigator.language]
            : [];
      for (var i = 0; i < tags.length; i++) {
        var lower = String(tags[i]).toLowerCase().replace(/_/g, '-');
        if (lower === 'en' || lower.indexOf('en-') === 0) {
          locale = 'en';
          break;
        }
        if (lower === 'zh' || lower.indexOf('zh-') === 0) {
          locale = 'zh-CN';
          break;
        }
      }
    } catch (e) {}
  }
  if (locale !== 'zh-CN') locale = 'en';
  document.documentElement.lang = locale;
  if (locale === 'zh-CN') {
    var loaderStatus = document.querySelector('#loading-screen .loader-status');
    if (loaderStatus) loaderStatus.textContent = '正在初始化逼真地球…';
  }
})();
