// God's Eye View — 中文注入器（运行时 v2）
// 特性：
//   1) 大小写不敏感：界面里的全大写标题（LIVE CONTACTS）也能命中映射。
//   2) 片段替换：按"长键优先"替换文本中的英文片段，覆盖 "POWER UP · 9 KEYS WAITING"、
//      "CCTV OFF"、含数字/符号的动态拼接文本。
//   3) 保护：仅作用于文本节点与 title/aria-label/placeholder/alt；含中文的文本跳过；
//      绝不触碰 URL、CSS 类、id 或任何代码。
//   4) 首屏扫描一次，之后 MutationObserver 监听动态插入 / 文本变化（JS 改写也追得到）。
(function () {
  'use strict';
  var MAP = window.__ZH_MAP__ || {};
  var HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 含空格或标点的键 → 子串匹配；纯词/数字的键 → 词边界匹配，避免误伤（如 OFF 不匹配 OFFSET）。
  function keyToRe(k) {
    var esc = escapeRe(k);
    if (/\s/.test(k) || /[·—\-&:°,./]/.test(k)) return new RegExp(esc, 'gi');
    return new RegExp('(^|[^0-9A-Za-z])' + esc + '(?=[^0-9A-Za-z]|$)', 'gi');
  }

  var entries = Object.keys(MAP)
    .filter(function (k) {
      return k && MAP[k] && MAP[k] !== k && !HAS_CJK.test(k);
    })
    .sort(function (a, b) {
      return b.length - a.length;
    })
    .map(function (k) {
      return { re: keyToRe(k), zh: MAP[k] };
    });

  function translate(text) {
    if (!text || text.length > 400) return null;
    if (!/[A-Za-z]/.test(text)) return null;
    if (HAS_CJK.test(text)) return null; // 已含中文 → 已处理
    var out = text;
    for (var i = 0; i < entries.length; i++) {
      out = out.replace(entries[i].re, entries[i].zh);
    }
    return out === text ? null : out;
  }

  var ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      var r = translate(node.nodeValue);
      if (r !== null) node.nodeValue = r;
      return;
    }
    if (node.nodeType !== 1) return;
    // 图标字体（Material Symbols）的文本是 ligature 名称（如 layers_clear、normal、radio），
    // 一旦翻译会让图标失效。整棵子树跳过。
    var cls = node.getAttribute && node.getAttribute('class');
    if (cls && cls.indexOf('material-symbols') !== -1) return;
    for (var a = 0; a < ATTRS.length; a++) {
      var name = ATTRS[a];
      if (node.getAttribute) {
        var v = node.getAttribute(name);
        if (v) {
          var rv = translate(v);
          if (rv !== null) node.setAttribute(name, rv);
        }
      }
    }
    var kids = node.childNodes;
    if (kids) for (var j = 0; j < kids.length; j++) walk(kids[j]);
  }

  function apply() {
    if (document.body) walk(document.body);
  }

  function start() {
    apply();
    if (window.__ZH_OBS__) return;
    try {
      var obs = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var mut = mutations[m];
          if (mut.type === 'characterData') walk(mut.target);
          else if (mut.addedNodes)
            for (var n = 0; n < mut.addedNodes.length; n++) walk(mut.addedNodes[n]);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      window.__ZH_OBS__ = obs;
    } catch (e) {
      /* MutationObserver 不可用时，至少首屏已翻译 */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
