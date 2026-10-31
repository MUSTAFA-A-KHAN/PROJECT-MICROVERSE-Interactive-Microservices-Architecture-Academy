/* ==========================================================================
   Microverse — shared toolkit for interactive lesson widgets.
   Every widget registers as MV.widgets[name] = (el, props) => cleanup.
   ========================================================================== */
window.MV = window.MV || {};
MV.widgets = MV.widgets || {};

(function (MV) {
  'use strict';
  const { esc, icon, $ } = MV.ui;

  /** Standard widget frame: header (title, subtitle, simulated badge), controls row, body. */
  function frame(el, { title, sub = '', ico = 'sparkles', sim = true, controls = '' }) {
    el.innerHTML = `<div class="wg">
      <div class="wg-head">
        <div class="wg-title"><span class="icon-tile sm" style="--c:var(--cyan)">${icon(ico)}</span>
          <div class="min-w-0"><div class="wg-name">${esc(title)}</div>${sub ? `<div class="wg-sub">${esc(sub)}</div>` : ''}</div></div>
        ${sim ? `<span class="badge badge-sim" data-tip="Generated in your browser by a model of the system. No real services are called.">${icon('flask-conical')}Simulated</span>` : ''}
      </div>
      ${controls ? `<div class="wg-controls">${controls}</div>` : ''}
      <div class="wg-body"></div>
    </div>`;
    return { root: $('.wg', el), body: $('.wg-body', el), controls: $('.wg-controls', el) };
  }

  /** Small scrolling event log. */
  function logger(container, max = 80) {
    container.classList.add('wg-log', 'scroll-thin');
    container.setAttribute('role', 'log');
    container.setAttribute('data-lenis-prevent', '');
    let t0 = performance.now();
    return {
      add(text, level = 'info') {
        const row = document.createElement('div');
        row.className = `wg-log-row is-${level}`;
        const ts = ((performance.now() - t0) / 1000).toFixed(2).padStart(6, ' ');
        row.innerHTML = `<span class="mono wg-log-t">${ts}s</span><span>${MV.ui.inlineMd(text)}</span>`;
        container.appendChild(row);
        while (container.children.length > max) container.firstElementChild.remove();
        container.scrollTop = container.scrollHeight;
      },
      clear() { container.innerHTML = ''; t0 = performance.now(); },
    };
  }

  /** Timer registry so widgets can clean up everything on navigation. */
  function timers() {
    const ids = new Set();
    let raf = null;
    return {
      timeout(fn, ms) { const id = setTimeout(() => { ids.delete(id); fn(); }, ms); ids.add(id); return id; },
      interval(fn, ms) { const id = setInterval(fn, ms); ids.add(id); return id; },
      clearTimer(id) { clearTimeout(id); clearInterval(id); ids.delete(id); },
      frame(fn) { raf = requestAnimationFrame(fn); return raf; },
      clear() { ids.forEach((id) => { clearTimeout(id); clearInterval(id); }); ids.clear(); if (raf) cancelAnimationFrame(raf); },
    };
  }

  const sleep = (ms, alive) => new Promise((r) => setTimeout(r, MV.reducedMotion ? 0 : ms)).then(() => { if (alive && !alive()) throw new Error('disposed'); });

  /* ---------------------------------------------------------------------
     Charts (SVG). Colors come from CSS tokens so both themes work.
     Series colors: --chart-1 (blue) and --chart-2 (orange), validated for
     CVD separation and contrast on both chart surfaces.
     --------------------------------------------------------------------- */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  /** A scale whose ticks land on round numbers: step ∈ {1, 2, 5} × 10^k, at most 5 intervals. */
  function niceScale(maxValue) {
    const v = Math.max(maxValue, 1e-9);
    const raw = v / 5;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => Math.ceil(v / s) <= 5);
    const max = Math.ceil(v / step) * step;
    const ticks = [];
    for (let t = 0; t <= max + step / 2; t += step) ticks.push(+t.toFixed(10));
    return { max, ticks };
  }

  /**
   * Line chart with crosshair tooltip.
   * opts: { series: [{ name, values, color }], labels: [x labels], format: v => string,
   *         height, yMax, area: bool, markers: [{ index, text }] }
   */
  function lineChart(el, opts) {
    const w = Math.max(280, el.clientWidth || 520);
    const h = opts.height || 180;
    const pad = { l: 44, r: 12, t: 10, b: 24 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const n = opts.series[0].values.length;
    const rawMax = Math.max(...opts.series.flatMap((s) => s.values), 0);
    const scale = niceScale(Math.max(opts.yMax || 0, rawMax * 1.1));
    const yMax = scale.max;
    const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
    const y = (v) => pad.t + ih - (Math.min(v, yMax) / yMax) * ih;
    const fmt = opts.format || ((v) => String(Math.round(v)));
    const ticks = scale.ticks;
    const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" class="ch-grid"/><text x="${pad.l - 6}" y="${y(t) + 3.5}" text-anchor="end" class="ch-tick">${esc(fmt(t))}</text>`).join('');
    const xl = opts.labels || [];
    const xTicks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
      .map((i) => `<text x="${x(i)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="ch-tick">${esc(xl[i] || '')}</text>`).join('');
    const paths = opts.series.map((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const area = opts.area ? `<path d="${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="${s.color}" opacity=".1"/>` : '';
      const last = s.values[n - 1];
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(n - 1)}" cy="${y(last)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }).join('');
    const marks = (opts.markers || []).map((m) => {
      const mx = x(m.index);
      const right = mx > pad.l + iw * 0.7; // label left of the line near the right edge so it isn't clipped
      return `<line x1="${mx}" x2="${mx}" y1="${pad.t}" y2="${pad.t + ih}" class="ch-marker"/><text x="${right ? mx - 4 : mx + 4}" y="${pad.t + 10}" text-anchor="${right ? 'end' : 'start'}" class="ch-marker-text">${esc(m.text)}</text>`;
    }).join('');
    el.innerHTML = `<div class="ch-wrap"><svg class="ch-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(opts.label || 'Line chart')}">
        ${grid}${xTicks}${marks}${paths}
        <line class="ch-cross" y1="${pad.t}" y2="${pad.t + ih}" x1="0" x2="0" visibility="hidden"/>
        <rect class="ch-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" tabindex="0"/>
      </svg><div class="ch-tip" hidden></div></div>`;
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.ch-tip');
    const cross = el.querySelector('.ch-cross');
    const hit = el.querySelector('.ch-hit');
    const show = (i) => {
      i = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '';
      const head = document.createElement('div'); head.className = 'ch-tip-head'; head.textContent = xl[i] || `#${i + 1}`;
      tip.appendChild(head);
      opts.series.forEach((s) => {
        const row = document.createElement('div'); row.className = 'ch-tip-row';
        const key = document.createElement('span'); key.className = 'ch-key'; key.style.background = s.color;
        const val = document.createElement('strong'); val.textContent = fmt(s.values[i]);
        const name = document.createElement('span'); name.className = 'ch-tip-name'; name.textContent = s.name;
        row.append(key, val, name);
        tip.appendChild(row);
      });
      const px = (x(i) / w) * svg.clientWidth;
      tip.style.left = Math.min(svg.clientWidth - tip.offsetWidth - 4, Math.max(4, px + 10)) + 'px';
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    let kbd = n - 1;
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * w;
      show(Math.round(((sx - pad.l) / iw) * (n - 1)));
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(kbd));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { kbd = Math.max(0, kbd - 1); show(kbd); e.preventDefault(); }
      if (e.key === 'ArrowRight') { kbd = Math.min(n - 1, kbd + 1); show(kbd); e.preventDefault(); }
    });
  }

  /** Column chart (single series) with per-bar hover. bars: [{ label, value, shade? }] */
  function columnChart(el, { bars, height = 170, format = (v) => String(v), label = 'Column chart', bands = [] }) {
    const w = Math.max(280, el.clientWidth || 520);
    const pad = { l: 40, r: 8, t: 10, b: 22 };
    const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
    const yMax = niceMax(Math.max(...bars.map((b) => b.value), 1) * 1.1);
    const slot = iw / bars.length;
    const bw = Math.max(1, Math.min(24, slot - 2));
    const y = (v) => pad.t + ih - (v / yMax) * ih;
    const ticks = [0, 0.5, 1].map((f) => f * yMax);
    const bandSvg = bands.map((b) => `<rect x="${pad.l + b.from * slot}" y="${pad.t}" width="${(b.to - b.from) * slot}" height="${ih}" class="ch-band"/><text x="${pad.l + b.from * slot + 4}" y="${pad.t + 11}" class="ch-band-text">${esc(b.text)}</text>`).join('');
    const rects = bars.map((b, i) => {
      const bx = pad.l + i * slot + (slot - bw) / 2;
      const by = y(b.value);
      const bh = Math.max(0, pad.t + ih - by);
      const r = Math.min(4, bw / 2, bh);
      const d = bh <= 0 ? '' : `M${bx},${pad.t + ih}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${pad.t + ih}Z`;
      return `<g class="ch-bar" data-i="${i}"><rect x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent"/>${d ? `<path d="${d}" fill="${b.color || 'var(--chart-1)'}"/>` : ''}</g>`;
    }).join('');
    el.innerHTML = `<div class="ch-wrap"><svg class="ch-svg" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}" role="img" aria-label="${esc(label)}">
      ${bandSvg}${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" class="ch-grid"/><text x="${pad.l - 6}" y="${y(t) + 3.5}" text-anchor="end" class="ch-tick">${esc(format(t))}</text>`).join('')}
      ${rects}
      <text x="${pad.l}" y="${height - 5}" class="ch-tick">${esc(bars[0] ? bars[0].label : '')}</text>
      <text x="${w - pad.r}" y="${height - 5}" text-anchor="end" class="ch-tick">${esc(bars[bars.length - 1] ? bars[bars.length - 1].label : '')}</text>
    </svg><div class="ch-tip" hidden></div></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.ch-tip');
    svg.addEventListener('pointermove', (e) => {
      const g = e.target.closest('.ch-bar');
      if (!g) { tip.hidden = true; return; }
      const b = bars[+g.dataset.i];
      tip.hidden = false;
      tip.innerHTML = '';
      const head = document.createElement('div'); head.className = 'ch-tip-head'; head.textContent = b.label;
      const val = document.createElement('strong'); val.textContent = format(b.value);
      tip.append(head, val);
      const r = svg.getBoundingClientRect();
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, e.clientX - r.left + 10)) + 'px';
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  /** Inline sparkline (single series). */
  function sparkline(values, { w = 96, h = 26, color = 'var(--chart-1)', max } = {}) {
    const m = max || Math.max(...values, 1);
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 4) + 2},${h - 3 - (Math.min(v, m) / m) * (h - 6)}`);
    const last = pts[pts.length - 1].split(',');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}"/></svg>`;
  }

  MV.wkit = { frame, logger, timers, sleep, lineChart, columnChart, sparkline, niceMax, niceScale };
})(window.MV);
