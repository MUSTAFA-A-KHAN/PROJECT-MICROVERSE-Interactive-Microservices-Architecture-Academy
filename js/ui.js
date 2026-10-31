/* ==========================================================================
   Microverse — UI primitives shared by every page:
   icons, escaping, code blocks, toasts, dialogs, confirm, popovers,
   tooltips, spotlight effect, motion helpers and content loading.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  MV.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  MV.sleep = (ms) => new Promise((r) => setTimeout(r, MV.reducedMotion ? Math.min(ms, 20) : ms));

  /* ---------- Icons (Lucide icon data, rendered as inline SVG) ---------- */
  const iconCache = new Map();
  const pascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

  function iconNode(name) {
    const local = MV.iconData && MV.iconData[name];
    if (local) return local;
    const lib = window.lucide && window.lucide.icons;
    return lib ? lib[pascal(name)] : null;
  }

  /** Returns an inline SVG string for a Lucide icon name (kebab-case). */
  function icon(name, cls = '', size) {
    const key = name + '|' + cls + '|' + (size || '');
    if (iconCache.has(key)) return iconCache.get(key);
    const node = iconNode(name);
    const sz = size ? ` width="${size}" height="${size}"` : '';
    let svg;
    if (!node) {
      svg = `<svg class="${cls}" viewBox="0 0 24 24"${sz} fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>`;
    } else {
      const children = node.map(([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
      svg = `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${sz} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
    }
    iconCache.set(key, svg);
    return svg;
  }

  /* ---------- Code blocks ---------- */
  const LANG_LABEL = { go: 'Go', yaml: 'YAML', yml: 'YAML', sql: 'SQL', dockerfile: 'Dockerfile', bash: 'Shell', sh: 'Shell', json: 'JSON', proto: 'Protobuf', http: 'HTTP', promql: 'PromQL', text: 'Text', makefile: 'Makefile', env: 'Env' };

  function parseRanges(spec) {
    const set = new Set();
    if (!spec) return set;
    String(spec).split(',').forEach((part) => {
      const [a, b] = part.split('-').map((n) => parseInt(n, 10));
      if (!isNaN(a)) for (let i = a; i <= (isNaN(b) ? a : b); i++) set.add(i);
    });
    return set;
  }

  /**
   * Render a code block.
   * opts: { lang, title, highlight: "3-5,9", lineNumbers: true, maxHeight, annotations: {line: text}, startLine }
   */
  function codeBlock(code, opts = {}) {
    const lang = (opts.lang || 'text').toLowerCase();
    const lines = MV.highlight.lines(code.replace(/\n$/, ''), lang);
    const hl = parseRanges(opts.highlight);
    const ann = opts.annotations || {};
    const start = opts.startLine || 1;
    const ln = opts.lineNumbers !== false && lines.length > 1;
    const rows = lines.map((html, i) => {
      const n = i + start;
      const hlc = hl.has(n) ? ' code-row-hl' : '';
      const a = ann[n] ? ` is-annotated" data-ann="${n}" tabindex="0" role="button" aria-label="Note on line ${n}` : '';
      return `<span class="code-ln${hlc}${a}">${n}</span><span class="code-line${hlc}" data-line="${n}">${html || ' '}</span>`;
    }).join('');
    const title = opts.title
      ? `${icon(lang === 'go' ? 'file-code-2' : lang === 'yaml' || lang === 'yml' ? 'file-cog' : lang === 'sql' ? 'database' : lang === 'bash' || lang === 'sh' ? 'terminal' : 'file-text')}<span class="file">${esc(opts.title)}</span>`
      : `${icon('code-xml')}<span class="file">${esc(LANG_LABEL[lang] || lang)}</span>`;
    const maxH = opts.maxHeight ? ` style="--code-max:${opts.maxHeight}"` : '';
    return `<div class="code-block${ln ? '' : ' no-ln'}" data-lang="${esc(lang)}">
      <div class="code-head">${title}<span class="code-lang">${esc(opts.title ? (LANG_LABEL[lang] || lang) : '')}</span>
        <button type="button" class="code-copy" data-copy aria-label="Copy code">${icon('copy')}<span>Copy</span></button>
      </div>
      <div class="code-scroll scroll-thin" data-lenis-prevent${maxH}><pre class="code-table">${rows}</pre></div>
      <textarea hidden data-raw>${esc(code)}</textarea>
    </div>`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // Delegated copy handler for every code block in the app.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const raw = block ? $('[data-raw]', block).value : btn.getAttribute('data-copy');
    const ok = await copyText(raw);
    if (ok) {
      btn.classList.add('is-copied');
      const label = $('span', btn);
      if (label) label.textContent = 'Copied';
      btn.innerHTML = icon('check') + (label ? '<span>Copied</span>' : '');
      setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = icon('copy') + (label ? '<span>Copy</span>' : ''); }, 1600);
    } else {
      toast('Copy failed', { type: 'error', desc: 'Your browser blocked clipboard access. Select the code and copy it manually.' });
    }
  });

  /* ---------- Toasts ---------- */
  const TOAST_ICON = { success: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info' };
  function toast(title, opts = {}) {
    const root = $('#toaster');
    if (!root) return;
    const type = opts.type || 'info';
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `${icon(TOAST_ICON[type])}
      <div><div class="toast-title">${esc(title)}</div>${opts.desc ? `<div class="toast-desc">${esc(opts.desc)}</div>` : ''}
      ${opts.action ? `<div class="toast-action"><button class="btn btn-sm" type="button">${esc(opts.action.label)}</button></div>` : ''}</div>
      <button class="toast-close" type="button" aria-label="Dismiss">${icon('x')}</button>`;
    root.appendChild(el);
    while (root.children.length > 4) root.firstElementChild.remove();
    const remove = () => {
      if (!el.isConnected) return;
      if (window.Motion && !MV.reducedMotion) {
        Motion.animate(el, { opacity: 0, transform: 'translateX(24px)' }, { duration: 0.2 }).finished.then(() => el.remove());
      } else el.remove();
    };
    if (window.Motion && !MV.reducedMotion) {
      Motion.animate(el, { opacity: [0, 1], transform: ['translateY(12px) scale(0.97)', 'none'] }, { type: 'spring', bounce: 0.25, duration: 0.45 });
    }
    $('.toast-close', el).addEventListener('click', remove);
    if (opts.action) $('.toast-action button', el).addEventListener('click', () => { opts.action.onClick(); remove(); });
    setTimeout(remove, opts.duration || 3800);
  }

  /* ---------- Dialog (focus-trapped modal) ---------- */
  let openDialog = null;
  function dialog({ title, desc, body = '', footer = '', className = '', onOpen, onClose, labelledBy, raw = false }) {
    closeDialog();
    const lastFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'dialog-scrim';
    const id = 'dlg-' + Math.random().toString(36).slice(2, 8);
    scrim.innerHTML = raw
      ? `<div class="dialog ${className}" role="dialog" aria-modal="true" aria-label="${esc(labelledBy || title || 'Dialog')}">${body}</div>`
      : `<div class="dialog ${className}" role="dialog" aria-modal="true" aria-labelledby="${id}">
          <div class="dialog-head"><div><h2 class="dialog-title" id="${id}">${esc(title)}</h2>${desc ? `<p class="dialog-desc">${esc(desc)}</p>` : ''}</div>
            <button class="icon-btn dialog-close" type="button" data-close aria-label="Close">${icon('x')}</button></div>
          <div class="dialog-body scroll-thin" data-lenis-prevent>${body}</div>
          ${footer ? `<div class="dialog-foot">${footer}</div>` : ''}
        </div>`;
    $('#overlay-root').appendChild(scrim);
    const panel = $('.dialog', scrim);
    if (window.Motion && !MV.reducedMotion) {
      Motion.animate(scrim, { opacity: [0, 1] }, { duration: 0.15 });
      Motion.animate(panel, { opacity: [0, 1], transform: ['translateY(8px) scale(0.98)', 'none'] }, { type: 'spring', bounce: 0.2, duration: 0.35 });
    }
    const close = (result) => {
      if (!scrim.isConnected) return;
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      openDialog = null;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      onClose && onClose(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const f = $$('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])', panel).filter((n) => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    $$('[data-close]', scrim).forEach((b) => b.addEventListener('click', () => close()));
    openDialog = { close, el: panel };
    onOpen && onOpen(panel, close);
    if (!panel.contains(document.activeElement)) {
      const auto = $('[autofocus], input, button.btn-primary, button', panel);
      auto && auto.focus();
    }
    return openDialog;
  }
  function closeDialog() { if (openDialog) openDialog.close(); }

  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      dialog({
        title,
        body: `<p>${esc(message)}</p>`,
        footer: `<button class="btn" type="button" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-ok>${esc(confirmText)}</button>`,
        onOpen(panel, close) { $('[data-ok]', panel).addEventListener('click', () => { result = true; close(); }); $('[data-ok]', panel).focus(); },
        onClose() { resolve(result); },
      });
    });
  }

  /* ---------- Popover menus ---------- */
  let openPop = null;
  function popover(anchor, html, { onOpen, align = 'end' } = {}) {
    closePopover();
    const el = document.createElement('div');
    el.className = 'popover';
    el.setAttribute('role', 'menu');
    el.innerHTML = html;
    $('#overlay-root').appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    if (window.Motion && !MV.reducedMotion) Motion.animate(el, { opacity: [0, 1], transform: ['translateY(-4px) scale(0.98)', 'none'] }, { duration: 0.16 });
    anchor.setAttribute('aria-expanded', 'true');
    const onDoc = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { closePopover(); anchor.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = $$('.menu-item', el);
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    openPop = { el, anchor, cleanup: () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); anchor.setAttribute('aria-expanded', 'false'); } };
    onOpen && onOpen(el);
    const first = $('.menu-item', el);
    first && first.focus();
    return el;
  }
  function closePopover() {
    if (!openPop) return;
    openPop.cleanup();
    openPop.el.remove();
    openPop = null;
  }
  document.addEventListener('click', (e) => { if (e.target.closest('.popover [data-close-pop]')) closePopover(); });

  /* ---------- Tooltips (delegated, for any [data-tip]) ---------- */
  let tipTarget = null, tipTimer = null;
  function showTip(target) {
    const tip = $('#tooltip');
    if (!tip) return;
    const text = target.getAttribute('data-tip');
    if (!text) return;
    const kbd = target.getAttribute('data-tip-kbd');
    tip.innerHTML = esc(text) + (kbd ? `<span class="kbd">${esc(kbd)}</span>` : '');
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const side = target.getAttribute('data-tip-side') || 'bottom';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left, top;
    if (side === 'right') { left = r.right + 8; top = r.top + r.height / 2 - h / 2; }
    else if (side === 'top') { left = r.left + r.width / 2 - w / 2; top = r.top - h - 8; }
    else { left = r.left + r.width / 2 - w / 2; top = r.bottom + 8; }
    tip.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
  }
  function hideTip() { clearTimeout(tipTimer); tipTarget = null; const tip = $('#tooltip'); if (tip) tip.hidden = true; }
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t === tipTarget) return;
    hideTip();
    if (!t || e.pointerType === 'touch') return;
    if (t.hasAttribute('data-tip-collapsed-only') && !document.querySelector('.app.is-collapsed')) return;
    tipTarget = t;
    tipTimer = setTimeout(() => showTip(t), 350);
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t.matches(':focus-visible')) {
      if (t.hasAttribute('data-tip-collapsed-only') && !document.querySelector('.app.is-collapsed')) return;
      tipTarget = t; showTip(t);
    }
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('pointerdown', hideTip);

  /* ---------- Spotlight effect (pointer-following glow on .spotlight) ---------- */
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('.spotlight');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });

  /* ---------- Motion helpers ---------- */
  function revealIn(root) {
    if (!root || MV.reducedMotion || !window.Motion) return;
    const items = $$('[data-reveal]', root);
    if (!items.length) return;
    Motion.animate(items, { opacity: [0, 1], transform: ['translateY(8px)', 'none'] }, { delay: Motion.stagger(0.035), duration: 0.38, ease: [0.2, 0.8, 0.2, 1] });
  }

  function countUp(el, to, { duration = 0.9, suffix = '' } = {}) {
    if (!el) return;
    if (MV.reducedMotion || !window.Motion) { el.textContent = Math.round(to) + suffix; return; }
    Motion.animate(0, to, { duration, ease: [0.2, 0.8, 0.2, 1], onUpdate: (v) => { el.textContent = Math.round(v) + suffix; } });
  }

  /* ---------- Progress ring ---------- */
  function ring(pct, size = 16, stroke = 2.5, cls = '') {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const off = c * (1 - Math.max(0, Math.min(1, pct)));
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="transform:rotate(-90deg)">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
      <circle class="ring-value${pct >= 1 ? ' is-done' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
    </svg>`;
  }

  /* ---------- Content loading (markdown files under /content) ---------- */
  const contentCache = new Map();
  async function fetchText(path) {
    if (contentCache.has(path)) return contentCache.get(path);
    const p = fetch(path, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} while loading ${path}`);
      return r.text();
    });
    contentCache.set(path, p);
    try { return await p; } catch (e) { contentCache.delete(path); throw e; }
  }

  function loadError(err) {
    const fileProto = location.protocol === 'file:';
    return `<div class="callout callout-warn">${icon('triangle-alert')}<div><div class="callout-title">Content couldn't load</div>
      <div class="callout-body"><p>${fileProto
        ? 'Microverse loads lessons and source files with <code>fetch()</code>, which browsers block for pages opened from the file system.'
        : esc(err && err.message ? err.message : 'The request failed.')}</p>
      <p>Start the local dev server from the project folder and open <code>http://localhost:5173</code>:</p>
      ${codeBlock('npm run dev\n# or, without Node.js:\npython -m http.server 5173', { lang: 'bash', lineNumbers: false })}</div></div></div>`;
  }

  function skeleton(lines = 6) {
    let out = '<div class="grid gap-3" aria-busy="true" aria-label="Loading"><div class="skeleton sk-title"></div>';
    for (let i = 0; i < lines; i++) out += `<div class="skeleton sk-line" style="width:${70 + ((i * 37) % 30)}%"></div>`;
    return out + '</div>';
  }

  /* ---------- Small formatting helpers ---------- */
  function fmtDuration(seconds) {
    const s = Math.round(seconds || 0);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }
  function inlineMd(s) {
    // Inline-only markdown for short strings in data files: `code`, **bold**, *em*, [text](href)
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${h}"${/^https?:/.test(h) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);
  }

  MV.ui = {
    $, $$, esc, icon, codeBlock, copyText, toast, dialog, closeDialog, confirm: confirmDialog,
    popover, closePopover, revealIn, countUp, ring, fetchText, loadError, skeleton,
    fmtDuration, timeAgo, inlineMd, parseRanges,
  };
  MV.icon = icon;
})(window.MV);
