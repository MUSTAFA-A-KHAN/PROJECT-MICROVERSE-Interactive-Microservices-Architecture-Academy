/* ==========================================================================
   Microverse — SVG diagram engine.

   Renders architecture diagrams from declarative specs (data/architectures.js)
   and animates requests flowing along edges. Used by lesson diagrams,
   guided walkthroughs (GSAP timelines) and the interactive widgets.

   Spec:
     { w, h,
       nodes: [{ id, label, sub, x, y, w?, h?, kind, icon? }],   // x,y = centre
       edges: [{ id, from, to, label?, dashed?, curve?, bidi? }],
       groups: [{ label, x, y, w, h, color? }],                  // x,y = top-left
       steps: [{ title, text, flow: ['e1', '-e1', ['e2','e3']], states: { id: 'down' }, subs: { id: 'text' }, color }] }
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { esc, icon, $, $$ } = MV.ui;
  const NS = 'http://www.w3.org/2000/svg';

  const KIND = {
    client: { color: 'var(--fg-2)', icon: 'monitor-smartphone' },
    gateway: { color: 'var(--cyan)', icon: 'door-open' },
    service: { color: 'var(--blue)', icon: 'server' },
    worker: { color: 'var(--blue)', icon: 'cog' },
    db: { color: 'var(--green)', icon: 'database' },
    cache: { color: 'var(--warn)', icon: 'zap' },
    broker: { color: 'var(--purple)', icon: 'mail' },
    queue: { color: 'var(--purple)', icon: 'list-ordered' },
    external: { color: 'var(--muted)', icon: 'globe' },
    module: { color: 'var(--blue)', icon: 'package' },
    infra: { color: 'var(--cyan)', icon: 'layers' },
    observe: { color: 'var(--warn)', icon: 'chart-line' },
    logic: { color: 'var(--purple)', icon: 'git-branch' },
    error: { color: 'var(--err)', icon: 'octagon-alert' },
  };

  const COLORS = { blue: 'var(--blue)', cyan: 'var(--cyan)', green: 'var(--green)', purple: 'var(--purple)', warn: 'var(--warn)', err: 'var(--err)', muted: 'var(--muted)' };

  function svgIcon(name, x, y, size, color) {
    const html = icon(name);
    return html.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" style="color:${color}" `);
  }

  function edgeGeometry(a, b, curve = 0) {
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let cx = mx, cy = my;
    if (curve) {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      cx = mx + (-dy / len) * curve;
      cy = my + (dx / len) * curve;
    }
    const exit = (n, tx, ty) => {
      const dx = tx - n.x, dy = ty - n.y;
      const hw = (n.w || 156) / 2 + 3, hh = (n.h || 58) / 2 + 3;
      const t = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
      return { x: n.x + dx * t, y: n.y + dy * t };
    };
    const p1 = exit(a, curve ? cx : bx, curve ? cy : by);
    const p2 = exit(b, curve ? cx : ax, curve ? cy : ay);
    const d = curve ? `M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}` : `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
    // Label position: point on curve at t=0.5
    const lx = curve ? 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x : (p1.x + p2.x) / 2;
    const ly = curve ? 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y : (p1.y + p2.y) / 2;
    return { d, lx, ly };
  }

  /** Truncate text so it fits a node of the given width (approximate glyph widths). */
  function fit(text, width, charW) {
    const max = Math.max(4, Math.floor(width / charW));
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  let uid = 0;

  class Diagram {
    constructor(container, spec, opts = {}) {
      this.container = container;
      this.spec = spec;
      this.opts = opts;
      this.id = 'dg' + (++uid);
      this.nodes = new Map(spec.nodes.map((n) => [n.id, { w: 156, h: 58, ...n }]));
      this.edges = new Map((spec.edges || []).map((e) => [e.id, e]));
      this.render();
    }

    render() {
      const { w, h } = this.spec;
      const id = this.id;
      const groups = (this.spec.groups || []).map((g) => {
        const c = COLORS[g.color] || 'var(--muted)';
        return `<g class="dg-group"><rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="12" fill="color-mix(in srgb, ${c} 5%, transparent)" stroke="${c}" stroke-opacity=".45" stroke-dasharray="5 5"/>
          <text x="${g.x + 12}" y="${g.y + 18}" class="dg-group-label" fill="${c}">${esc(g.label)}</text></g>`;
      }).join('');

      const edges = [...this.edges.values()].map((e) => {
        const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
        if (!a || !b) return '';
        const g = edgeGeometry(a, b, e.curve || 0);
        e._g = g;
        const label = e.label ? `<g class="dg-edge-label" transform="translate(${g.lx},${g.ly})"><rect x="${-(e.label.length * 3.3 + 8)}" y="-9" width="${e.label.length * 6.6 + 16}" height="18" rx="5"/><text text-anchor="middle" dy="3.5">${esc(e.label)}</text></g>` : '';
        return `<g class="dg-edge${e.dashed ? ' is-dashed' : ''}" data-edge="${e.id}">
          <path class="dg-edge-path" d="${g.d}" fill="none" marker-end="url(#${id}-arrow)" ${e.bidi ? `marker-start="url(#${id}-arrow-start)"` : ''}/>
          <path class="dg-edge-flow" d="${g.d}" fill="none"/>${label}</g>`;
      }).join('');

      const nodes = [...this.nodes.values()].map((n) => {
        const k = KIND[n.kind] || KIND.service;
        const x = n.x - n.w / 2, y = n.y - n.h / 2;
        const ic = n.icon || k.icon;
        const compact = n.h < 46;
        const textW = compact ? n.w - 16 : n.w - 56;
        return `<g class="dg-node" data-node="${n.id}" data-state="${n.state || 'idle'}" style="--k:${k.color}" ${this.opts.clickable ? 'tabindex="0" role="button"' : ''} aria-label="${esc(n.label)}${n.sub ? ' — ' + esc(n.sub) : ''}">
          <title data-node-title>${esc(n.label)}${n.sub ? ' — ' + esc(n.sub) : ''}</title>
          <rect class="dg-node-bg" x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="10"/>
          ${compact ? '' : `<rect class="dg-node-icon-bg" x="${x + 10}" y="${n.y - 14}" width="28" height="28" rx="7"/>${svgIcon(ic, x + 16, n.y - 8, 16, k.color)}`}
          <text class="dg-node-label" x="${compact ? n.x : x + 46}" y="${n.sub && !compact ? n.y - 2 : n.y + 4}" ${compact ? 'text-anchor="middle"' : ''}>${esc(fit(n.label, textW, 7.1))}</text>
          ${n.sub && !compact ? `<text class="dg-node-sub" x="${x + 46}" y="${n.y + 13}" data-sub>${esc(fit(n.sub, textW, 6.35))}</text>` : ''}
          <g class="dg-badge" data-badge hidden><rect x="${x + n.w - 26}" y="${y - 9}" width="34" height="18" rx="9"/><text x="${x + n.w - 9}" y="${y + 4}" text-anchor="middle"></text></g>
        </g>`;
      }).join('');

      this.container.innerHTML = `<div class="diagram" style="--dg-minw:${Math.round(w * (this.opts.minScale || 0.62))}px">
        <svg class="dg-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(this.spec.title || 'Architecture diagram')}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="dg-arrow"/></marker>
            <marker id="${id}-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="dg-arrow"/></marker>
            <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          ${groups}<g class="dg-edges">${edges}</g><g class="dg-nodes">${nodes}</g><g class="dg-packets"></g>
        </svg></div>`;
      this.svg = $('svg', this.container);
      this.packetLayer = $('.dg-packets', this.svg);
    }

    node(id) { return $(`[data-node="${id}"]`, this.svg); }
    edge(id) { return $(`[data-edge="${id}"]`, this.svg); }

    setState(id, state) { const n = this.node(id); if (n) n.setAttribute('data-state', state || 'idle'); }
    setSub(id, text) {
      const n = this.node(id);
      const t = n && $('[data-sub]', n);
      if (!t) return;
      const spec = this.nodes.get(id);
      t.textContent = fit(text, spec.w - 56, 6.35);
      const title = $('[data-node-title]', n);
      if (title) title.textContent = `${spec.label} — ${text}`;
    }
    setBadge(id, text, color) {
      const n = this.node(id); const b = n && $('[data-badge]', n);
      if (!b) return;
      if (text === null || text === undefined || text === '') { b.setAttribute('hidden', ''); return; }
      b.removeAttribute('hidden');
      $('text', b).textContent = text;
      b.style.setProperty('--bc', color || 'var(--purple)');
    }
    activateEdge(id, on = true, color) {
      const e = this.edge(id);
      if (!e) return;
      e.classList.toggle('is-active', on);
      if (color) e.style.setProperty('--ec', COLORS[color] || color); else e.style.removeProperty('--ec');
    }
    resetStates() {
      $$('.dg-node', this.svg).forEach((n) => {
        const spec = this.nodes.get(n.getAttribute('data-node'));
        n.setAttribute('data-state', (spec && spec.state) || 'idle');
        const sub = $('[data-sub]', n);
        if (sub && spec) sub.textContent = fit(spec.sub || '', spec.w - 56, 6.35);
      });
      $$('.dg-edge', this.svg).forEach((e) => { e.classList.remove('is-active'); e.style.removeProperty('--ec'); });
      $$('[data-badge]', this.svg).forEach((b) => b.setAttribute('hidden', ''));
      this.packetLayer.innerHTML = '';
    }
    pulseNode(id, color) {
      const n = this.node(id);
      if (!n) return;
      n.classList.remove('is-pulse');
      void n.getBBox();
      n.style.setProperty('--pulse', COLORS[color] || color || 'var(--blue)');
      n.classList.add('is-pulse');
      setTimeout(() => n.classList.remove('is-pulse'), 700);
    }

    /** Animate a packet along an edge. Returns a promise resolved on arrival. */
    packet(edgeId, { reverse = false, color = 'blue', duration = 650, label } = {}) {
      const e = this.edge(edgeId);
      if (!e) return Promise.resolve();
      const path = $('.dg-edge-path', e);
      const len = path.getTotalLength();
      const c = COLORS[color] || color;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'dg-packet');
      g.innerHTML = `<circle r="9" fill="${c}" opacity=".18"/><circle r="4.5" fill="${c}" filter="url(#${this.id}-glow)"/>${label ? `<text y="-12" text-anchor="middle" class="dg-packet-label" fill="${c}">${esc(label)}</text>` : ''}`;
      this.packetLayer.appendChild(g);
      this.activateEdge(edgeId, true, color);
      const place = (t) => {
        const p = path.getPointAtLength(len * (reverse ? 1 - t : t));
        g.setAttribute('transform', `translate(${p.x},${p.y})`);
      };
      place(0);
      const dur = MV.reducedMotion ? 10 : duration * (this.opts.speed || 1);
      return new Promise((resolve) => {
        const done = () => {
          g.remove();
          this.activateEdge(edgeId, false);
          resolve();
        };
        if (window.gsap && !MV.reducedMotion) {
          const o = { t: 0 };
          gsap.to(o, { t: 1, duration: dur / 1000, ease: 'power1.inOut', onUpdate: () => place(o.t), onComplete: done });
        } else {
          const start = performance.now();
          const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            place(t);
            if (t < 1) requestAnimationFrame(step); else done();
          };
          requestAnimationFrame(step);
        }
      });
    }

    /** Run a flow list: 'e1' forward, '-e1' reverse, ['e2','e3'] parallel. */
    async flow(list, opts = {}) {
      for (const item of list) {
        if (this.cancelled) return;
        if (Array.isArray(item)) await Promise.all(item.map((x) => this.flowOne(x, opts)));
        else await this.flowOne(item, opts);
      }
    }
    flowOne(item, opts) {
      const reverse = item.startsWith('-');
      const id = reverse ? item.slice(1) : item;
      const e = this.edges.get(id);
      if (e) this.pulseNode(reverse ? e.from : e.to, opts.color);
      return this.packet(id, { reverse, color: opts.color || (reverse ? 'green' : 'blue'), duration: opts.duration || 650 });
    }

    destroy() { this.cancelled = true; this.container.innerHTML = ''; }
  }

  /* ---------- Guided walkthrough (GSAP-driven step player) ---------- */
  function walkthrough(container, spec, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'dg-wrap';
    wrap.innerHTML = `<div class="dg-canvas scroll-thin" data-lenis-prevent></div>
      ${spec.steps && spec.steps.length ? `<div class="dg-controls">
        <div class="flex items-center gap-1.5">
          <button class="btn btn-sm btn-primary" type="button" data-play>${icon('play')}<span>Play walkthrough</span></button>
          <button class="btn btn-sm btn-icon" type="button" data-prev aria-label="Previous step">${icon('chevron-left')}</button>
          <button class="btn btn-sm btn-icon" type="button" data-next aria-label="Next step">${icon('chevron-right')}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-reset aria-label="Reset diagram">${icon('rotate-ccw')}</button>
        </div>
        <div class="dg-steps" role="tablist" aria-label="Walkthrough steps">${spec.steps.map((s, i) => `<button type="button" class="dg-step-dot" data-step="${i}" role="tab" aria-label="Step ${i + 1}: ${esc(s.title || '')}"></button>`).join('')}</div>
        <div class="dg-caption" aria-live="polite"><div class="dg-caption-title"><span class="mono text-mutedc" data-count></span><span data-title>${esc(spec.caption || 'Press Play to walk through the request flow, or step through it manually.')}</span></div><div class="dg-caption-text" data-text></div></div>
      </div>` : spec.caption ? `<div class="dg-controls"><div class="dg-caption"><div class="dg-caption-text">${MV.ui.inlineMd(spec.caption)}</div></div></div>` : ''}`;
    container.innerHTML = '';
    container.appendChild(wrap);
    const dg = new Diagram($('.dg-canvas', wrap), spec, opts);
    if (!spec.steps || !spec.steps.length) return { diagram: dg, destroy: () => dg.destroy() };

    let index = -1, playing = false, runId = 0;
    const steps = spec.steps;
    const els = {
      play: $('[data-play]', wrap), prev: $('[data-prev]', wrap), next: $('[data-next]', wrap), reset: $('[data-reset]', wrap),
      title: $('.dg-controls [data-title]', wrap), text: $('.dg-controls [data-text]', wrap), count: $('.dg-controls [data-count]', wrap), dots: $$('.dg-step-dot', wrap),
    };

    const applyStates = (upto) => {
      dg.resetStates();
      for (let i = 0; i <= upto; i++) {
        const s = steps[i];
        Object.entries(s.states || {}).forEach(([n, st]) => dg.setState(n, st));
        Object.entries(s.subs || {}).forEach(([n, t]) => dg.setSub(n, t));
        Object.entries(s.badges || {}).forEach(([n, t]) => dg.setBadge(n, t));
      }
      (steps[upto].focus || []).forEach((n) => dg.setState(n, steps[upto].states && steps[upto].states[n] ? steps[upto].states[n] : 'active'));
    };
    const caption = (i) => {
      const s = steps[i];
      els.count.textContent = `${i + 1}/${steps.length}`;
      els.title.textContent = s.title || '';
      els.text.innerHTML = MV.ui.inlineMd(s.text || '');
      els.dots.forEach((d, k) => { d.classList.toggle('is-done', k < i); d.setAttribute('aria-selected', String(k === i)); });
      els.prev.disabled = i <= 0;
      els.next.disabled = i >= steps.length - 1 && !playing;
    };
    const go = async (i, animate = true) => {
      const my = ++runId;
      index = Math.max(0, Math.min(steps.length - 1, i));
      applyStates(index);
      caption(index);
      const s = steps[index];
      if (animate && s.flow) await dg.flow(s.flow, { color: s.color, duration: opts.duration });
      return my === runId;
    };
    const setPlaying = (p) => {
      playing = p;
      els.play.innerHTML = p ? `${icon('pause')}<span>Pause</span>` : `${icon('play')}<span>${index >= steps.length - 1 ? 'Replay' : index >= 0 ? 'Resume' : 'Play walkthrough'}</span>`;
    };
    const play = async () => {
      setPlaying(true);
      let i = index >= steps.length - 1 ? 0 : index + 1;
      while (playing && i < steps.length) {
        const ok = await go(i, true);
        if (!ok || !playing) return;
        await MV.sleep(steps[i].pause || 1100);
        i++;
      }
      setPlaying(false);
      caption(index);
    };
    els.play.addEventListener('click', () => { if (playing) setPlaying(false); else play(); });
    els.next.addEventListener('click', () => { setPlaying(false); go(index + 1); });
    els.prev.addEventListener('click', () => { setPlaying(false); go(index - 1, false); });
    els.reset.addEventListener('click', () => {
      setPlaying(false); runId++; index = -1; dg.resetStates();
      els.count.textContent = ''; els.title.textContent = spec.caption || 'Press Play to walk through the request flow, or step through it manually.'; els.text.innerHTML = '';
      els.dots.forEach((d) => { d.classList.remove('is-done'); d.setAttribute('aria-selected', 'false'); });
      els.prev.disabled = true; els.next.disabled = false;
      setPlaying(false);
    });
    els.dots.forEach((d) => d.addEventListener('click', () => { setPlaying(false); go(+d.dataset.step); }));
    els.prev.disabled = true;
    return { diagram: dg, destroy: () => { playing = false; runId++; dg.destroy(); } };
  }

  function mount(el, id, props = {}) {
    const spec = MV.data.diagrams && MV.data.diagrams[id];
    if (!spec) throw new Error(`Unknown diagram "${id}"`);
    const wt = walkthrough(el, spec, { clickable: false });
    if (props.caption) {
      const cap = document.createElement('div');
      cap.className = 'dg-figcaption';
      cap.innerHTML = MV.ui.inlineMd(props.caption);
      el.appendChild(cap);
    }
    return () => wt.destroy();
  }

  MV.Diagram = Diagram;
  MV.diagram = { mount, walkthrough, create: (el, spec, opts) => new Diagram(el, spec, opts), KIND, svgIcon };
})(window.MV);
