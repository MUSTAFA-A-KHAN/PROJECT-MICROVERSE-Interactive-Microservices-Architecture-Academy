/* ==========================================================================
   Microverse — a small, dependency-free code editor.
   A transparent <textarea> sits exactly on top of a syntax-highlighted <pre>
   inside one scroll container, so both scroll together. Editing goes through
   document.execCommand('insertText') where possible, which keeps the
   browser's native undo/redo (Ctrl+Z / Ctrl+Shift+Z) working.

   Features: Go highlighting (MV.highlight), line numbers, active line,
   Tab/Shift+Tab indent, auto-indent, bracket and quote pairing, Ctrl+/
   comments, error markers in the gutter, Ctrl+Enter / Ctrl+S / Shift+Alt+F
   hooks. Esc then Tab moves focus out of the editor (no keyboard trap).
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', '`': '`' };
  const CLOSERS = new Set([')', ']', '}']);
  const INDENT = '\t';
  const TAB = 4;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const visualWidth = (line) => { let w = 0; for (const ch of line) w = ch === '\t' ? w + TAB - (w % TAB) : w + 1; return w; };

  class Editor {
    /**
     * @param {HTMLElement} host
     * @param {{value?:string, lang?:string, readOnly?:boolean, label?:string,
     *          onChange?:(v:string)=>void, onRun?:()=>void, onSave?:()=>void, onFormat?:()=>void}} opts
     */
    constructor(host, opts = {}) {
      this.opts = opts;
      this.lang = opts.lang || 'go';
      this.markers = [];
      this.escaped = false;
      host.innerHTML = `
        <div class="ed${opts.readOnly ? ' is-readonly' : ''}">
          <div class="ed-scroll scroll-thin" data-lenis-prevent>
            <div class="ed-inner">
              <div class="ed-gutter" aria-hidden="true"></div>
              <div class="ed-stack">
                <div class="ed-active" aria-hidden="true"></div>
                <div class="ed-marks" aria-hidden="true"></div>
                <pre class="ed-hl" aria-hidden="true"></pre>
                <textarea class="ed-input" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"
                  aria-label="${esc(opts.label || 'Code editor')}"${opts.readOnly ? ' readonly' : ''}></textarea>
              </div>
            </div>
          </div>
          <span class="ed-measure" aria-hidden="true">0000000000</span>
        </div>`;
      this.root = host.firstElementChild;
      this.scroller = this.root.querySelector('.ed-scroll');
      this.gutter = this.root.querySelector('.ed-gutter');
      this.hl = this.root.querySelector('.ed-hl');
      this.ta = this.root.querySelector('.ed-input');
      this.activeEl = this.root.querySelector('.ed-active');
      this.marksEl = this.root.querySelector('.ed-marks');
      this.ta.value = (opts.value || '').replace(/\r\n?/g, '\n');
      this.ta.setSelectionRange(0, 0); // open at the top, not at the end of the file

      this.ta.addEventListener('input', () => { this.markers = []; this.render(); this.opts.onChange && this.opts.onChange(this.ta.value); });
      this.ta.addEventListener('keydown', (e) => this.onKey(e));
      ['keyup', 'click', 'select', 'focus'].forEach((ev) => this.ta.addEventListener(ev, () => this.syncCaret()));
      this.ta.addEventListener('blur', () => this.root.classList.remove('is-focused'));
      this.ta.addEventListener('focus', () => this.root.classList.add('is-focused'));
      // Clicking the empty area below the text should still place the caret.
      this.scroller.addEventListener('mousedown', (e) => {
        if (e.target === this.scroller || e.target.classList.contains('ed-inner')) { e.preventDefault(); this.ta.focus(); this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length); this.syncCaret(); }
      });
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(this.root);
      this.measure();
      this.render();
    }

    get value() { return this.ta.value; }

    /** Replace the whole document. With {undoable:true} the change can be undone. */
    setValue(v, { undoable = false } = {}) {
      v = String(v).replace(/\r\n?/g, '\n');
      if (v === this.ta.value) return;
      if (undoable && !this.opts.readOnly) {
        this.ta.focus();
        this.ta.setSelectionRange(0, this.ta.value.length);
        this.insert(v);
        this.ta.setSelectionRange(0, 0);
      } else {
        this.ta.value = v;
        this.markers = [];
        this.render();
      }
      this.scroller.scrollTop = 0;
      this.opts.onChange && this.opts.onChange(this.ta.value);
    }

    focus() { this.ta.focus(); }

    /** markers: [{line, col?, message, severity?: 'error'|'warn'}] */
    setMarkers(markers) {
      this.markers = (markers || []).filter((m) => m.line >= 1);
      this.render();
    }

    revealLine(line, col = 1) {
      const lines = this.ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
      pos += Math.max(0, Math.min(col - 1, (lines[line - 1] || '').length));
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos);
      this.syncCaret(true);
    }

    destroy() { this.ro && this.ro.disconnect(); }

    /* ---------------- rendering ---------------- */
    measure() {
      const m = this.root.querySelector('.ed-measure');
      this.charW = m.getBoundingClientRect().width / 10 || 7.7;
      this.lineH = parseFloat(getComputedStyle(this.ta).lineHeight) || 21;
      this.padTop = parseFloat(getComputedStyle(this.ta).paddingTop) || 0;
      this.padLeft = parseFloat(getComputedStyle(this.ta).paddingLeft) || 0;
      this.sizeToContent();
    }

    sizeToContent() {
      const lines = this.ta.value.split('\n');
      const cols = Math.max(40, ...lines.map(visualWidth)) + 4;
      const h = lines.length * this.lineH + this.padTop * 2;
      this.ta.style.height = `${h}px`;
      this.ta.style.width = `${Math.ceil(cols * this.charW + this.padLeft * 2)}px`;
    }

    render() {
      const code = this.ta.value;
      const lines = MV.highlight.lines(code, this.lang);
      this.hl.innerHTML = lines.join('\n') + '\n';
      const byLine = new Map();
      for (const m of this.markers) {
        const prev = byLine.get(m.line);
        byLine.set(m.line, prev ? { ...prev, message: prev.message + '\n' + m.message } : m);
      }
      let g = '', marks = '';
      for (let i = 1; i <= lines.length; i++) {
        const m = byLine.get(i);
        g += m ? `<div class="ed-ln is-${m.severity || 'error'}" title="${esc(m.message)}">${i}</div>` : `<div class="ed-ln">${i}</div>`;
        if (m) marks += `<div class="ed-mark is-${m.severity || 'error'}" style="top:${(i - 1) * this.lineH + this.padTop}px;height:${this.lineH}px"></div>`;
      }
      this.gutter.innerHTML = g;
      this.marksEl.innerHTML = marks;
      this.sizeToContent();
      this.syncCaret();
    }

    caretLineCol() {
      const before = this.ta.value.slice(0, this.ta.selectionStart);
      const nl = before.lastIndexOf('\n');
      return { line: before.split('\n').length, col: visualWidth(before.slice(nl + 1)) };
    }

    syncCaret(center = false) {
      const { line, col } = this.caretLineCol();
      const top = (line - 1) * this.lineH + this.padTop;
      this.activeEl.style.transform = `translateY(${top}px)`;
      this.activeEl.style.height = `${this.lineH}px`;
      this.root.classList.toggle('has-selection', this.ta.selectionStart !== this.ta.selectionEnd);
      if (document.activeElement !== this.ta) return;
      // Keep the caret inside the visible part of the scroll container.
      const s = this.scroller;
      const gutterW = this.gutter.offsetWidth;
      const x = gutterW + this.padLeft + col * this.charW;
      if (center) s.scrollTop = Math.max(0, top - s.clientHeight / 2);
      else if (top < s.scrollTop) s.scrollTop = top - this.padTop;
      else if (top + this.lineH > s.scrollTop + s.clientHeight) s.scrollTop = top + this.lineH - s.clientHeight + this.padTop;
      if (x < s.scrollLeft + gutterW + 8) s.scrollLeft = Math.max(0, x - gutterW - 40);
      else if (x > s.scrollLeft + s.clientWidth - 24) s.scrollLeft = x - s.clientWidth + 60;
      if (this.opts.onCaret) this.opts.onCaret(line, col + 1);
    }

    /* ---------------- editing ---------------- */
    insert(text) {
      // execCommand keeps native undo; setRangeText is the fallback.
      let ok = false;
      try { ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete'); } catch (_) { ok = false; }
      if (!ok) {
        this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
        this.ta.dispatchEvent(new Event('input'));
      }
    }

    replaceRange(start, end, text, selStart, selEnd) {
      this.ta.setSelectionRange(start, end);
      this.insert(text);
      if (selStart != null) this.ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
      this.syncCaret();
    }

    /** Line-range helpers: [start of first selected line, end of last selected line]. */
    selectedLines() {
      const v = this.ta.value, s = this.ta.selectionStart;
      let e = this.ta.selectionEnd;
      if (e > s && v[e - 1] === '\n') e--; // a selection ending at column 0 doesn't include that line
      const from = v.lastIndexOf('\n', s - 1) + 1;
      let to = v.indexOf('\n', e);
      if (to === -1) to = v.length;
      return { from, to, text: v.slice(from, to) };
    }

    indent(out) {
      const { from, to, text } = this.selectedLines();
      const lines = text.split('\n');
      const changed = lines.map((l) => (out ? l.replace(/^(\t| {1,4})/, '') : (l.length ? INDENT + l : l)));
      const next = changed.join('\n');
      if (next === text) return;
      if (lines.length > 1) { this.replaceRange(from, to, next, from, from + next.length); return; }
      const caret = Math.max(from, this.ta.selectionStart + next.length - text.length);
      this.replaceRange(from, to, next, caret);
    }

    toggleComment() {
      const { from, to, text } = this.selectedLines();
      const lines = text.split('\n');
      const code = lines.filter((l) => l.trim());
      const allCommented = code.length && code.every((l) => /^\s*\/\//.test(l));
      const minIndent = Math.min(...code.map((l) => l.match(/^\s*/)[0].length));
      const next = lines.map((l) => {
        if (!l.trim()) return l;
        return allCommented ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.slice(0, minIndent) + '// ' + l.slice(minIndent);
      }).join('\n');
      this.replaceRange(from, to, next, from, from + next.length);
    }

    onKey(e) {
      const ta = this.ta;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { this.escaped = true; return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); this.opts.onRun && this.opts.onRun(); return; }
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.opts.onSave && this.opts.onSave(); return; }
      if (e.shiftKey && e.altKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) { e.preventDefault(); this.opts.onFormat && this.opts.onFormat(); return; }
      if (this.opts.readOnly) return;
      if (mod && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); this.toggleComment(); return; }

      if (e.key === 'Tab') {
        if (this.escaped || mod || e.altKey) { this.escaped = false; return; } // let focus move on
        e.preventDefault();
        const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
        if (e.shiftKey || multi) this.indent(e.shiftKey);
        else this.insert(INDENT);
        return;
      }
      this.escaped = false;

      const v = ta.value, s = ta.selectionStart, end = ta.selectionEnd;
      const prev = v[s - 1], next = v[end];

      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const lineStart = v.lastIndexOf('\n', s - 1) + 1;
        const indent = v.slice(lineStart, s).match(/^[\t ]*/)[0];
        const opens = prev && '{(['.includes(prev);
        if (opens && next === PAIRS[prev] && s === end) {
          // {|}  →  {\n\t|\n}
          this.insert('\n' + indent + INDENT + '\n' + indent);
          const caret = s + 1 + indent.length + INDENT.length;
          ta.setSelectionRange(caret, caret);
        } else {
          this.insert('\n' + indent + (opens ? INDENT : ''));
        }
        this.syncCaret();
        return;
      }

      if (e.key === 'Backspace' && s === end && s > 0 && PAIRS[prev] && next === PAIRS[prev]) {
        e.preventDefault();
        this.replaceRange(s - 1, s + 1, '', s - 1);
        return;
      }

      if (e.key.length !== 1 || mod || e.altKey) return;
      const ch = e.key;

      // Step over a closer or closing quote that is already there.
      if ((CLOSERS.has(ch) || ch === '"' || ch === '`') && s === end && next === ch) {
        e.preventDefault();
        ta.setSelectionRange(s + 1, s + 1);
        this.syncCaret();
        return;
      }
      if (CLOSERS.has(ch) && s === end) {
        // Typing a closer on a whitespace-only line dedents it one level.
        const lineStart = v.lastIndexOf('\n', s - 1) + 1;
        const before = v.slice(lineStart, s);
        if (ch === '}' && /^[\t ]+$/.test(before)) {
          e.preventDefault();
          const out = before.replace(/(\t| {1,4})$/, '');
          this.replaceRange(lineStart, s, out + '}', lineStart + out.length + 1);
          return;
        }
      }
      if (PAIRS[ch]) {
        const isQuote = ch === '"' || ch === '`';
        if (s !== end) {
          // Wrap the selection.
          e.preventDefault();
          const sel = v.slice(s, end);
          this.insert(ch + sel + PAIRS[ch]);
          ta.setSelectionRange(s + 1, s + 1 + sel.length);
          return;
        }
        const nextOk = next === undefined || /[\s)\]},;:]/.test(next);
        const prevOk = !isQuote || prev === undefined || !/[\w"`\\]/.test(prev);
        if (nextOk && prevOk) {
          e.preventDefault();
          this.insert(ch + PAIRS[ch]);
          ta.setSelectionRange(s + 1, s + 1);
          this.syncCaret();
        }
      }
    }
  }

  /**
   * Parse Go toolchain output into editor markers for one file.
   * Matches "./exercise.go:12:5: message" and "exercise.go:12: message"
   * (go build, go vet and the Go Playground all use these shapes).
   */
  function parseGoErrors(output, file) {
    const out = [];
    const re = /(?:^|\s)(?:\.\/|[\w./-]*\/)?([\w.-]+\.go):(\d+)(?::(\d+))?:\s*(.+)/gm;
    let m;
    while ((m = re.exec(output || ''))) {
      if (file && m[1] !== file) continue;
      out.push({ file: m[1], line: +m[2], col: m[3] ? +m[3] : 1, message: m[4].trim() });
    }
    return out;
  }

  MV.Editor = Editor;
  MV.editor = { parseGoErrors };
})(window.MV);
