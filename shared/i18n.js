// Zweite Sprache (Englisch). Alle Texte der App sind auf Deutsch geschrieben; ist Englisch eingestellt,
// werden sie beim Anzeigen übersetzt – über ein Wörterbuch Deutsch → Englisch (web/shared/i18n-en.js).
// Der Core fügt dieses Skript (und bei Englisch das Wörterbuch) automatisch in jede Seite ein und setzt
// window.OM_LANG. Übersetzt werden Texte im Seitenaufbau (auch nachträglich eingefügte), Tooltips und
// Platzhalter sowie über OMT() Texte, die direkt gezeichnet werden (Canvas).
// Einträge mit {0}, {1} … sind Muster: «Runde {0}» übersetzt auch «Runde 16» → «Lap 16».
(function () {
  'use strict';
  if (window.OMI18N) return; // schon geladen (vom Core eingefügt)
  const qs = (() => { try { return new URLSearchParams(location.search).get('lang'); } catch { return null; } })();
  let lang = window.OM_LANG || qs || null;
  if (!lang) { // Seiten ohne Core (Team-Seite im Web): Sprache des Browsers
    try { lang = localStorage.getItem('om.lang'); } catch { /* egal */ }
    if (!lang) lang = /^de\b/i.test(navigator.language || '') ? 'de' : 'en';
  }
  lang = lang === 'en' ? 'en' : 'de';
  const dict = Object.create(null), pats = [], memo = new Map();
  let active = false;
  const LETTERS = /[A-Za-zÄÖÜäöüß]{2}/;
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

  function add(map) {
    for (const [de, en] of Object.entries(map || {})) {
      if (typeof en !== 'string' || !en) continue;
      if (/\{\d+\}/.test(de)) {
        const order = [];
        const re = new RegExp('^' + esc(de).replace(/\\?\{(\d+)\\?\}/g, (_, n) => { order.push(Number(n)); return '(.*?)'; }) + '$');
        pats.push({ re, order, en, n: de.length, short: !/^\{\d+\}/.test(de) && de.replace(/\{\d+\}/g, '').trim().length < 14 });
      } else dict[de] = en;
    }
    pats.sort((a, b) => b.n - a.n); // längere (genauere) Muster zuerst
    memo.clear();
    active = lang === 'en' && (Object.keys(dict).length > 0 || pats.length > 0);
  }

  function core(s) {
    if (s in dict) return dict[s];
    for (const p of pats) {
      const m = p.re.exec(s);
      if (!m) continue;
      // kurze Muster («Seite {0}», «Fahrer {0}») nur mit Zahlen/Zeichen füllen, nicht mit ganzen Wörtern
      if (p.short && m.slice(1).some((v) => LETTERS.test(v || '') && core(String(v).trim()) == null)) continue;
      const vals = [];
      p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
      return p.en.replace(/\{(\d+)\}/g, (_, n) => { const v = vals[Number(n)]; return v === undefined ? '' : (LETTERS.test(v) ? core(v.trim()) ?? v : v); });
    }
    // Aufzählungen mit Komma (z. B. ausgeblendete Spalten)
    if (s.includes(', ')) {
      const parts = s.split(', ');
      const tr = parts.map((x) => core(x.trim()) ?? x);
      if (tr.some((x, i) => x !== parts[i])) return tr.join(', ');
    }
    // Teile mit « · » getrennt (z. B. «gemessen · 7 Stopps»)
    if (s.includes(' · ')) {
      const parts = s.split(' · ');
      const tr = parts.map((x) => core(x.trim()) ?? x);
      if (tr.some((x, i) => x !== parts[i])) return tr.join(' · ');
    }
    return null;
  }

  const done = new Set(); // bereits übersetzte Texte nicht nochmals übersetzen (sonst greifen Muster auf Englisch)
  function t(str) {
    if (!active || typeof str !== 'string') return str;
    if (str.length < 2 || !LETTERS.test(str) || done.has(str)) return str;
    let r = memo.get(str);
    if (r === undefined) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(str);
      const tr = core(m[2]);
      r = tr === null || tr === undefined ? str : m[1] + tr + m[3];
      if (memo.size > 8000) { memo.clear(); done.clear(); }
      memo.set(str, r);
      if (r !== str) done.add(r);
    }
    return r;
  }

  // ---------- Seite übersetzen ----------
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip', 'data-label', 'label'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);
  const skip = (el) => !el || SKIP.has(el.nodeName) || (el.closest && el.closest('[data-no-i18n],[contenteditable="true"]'));
  function textNode(n) {
    const v = n.nodeValue;
    if (!v || v.length < 2) return;
    const tr = t(v);
    if (tr !== v) n.nodeValue = tr;
  }
  function attrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const tr = t(v); if (tr !== v) el.setAttribute(a, tr); }
    }
    if (el.nodeName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) { const tr = t(el.value); if (tr !== el.value) el.value = tr; }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skip(root.parentElement)) textNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skip(root)) return; attrs(root); }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return SKIP.has(n.nodeName) || n.hasAttribute('data-no-i18n') || n.getAttribute('contenteditable') === 'true' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = it.nextNode())) { if (n.nodeType === 3) textNode(n); else attrs(n); }
  }
  let observer = null;
  function start() {
    if (!active) return;
    walk(document.documentElement);
    if (document.title) document.title = t(document.title);
    if (observer) return;
    observer = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') { if (!skip(m.target.parentElement)) textNode(m.target); }
        else if (m.type === 'attributes') { if (!skip(m.target)) attrs(m.target); }
        else for (const n of m.addedNodes) walk(n);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']) });
  }

  // Dialoge des Browsers
  if (lang === 'en') {
    for (const fn of ['alert', 'confirm', 'prompt']) {
      const orig = window[fn];
      if (typeof orig === 'function') window[fn] = function (msg, ...rest) { return orig.call(window, t(String(msg ?? '')), ...rest); };
    }
  }

  // Texte, die direkt gezeichnet werden (Canvas: Karten, Grafiken, Circle of Doom)
  if (lang === 'en' && window.CanvasRenderingContext2D) {
    const P = CanvasRenderingContext2D.prototype;
    for (const fn of ['fillText', 'strokeText', 'measureText']) {
      const orig = P[fn];
      P[fn] = function (text, ...rest) { return orig.call(this, typeof text === 'string' ? t(text) : text, ...rest); };
    }
  }

  window.OMI18N = {
    lang, add, t, apply: walk,
    // Zahlen-/Datumsformat der gewählten Sprache
    locale: lang === 'en' ? 'en-GB' : 'de-CH',
    start,
  };
  window.OMT = t;
  if (lang === 'en') document.documentElement.lang = 'en';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0);
})();
