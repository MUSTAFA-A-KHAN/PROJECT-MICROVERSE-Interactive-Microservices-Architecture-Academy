/* ==========================================================================
   Microverse — lesson markdown renderer.

   Standard markdown (headings, paragraphs, lists, tables, fenced code,
   blockquotes) plus course-specific blocks:

     :::tip Optional title        callouts: note tip warn danger rule rec sim prod
     ...markdown...
     :::

     :::details Expandable title  collapsible explanation
     :::

     :::quiz concept="idempotency"   inline knowledge check
     Question text
     - [ ] wrong option
     - [x] correct option
     > Explanation shown after answering
     :::

     ::widget{name="gateway-sim"}  interactive component (see js/widgets/*)
     ::diagram{id="saga"}          animated SVG diagram (see data/architectures.js)

   Fenced code accepts attributes: ```go title="cmd/server/main.go" hl="12-18"
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const { esc, icon, codeBlock } = MV.ui;

  const CALLOUTS = {
    note: { icon: 'info', title: 'Note' },
    tip: { icon: 'lightbulb', title: 'Tip' },
    warn: { icon: 'triangle-alert', title: 'Watch out' },
    danger: { icon: 'octagon-alert', title: 'Danger' },
    rule: { icon: 'shield-alert', title: 'Rule', badge: 'Mandatory' },
    rec: { icon: 'compass', title: 'Recommendation', badge: 'Trade-off' },
    sim: { icon: 'flask-conical', title: 'Simulation', badge: 'Simulated' },
    prod: { icon: 'server', title: 'In production' },
  };

  function slugify(s) {
    return s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  }

  function parseAttrs(s) {
    const attrs = {};
    (s || '').replace(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g, (_, k, a, b, c) => { attrs[k] = a ?? b ?? c; return ''; });
    return attrs;
  }

  /* ---------- Inline ---------- */
  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => {
        const ext = /^https?:/.test(h);
        return `<a href="${h}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${t}${ext ? ' ' + icon('arrow-up-right', 'inline-ext', 12) : ''}</a>`;
      })
      .replace(/\{kbd:([^}]+)\}/g, '<span class="kbd">$1</span>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
    return s;
  }

  /* ---------- Block parser ---------- */
  function render(src, ctx = {}) {
    ctx.headings = ctx.headings || [];
    ctx.quizzes = ctx.quizzes || [];
    ctx.slugs = ctx.slugs || new Set();
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const isBlank = (l) => /^\s*$/.test(l);
    const startsBlock = (l) => /^(#{1,4}\s|```|~~~|:::|::(widget|diagram)\{|>\s?|\s*[-*]\s|\s*\d+\.\s|\|.*\||---\s*$)/.test(l);

    while (i < lines.length) {
      const line = lines[i];

      if (isBlank(line)) { i++; continue; }

      // Fenced code
      let m = line.match(/^(```|~~~)\s*([\w+-]*)\s*(.*)$/);
      if (m) {
        const fence = m[1];
        const lang = m[2] || 'text';
        const attrs = parseAttrs(m[3]);
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith(fence)) { buf.push(lines[i]); i++; }
        i++;
        out.push(codeBlock(buf.join('\n'), { lang, title: attrs.title, highlight: attrs.hl, lineNumbers: attrs.ln !== 'false', maxHeight: attrs.max }));
        continue;
      }

      // Heading
      m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        const level = m[1].length;
        const text = m[2].trim();
        let id = slugify(text);
        let n = 2;
        while (ctx.slugs.has(id)) id = slugify(text) + '-' + n++;
        ctx.slugs.add(id);
        if (level <= 3) ctx.headings.push({ id, text: text.replace(/`/g, ''), level });
        const tag = 'h' + Math.max(2, level);
        out.push(`<${tag} id="${id}">${inline(text)}</${tag}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Widget / diagram embed
      m = line.match(/^::(widget|diagram)\{(.*)\}\s*$/);
      if (m) {
        const attrs = parseAttrs(m[2]);
        const json = esc(JSON.stringify(attrs));
        if (m[1] === 'widget') out.push(`<div class="widget" data-widget="${esc(attrs.name)}" data-props="${json}">${MV.ui.skeleton(3)}</div>`);
        else out.push(`<div class="diagram-wrap" data-diagram="${esc(attrs.id)}" data-props="${json}"></div>`);
        i++;
        continue;
      }

      // Containers
      m = line.match(/^:::(\w+)\s*(.*)$/);
      if (m) {
        const type = m[1];
        const rest = m[2];
        const buf = [];
        let depth = 1;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (/^:::\w+/.test(l)) depth++;
          else if (/^:::\s*$/.test(l)) { depth--; if (depth === 0) break; }
          buf.push(l);
          i++;
        }
        i++;
        out.push(renderContainer(type, rest, buf.join('\n'), ctx));
        continue;
      }

      // Table
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = row(line);
        const aligns = row(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
        i += 2;
        const body = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { body.push(row(lines[i])); i++; }
        const th = head.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</th>`).join('');
        const tb = body.map((r) => `<tr>${r.map((c, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="table-wrap scroll-thin"><table class="table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push(`<blockquote>${render(buf.join('\n'), ctx)}</blockquote>`);
        continue;
      }

      // Lists
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const res = parseList(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      // Paragraph
      const buf = [line.trim()];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) { buf.push(lines[i].trim()); i++; }
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  function parseList(lines, start) {
    const indentOf = (l) => l.match(/^\s*/)[0].length;
    const baseIndent = indentOf(lines[start]);
    const ordered = /^\s*\d+\.\s/.test(lines[start]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        // allow a single blank line inside a list if the next line continues it
        const nxt = lines[i + 1];
        if (nxt && indentOf(nxt) >= baseIndent && /^\s*([-*]|\d+\.)\s+/.test(nxt) && indentOf(nxt) === baseIndent) { i++; continue; }
        if (nxt && indentOf(nxt) > baseIndent) { i++; continue; }
        break;
      }
      const ind = indentOf(l);
      const m = l.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (m && ind === baseIndent) {
        items.push({ text: m[2], children: [] });
        i++;
      } else if (ind > baseIndent && items.length) {
        items[items.length - 1].children.push(l.slice(baseIndent + 2));
        i++;
      } else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const html = `<${tag}>${items.map((it) => {
      const childSrc = it.children.join('\n');
      const child = childSrc.trim() ? render(childSrc) : '';
      const chk = it.text.match(/^\[( |x|X)\]\s+(.*)$/);
      if (chk) return `<li class="md-check"><label><input type="checkbox" data-md-check${chk[1].trim() ? ' checked' : ''}><span>${inline(chk[2])}</span></label>${child}</li>`;
      return `<li>${inline(it.text)}${child}</li>`;
    }).join('')}</${tag}>`;
    return { html, next: i };
  }

  function renderContainer(type, rest, body, ctx) {
    if (type === 'details') {
      return `<details class="details"><summary>${icon('chevron-right', 'chev')}<span>${inline(rest || 'Details')}</span></summary><div class="details-body prose">${render(body, ctx)}</div></details>`;
    }
    if (type === 'quiz') return renderQuiz(rest, body, ctx);
    const c = CALLOUTS[type] || CALLOUTS.note;
    const title = rest ? inline(rest) : c.title;
    const badge = c.badge ? `<span class="badge badge-square ${type === 'rule' ? 'badge-err' : type === 'sim' ? 'badge-warn' : 'badge-purple'}">${c.badge}</span>` : '';
    return `<div class="callout callout-${CALLOUTS[type] ? type : 'note'}">${icon(c.icon)}<div><div class="callout-title">${title}${badge}</div><div class="callout-body">${render(body, ctx)}</div></div></div>`;
  }

  function renderQuiz(rest, body, ctx) {
    const attrs = parseAttrs(rest);
    const lines = body.split('\n');
    const q = { concept: attrs.concept || '', question: '', options: [], answer: -1, explain: '' };
    const qLines = [], exLines = [];
    lines.forEach((l) => {
      const opt = l.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
      if (opt) {
        if (opt[1].toLowerCase() === 'x') q.answer = q.options.length;
        q.options.push(opt[2]);
      } else if (/^>\s?/.test(l)) exLines.push(l.replace(/^>\s?/, ''));
      else if (l.trim()) qLines.push(l.trim());
    });
    q.question = qLines.join(' ');
    q.explain = exLines.join(' ');
    const index = ctx.quizzes.length;
    ctx.quizzes.push(q);
    return MV.quiz ? MV.quiz.html(q, index) : '';
  }

  MV.md = { render, inline, slugify, parseAttrs };
})(window.MV);
