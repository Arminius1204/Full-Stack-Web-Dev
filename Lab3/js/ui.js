/* =========================================================
   ui.js — DOM helpers, toasts, form errors, small SVG charts
   ========================================================= */
(function (GST) {
  'use strict';
  const { esc, STATES, GST_SLABS, money, moneyCompact, fmtMonth } = GST;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ---------- toasts ---------- */
  function toast(message, { type = 'ok', action, duration = 4000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.innerHTML = `<span>${esc(message)}</span>`;
    let timer;
    const close = () => { clearTimeout(timer); el.remove(); };
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); close(); });
      el.append(b);
    }
    $('#toasts').append(el);
    timer = setTimeout(close, action ? Math.max(duration, 6000) : duration);
    return close;
  }

  /* ---------- forms ---------- */
  function formValues(form) {
    const o = {};
    for (const [k, v] of new FormData(form)) o[k] = typeof v === 'string' ? v.trim() : v;
    return o;
  }

  function clearErrors(form) {
    $$('[aria-invalid="true"]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    $$('[data-error-for]', form).forEach((el) => { el.textContent = ''; });
  }

  /** Put a ValidationError next to the input it belongs to and focus that input. */
  function showError(form, err) {
    clearErrors(form);
    const field = err.field && form.elements[err.field];
    const slot = $(`[data-error-for="${err.field}"]`, form) || $('[data-error-for="form"]', form);
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    if (slot) slot.textContent = err.message;
    else toast(err.message, { type: 'err' });
  }

  function fillStateSelect(select, { placeholder = 'Select state…' } = {}) {
    select.innerHTML = `<option value="">${placeholder}</option>` +
      [...STATES].sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => `<option value="${code}">${esc(name)} (${code})</option>`).join('');
  }
  function fillRateSelect(select) {
    select.innerHTML = [...GST_SLABS].map((r) => `<option value="${r}">${r}%</option>`).join('');
  }

  /* ---------- tooltip shared by charts ---------- */
  let tipEl;
  function showTip(html, x, y) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.append(tipEl); }
    tipEl.innerHTML = html; tipEl.hidden = false;
    const w = tipEl.offsetWidth;
    tipEl.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
    tipEl.style.top = (y - tipEl.offsetHeight - 12) + 'px';
  }
  const hideTip = () => { if (tipEl) tipEl.hidden = true; };

  /* ---------- grouped bar chart: monthly sales + GST ---------- */
  function monthlyChart(container, series) {
    const W = 640, H = 240, padL = 48, padB = 26, padT = 8;
    const max = Math.max(1, ...series.map((s) => s.sales));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const band = (W - padL) / series.length;
    const bw = Math.min(28, band * 0.3);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly sales and GST bar chart">`;
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${moneyCompact(v)}</text>`;
    }
    series.forEach((s, i) => {
      const cx = padL + band * i + band / 2;
      svg += `<g data-i="${i}">`;
      svg += `<rect class="bar-sales" x="${cx - bw - 2}" y="${y(s.sales)}" width="${bw}" height="${Math.max(0, y(0) - y(s.sales))}" rx="5"/>`;
      svg += `<rect class="bar-tax" x="${cx + 2}" y="${y(s.tax)}" width="${bw}" height="${Math.max(0, y(0) - y(s.tax))}" rx="5"/>`;
      svg += `<rect x="${cx - band / 2}" y="0" width="${band}" height="${H - padB}" fill="transparent"/>`;
      svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${fmtMonth(s.month)}</text></g>`;
    });
    svg += '</svg>';
    container.innerHTML = svg;
    // A screen-reader table mirrors the chart.
    container.insertAdjacentHTML('beforeend', `<table class="sr"><caption>Monthly sales</caption><tr><th>Month</th><th>Sales</th><th>GST</th></tr>${series.map((s) => `<tr><td>${fmtMonth(s.month)}</td><td>${money(s.sales)}</td><td>${money(s.tax)}</td></tr>`).join('')}</table>`);
    $$('g[data-i]', container).forEach((g) => {
      const s = series[g.dataset.i];
      g.addEventListener('pointermove', (e) => showTip(`<b>${fmtMonth(s.month)}</b><br>Sales ${money(s.sales)}<br>GST ${money(s.tax)}<br>${s.count} bills`, e.clientX, e.clientY));
      g.addEventListener('pointerleave', hideTip);
    });
  }
  function niceStep(raw) {
    const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }

  /** Horizontal bars; highlights the largest. */
  function hbars(container, rows, fmt = moneyCompact) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    const best = rows.reduce((a, r) => (r.value > a ? r.value : a), 0);
    container.innerHTML = `<div class="hbars">${rows.map((r) => `
      <div class="hbar ${r.value === best && best > 0 ? 'is-top' : ''}">
        <span>${esc(r.label)}</span>
        <span class="hbar__track"><span class="hbar__fill" style="width:${(r.value / max) * 100}%"></span></span>
        <span class="hbar__val">${fmt(r.value)}</span>
      </div>`).join('')}</div>`;
  }

  function deltaBadge(pct, { invert = false } = {}) {
    if (pct === null) return '<span class="delta delta--up">new</span>';
    if (Math.abs(pct) < 0.5) return '<span class="delta delta--flat">±0%</span>';
    const good = invert ? pct < 0 : pct > 0;
    return `<span class="delta ${good ? 'delta--up' : 'delta--down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</span>`;
  }

  GST.ui = { $, $$, toast, formValues, clearErrors, showError, fillStateSelect, fillRateSelect, monthlyChart, hbars, deltaBadge, showTip, hideTip };
})(window.GST);
