/* =========================================================
   views.js — render functions for each tab + entity dialogs
   Each render reads from the store/analytics and writes HTML.
   Clicks are handled with event delegation on the table bodies,
   so re-rendering never leaves stale listeners behind.
   ========================================================= */
(function (GST) {
  'use strict';
  const { store, analytics, ui, esc, money, moneyCompact, fmtDate, STATES, todayISO, financialYear, ValidationError } = GST;
  const { $, $$, toast } = ui;

  const statusPill = (inv) => inv.cancelled ? '<span class="pill">Cancelled</span>'
    : inv.status === 'paid' ? '<span class="pill pill--ok">Paid</span>' : '<span class="pill pill--warn">Unpaid</span>';
  const typePill = (inv) => (inv.isB2B ? '<span class="pill pill--ink">B2B</span> ' : '<span class="pill">B2C</span> ') + (inv.interState ? '<span class="pill pill--info">IGST</span>' : '');
  const daysText = (d) => (d === Infinity ? 'no recent sales' : d < 1 ? 'under a day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`);

  /* =================== DASHBOARD =================== */
  function dashboard() {
    const k = analytics.kpis(30);
    $('#dashDate').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    const tile = (label, value, delta, extra = '', cls = '') =>
      `<div class="kpi ${cls}"><div class="kpi__label">${label}</div><div class="kpi__value">${value}</div>${delta ?? ''}${extra}</div>`;
    $('#kpis').innerHTML = [
      tile('Sales (30 days)', moneyShortSafe(k.sales), ui.deltaBadge(k.delta.sales), '', 'kpi--accent'),
      tile('GST collected', moneyShortSafe(k.tax), ui.deltaBadge(k.delta.tax)),
      tile('Bills issued', k.count.toLocaleString('en-IN'), ui.deltaBadge(k.delta.count)),
      tile('Average bill', moneyShortSafe(k.avg), ui.deltaBadge(k.delta.avg)),
      tile('To collect', moneyShortSafe(k.receivable), '', k.overdue ? `<span class="delta delta--down">${moneyCompact(k.overdue)} over 30 days</span>` : '<span class="delta delta--up">none overdue</span>'),
    ].join('');

    ui.monthlyChart($('#monthlyChart'), analytics.monthlySeries(6));

    const wk = analytics.weekdayPattern();
    ui.hbars($('#weekdayChart'), wk.map((d) => ({ label: d.name, value: d.avg })));
    const sorted = [...wk].sort((a, b) => b.avg - a.avg);
    $('#weekdayInsight').textContent = sorted[0].avg
      ? `${sorted[0].name} is your busiest day (${moneyCompact(sorted[0].avg)} on average); ${sorted.at(-1).name} is quietest. Plan restocking and staff for ${sorted[0].name}.`
      : 'Not enough sales in the last 90 days to spot a pattern yet.';

    const restock = analytics.restockForecast(7).filter((r) => r.level !== 'ok').slice(0, 6);
    $('#restockList').innerHTML = restock.length ? restock.map((r) => `
      <li><div class="list__main"><div class="list__title">${esc(r.product.name)}</div>
        <div class="list__meta">${r.product.stock} ${esc(r.product.unit)} left · lasts ${daysText(r.daysLeft)}${r.suggested ? ` · order ~${r.suggested}` : ''}</div></div>
        <span class="pill ${r.level === 'out' ? 'pill--err' : r.level === 'low' ? 'pill--warn' : 'pill--info'}">${r.level === 'out' ? 'Out' : r.level === 'low' ? 'Low' : 'Watch'}</span></li>`).join('')
      : '<li class="empty">Stock looks healthy for the next two weeks.</li>';

    const rec = analytics.receivables().slice(0, 6);
    $('#receivableList').innerHTML = rec.length ? rec.map((r) => `
      <li><div class="list__main"><div class="list__title">${esc(r.name)}</div>
        <div class="list__meta">${r.invoices.length} bill${r.invoices.length > 1 ? 's' : ''} · oldest ${r.oldestDays} days</div></div>
        <span class="list__val" style="color:${r.oldestDays > 30 ? 'var(--err)' : 'inherit'}">${money(r.amount)}</span></li>`).join('')
      : '<li class="empty">Nothing pending. Every bill is paid.</li>';

    const to = todayISO();
    const top = analytics.periodReport(analytics.addDays(to, -29), to).products.slice(0, 6);
    $('#topList').innerHTML = top.length ? top.map((p, i) => `
      <li><div class="list__main"><div class="list__title">${i + 1}. ${esc(p.name)}</div><div class="list__meta">${p.qty} ${esc(p.unit)} sold</div></div>
        <span class="list__val">${moneyCompact(p.revenue)}</span></li>`).join('')
      : '<li class="empty">No sales in the last 30 days.</li>';
  }
  const moneyShortSafe = (p) => GST.moneyShort(p);

  /* =================== INVOICES =================== */
  const PAGE = 25;
  let invLimit = PAGE;
  let lastInvoiceResults = [];
  function invoices({ resetPaging = false } = {}) {
    if (resetPaging) invLimit = PAGE;
    const from = $('#invFrom').value, to = $('#invTo').value;
    if (from && to && from > to) {
      $('#invSummary').textContent = '“From” date is after “To” date. Swap them to see results.';
      $('#invTable tbody').innerHTML = '';
      return;
    }
    const rows = analytics.searchInvoices({ text: $('#invSearch').value, status: $('#invStatus').value, type: $('#invType').value, from, to });
    lastInvoiceResults = rows;
    const live = rows.filter((r) => !r.cancelled);
    const total = live.reduce((s, r) => s + r.totals.grandTotal, 0);
    $('#invSummary').textContent = rows.length
      ? `${rows.length} invoice${rows.length > 1 ? 's' : ''} · ${money(total)} billed${rows.length > live.length ? ` · ${rows.length - live.length} cancelled` : ''}`
      : 'No invoices match these filters.';
    $('#invTable tbody').innerHTML = rows.slice(0, invLimit).map((i) => `
      <tr data-id="${i.id}" class="${i.cancelled ? 'is-cancelled' : ''}" tabindex="0">
        <td class="strong mono">${esc(i.number)}</td><td>${fmtDate(i.date)}</td>
        <td>${esc(i.customerName)}${i.customerGstin ? `<span class="sub mono">${esc(i.customerGstin)}</span>` : ''}</td>
        <td>${typePill(i)}</td>
        <td class="num">${money(i.totals.taxable)}</td><td class="num">${money(i.totals.tax)}</td>
        <td class="num strong">${money(i.totals.grandTotal)}</td><td>${statusPill(i)}</td></tr>`).join('') ||
      '<tr><td colspan="8" class="empty">Try clearing the search or widening the dates.</td></tr>';
    $('#invMore').hidden = rows.length <= invLimit;
  }
  function moreInvoices() { invLimit += PAGE; invoices(); }

  function exportInvoicesCSV() {
    if (!lastInvoiceResults.length) return toast('Nothing to export for these filters', { type: 'err' });
    const r = (p) => (p / 100).toFixed(2);
    GST.downloadCSV([
      ['Invoice No', 'Date', 'Customer', 'GSTIN', 'Place of Supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Round off', 'Total', 'Status'],
      ...lastInvoiceResults.map((i) => [i.number, i.date, i.customerName, i.customerGstin, STATES.get(i.placeOfSupply), r(i.totals.taxable), r(i.totals.cgst), r(i.totals.sgst), r(i.totals.igst), r(i.totals.roundOff), r(i.totals.grandTotal), i.cancelled ? 'cancelled' : i.status]),
    ], `invoices-${todayISO()}.csv`);
  }

  /* ---------- invoice document (view + print) ---------- */
  function openInvoice(id) {
    const inv = store.invoices.get(id);
    if (!inv) return toast('Invoice not found', { type: 'err' });
    const s = store.settings;
    const t = inv.totals;
    $('#invoiceDoc').innerHTML = `
      <div class="inv-top">
        <div><h3>${esc(s.shopName)}</h3><div class="muted">${esc(s.address || '')}</div>
          <div>GSTIN <b class="mono">${esc(s.gstin)}</b> · ${esc(STATES.get(s.stateCode))} (${s.stateCode})</div>${s.phone ? `<div>Ph ${esc(s.phone)}</div>` : ''}</div>
        <div class="inv-title"><div class="tag">TAX INVOICE</div><h3 class="mono">${esc(inv.number)}</h3><div>${fmtDate(inv.date)}</div>
          ${inv.cancelled ? '<div class="stamp">CANCELLED</div>' : ''}</div>
      </div>
      <div class="inv-parties">
        <div><h4>Bill to</h4><b>${esc(inv.customerName)}</b>${inv.customerGstin ? `<div>GSTIN <span class="mono">${esc(inv.customerGstin)}</span></div>` : '<div class="muted">Unregistered (B2C)</div>'}</div>
        <div><h4>Place of supply</h4>${esc(STATES.get(inv.placeOfSupply))} (${inv.placeOfSupply})<div class="muted">${inv.interState ? 'Inter-state: IGST' : 'Intra-state: CGST + SGST'}</div></div>
      </div>
      <div class="table-wrap"><table class="inv-table">
        <thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Amount</th></tr></thead>
        <tbody>${inv.computed.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}${l.priceIncludesTax ? ' <span class="muted small">(MRP incl. GST)</span>' : ''}</td><td class="mono">${esc(l.hsn)}</td>
          <td class="num">${l.qty} ${esc(l.unit)}</td><td class="num">${money(l.price)}</td><td class="num">${l.discount ? money(l.discount) : '—'}</td>
          <td class="num">${money(l.taxable)}</td><td class="num">${l.rate}%</td><td class="num">${money(l.total)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="inv-bottom">
        <div><p class="words">${GST.amountInWords(t.grandTotal)}</p>${inv.notes ? `<p><b>Notes:</b> ${esc(inv.notes)}</p>` : ''}
          <p class="muted small" style="margin-top:.6rem">Payment: ${esc(inv.paymentMode)} · ${inv.cancelled ? 'cancelled' : inv.status}</p></div>
        <dl class="totals">
          <dt>Taxable value</dt><dd>${money(t.taxable)}</dd>
          ${inv.interState ? `<dt>IGST</dt><dd>${money(t.igst)}</dd>` : `<dt>CGST</dt><dd>${money(t.cgst)}</dd><dt>SGST</dt><dd>${money(t.sgst)}</dd>`}
          <dt>Round off</dt><dd>${(t.roundOff >= 0 ? '+' : '−') + money(Math.abs(t.roundOff))}</dd>
          <dt class="grand">Total</dt><dd class="grand">${money(t.grandTotal)}</dd>
        </dl>
      </div>`;
    const actions = [];
    if (!inv.cancelled) {
      actions.push(inv.status === 'unpaid'
        ? `<button class="btn btn--soft" data-act="paid">Mark as paid</button>`
        : `<button class="btn btn--ghost" data-act="unpaid">Mark as unpaid</button>`);
      actions.push('<button class="btn btn--danger-ghost" data-act="cancel">Cancel invoice</button>');
    }
    actions.push('<button class="btn btn--primary" data-act="print">Print / PDF</button>');
    $('#invoiceActions').innerHTML = actions.join('');
    $('#invoiceActions').dataset.id = id;
    const dlg = $('#invoiceDialog');
    if (!dlg.open) dlg.showModal();
  }

  function onInvoiceAction(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const id = $('#invoiceActions').dataset.id;
    const inv = store.invoices.get(id);
    if (act === 'print') return window.print();
    if (act === 'paid' || act === 'unpaid') { store.setInvoiceStatus(id, act); toast(`${inv.number} marked ${act}`); }
    if (act === 'cancel') {
      if (!confirm(`Cancel ${inv.number}? Stock on this bill will be returned. GST rules do not allow an issued invoice to be deleted, so it stays in your register as cancelled.`)) return;
      store.cancelInvoice(id);
      toast(`${inv.number} cancelled and stock returned`);
    }
    openInvoice(id);
  }

  /* =================== PRODUCTS =================== */
  function rateMismatch(p) {
    const m = GST.hsn?.map.get(p.hsn) || GST.hsn?.map.get(p.hsn.slice(0, 4));
    return m && m.rate !== p.rate ? m : null;
  }
  function products() {
    const q = $('#prodSearch').value.trim().toLowerCase();
    const filter = $('#prodFilter').value;
    const forecast = new Map(analytics.restockForecast(7).map((f) => [f.product.id, f]));
    const rows = [...store.products.values()]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.hsn.startsWith(q))
      .filter((p) => filter === 'all' || (filter === 'low' && forecast.get(p.id)?.level !== 'ok') || (filter === 'mismatch' && rateMismatch(p)))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#prodTable tbody').innerHTML = rows.map((p) => {
      const f = forecast.get(p.id);
      const mm = rateMismatch(p);
      const pill = { out: 'pill--err', low: 'pill--warn', watch: 'pill--info', ok: 'pill--ok' }[f.level];
      return `<tr data-id="${p.id}">
        <td class="strong">${esc(p.name)}<span class="sub">${p.priceIncludesTax ? 'MRP incl. GST' : 'Price before GST'}</span></td>
        <td class="mono">${esc(p.hsn)}</td>
        <td class="num">${p.rate}%${mm ? `<span class="sub" style="color:var(--warn)" title="HSN master says ${mm.rate}%">⚠ master ${mm.rate}%</span>` : ''}</td>
        <td class="num">${money(p.price)}</td>
        <td class="num strong">${p.stock} <span class="muted">${esc(p.unit)}</span></td>
        <td><span class="meter"><span class="pill ${pill}">${f.level === 'ok' ? 'OK' : f.level[0].toUpperCase() + f.level.slice(1)}</span>${f.perDay ? `${daysText(f.daysLeft)} left` : '<span class="muted">no sales, 30d</span>'}</span></td>
        <td><div class="actions">
          <button class="btn btn--small btn--soft" data-act="stock" title="Add stock received">+ Stock</button>
          <button class="btn btn--small btn--ghost" data-act="edit">Edit</button>
          <button class="btn btn--small btn--danger-ghost" data-act="delete" aria-label="Delete ${esc(p.name)}">Delete</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">No products match. Add one with “+ Add product”.</td></tr>';
  }

  function onProductAction(e) {
    const btn = e.target.closest('[data-act]');
    const id = e.target.closest('tr')?.dataset.id;
    if (!btn || !id) return;
    const p = store.products.get(id);
    if (btn.dataset.act === 'edit') return openProductDialog(p);
    if (btn.dataset.act === 'stock') {
      const raw = prompt(`Stock received for ${p.name} (in ${p.unit}). Use a negative number to correct a count.`, '10');
      if (raw === null) return;
      const n = Number(raw);
      if (!Number.isInteger(n) || n === 0) return toast('Enter a whole number, e.g. 12 or -2', { type: 'err' });
      try { store.adjustStock(id, n); toast(`${p.name}: stock now ${p.stock} ${p.unit}`); }
      catch (err) { toast(err.message, { type: 'err' }); }
    }
    if (btn.dataset.act === 'delete') {
      const removed = store.deleteProduct(id);
      toast(`Deleted ${removed.name}`, { action: { label: 'Undo', run: () => store.restoreProduct(removed) } });
    }
  }

  function openProductDialog(p = null) {
    const form = $('#productForm');
    form.reset(); ui.clearErrors(form);
    $('#productDialogTitle').textContent = p ? 'Edit product' : 'Add product';
    $('#hsnHint').textContent = '';
    if (p) {
      for (const k of ['id', 'name', 'hsn', 'stock', 'unit', 'reorderLevel']) form.elements[k].value = p[k];
      form.elements.rate.value = String(p.rate);
      form.elements.price.value = (p.price / 100).toFixed(2);
      form.elements.priceIncludesTax.value = String(p.priceIncludesTax);
      hsnHint();
    } else {
      form.elements.id.value = '';
      form.elements.rate.value = '18';
    }
    $('#productDialog').showModal();
    form.elements.name.focus();
  }
  function hsnHint() {
    const form = $('#productForm');
    const code = form.elements.hsn.value.trim();
    const m = GST.hsn?.map.get(code) || (code.length > 4 && GST.hsn?.map.get(code.slice(0, 4)));
    $('#hsnHint').textContent = m ? `${m.description}: usually ${m.rate}%` : '';
    return m;
  }
  function saveProduct(e) {
    const form = $('#productForm');
    e.preventDefault();
    const v = ui.formValues(form);
    try {
      const p = store.upsertProduct({ ...v, id: v.id || undefined, rate: Number(v.rate), stock: v.stock, reorderLevel: v.reorderLevel || 0, priceIncludesTax: v.priceIncludesTax === 'true' });
      $('#productDialog').close();
      toast(v.id ? `Updated ${p.name}` : `Added ${p.name}`);
    } catch (err) {
      if (err instanceof ValidationError) ui.showError(form, err); else throw err;
    }
  }

  /* =================== CUSTOMERS =================== */
  function customers() {
    const q = $('#custSearch').value.trim().toLowerCase();
    const rows = [...store.customers.values()]
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.gstin.toLowerCase().includes(q))
      .map((c) => {
        const invs = store.invoicesFor(c.id).filter((i) => !i.cancelled);
        return { c, count: invs.length, total: invs.reduce((s, i) => s + i.totals.grandTotal, 0), unpaid: invs.filter((i) => i.status === 'unpaid').reduce((s, i) => s + i.totals.grandTotal, 0) };
      })
      .sort((a, b) => b.total - a.total);
    $('#custTable tbody').innerHTML = rows.map(({ c, count, total, unpaid }) => `
      <tr data-id="${c.id}">
        <td class="strong">${esc(c.name)}${c.phone ? `<span class="sub mono">${esc(c.phone)}</span>` : ''}</td>
        <td class="mono">${c.gstin ? esc(c.gstin) : '<span class="muted">Unregistered</span>'}</td>
        <td>${esc(STATES.get(c.stateCode))}${c.stateCode !== store.settings.stateCode ? ' <span class="pill pill--info">IGST</span>' : ''}</td>
        <td class="num">${count}</td><td class="num">${money(total)}</td>
        <td class="num" style="color:${unpaid ? 'var(--warn)' : 'inherit'}">${unpaid ? money(unpaid) : '—'}</td>
        <td><div class="actions">
          <button class="btn btn--small btn--soft" data-act="bill">Bill</button>
          <button class="btn btn--small btn--ghost" data-act="edit">Edit</button>
          <button class="btn btn--small btn--danger-ghost" data-act="delete" aria-label="Delete ${esc(c.name)}">Delete</button></div></td></tr>`).join('') ||
      '<tr><td colspan="7" class="empty">No customers match.</td></tr>';
  }

  function onCustomerAction(e) {
    const btn = e.target.closest('[data-act]');
    const id = e.target.closest('tr')?.dataset.id;
    if (!btn || !id) return;
    const c = store.customers.get(id);
    if (btn.dataset.act === 'edit') return openCustomerDialog(c);
    if (btn.dataset.act === 'bill') { location.hash = 'new'; GST.billing.selectCustomer(c); return; }
    if (btn.dataset.act === 'delete') {
      const removed = store.deleteCustomer(id);
      toast(`Deleted ${removed.name}. Past invoices keep their details.`, { action: { label: 'Undo', run: () => store.restoreCustomer(removed) } });
    }
  }

  let custVerifyCtrl = null;
  function openCustomerDialog(c = null) {
    const form = $('#customerForm');
    form.reset(); ui.clearErrors(form);
    $('#custGstinStatus').textContent = '';
    $('#customerDialogTitle').textContent = c ? 'Edit customer' : 'Add customer';
    form.elements.id.value = c?.id || '';
    form.elements.name.value = c?.name || '';
    form.elements.phone.value = c?.phone || '';
    form.elements.gstin.value = c?.gstin || '';
    form.elements.stateCode.value = c?.stateCode || store.settings.stateCode;
    form.elements.stateCode.disabled = Boolean(c?.gstin);
    $('#customerDialog').showModal();
    form.elements.name.focus();
  }
  /** Customer dialog: live GSTIN check, cancelling the previous request on every keystroke. */
  const customerGstinInput = GST.debounce(async () => {
    const form = $('#customerForm');
    const input = form.elements.gstin;
    const out = $('#custGstinStatus');
    custVerifyCtrl?.abort();
    const val = input.value.trim().toUpperCase();
    form.elements.stateCode.disabled = false;
    if (!val) { out.textContent = ''; out.className = 'status'; return; }
    const offline = GST.validateGSTIN(val);
    if (!offline.ok) { out.className = 'status status--err'; out.textContent = offline.reason; return; }
    form.elements.stateCode.value = offline.stateCode;
    form.elements.stateCode.disabled = true;
    custVerifyCtrl = new AbortController();
    out.className = 'status status--busy'; out.innerHTML = '<span class="spinner"></span> Checking GST portal…';
    try {
      const r = await GST.verifyGSTIN(val, { signal: custVerifyCtrl.signal, onRetry: (n) => { out.innerHTML = `<span class="spinner"></span> Portal slow, retry ${n}…`; } });
      out.className = 'status ' + (r.status === 'Active' ? 'status--ok' : 'status--err');
      out.textContent = `${r.status === 'Active' ? '✓' : '✕'} ${r.status} · ${r.type}${r.legalName ? ' · ' + r.legalName : ''}`;
      if (r.legalName && !form.elements.name.value.trim()) form.elements.name.value = r.legalName;
    } catch (err) {
      if (err.name === 'AbortError') return;
      out.className = 'status status--warn';
      out.textContent = `Format OK, portal unreachable (${err.message}). You can still save.`;
    }
  }, 350);

  function saveCustomer(e) {
    const form = $('#customerForm');
    e.preventDefault();
    form.elements.stateCode.disabled = false; // disabled fields are left out of FormData
    const v = ui.formValues(form);
    try {
      const c = store.upsertCustomer({ ...v, id: v.id || undefined, createdAt: store.customers.get(v.id)?.createdAt });
      $('#customerDialog').close();
      toast(v.id ? `Updated ${c.name}` : `Added ${c.name}`);
    } catch (err) {
      if (v.gstin) form.elements.stateCode.disabled = GST.validateGSTIN(v.gstin).ok;
      if (err instanceof ValidationError) ui.showError(form, err); else throw err;
    }
  }

  /* =================== REPORTS =================== */
  function periodRange(kind) {
    const t = new Date(todayISO() + 'T00:00:00');
    const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const y = t.getFullYear(), m = t.getMonth();
    if (kind === 'this-month') return [iso(new Date(y, m, 1)), todayISO()];
    if (kind === 'last-month') return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    if (kind === 'quarter') { const qStart = Math.floor(m / 3) * 3; return [iso(new Date(y, qStart, 1)), todayISO()]; }
    if (kind === 'fy') { const fyStart = m >= 3 ? y : y - 1; return [iso(new Date(fyStart, 3, 1)), todayISO()]; }
    return null;
  }
  let lastReport = null;
  function reports({ fromPeriod = false } = {}) {
    const kind = $('#repPeriod').value;
    if (fromPeriod || !$('#repFrom').value) {
      const r = periodRange(kind);
      if (r) { $('#repFrom').value = r[0]; $('#repTo').value = r[1]; }
    }
    const from = $('#repFrom').value, to = $('#repTo').value;
    $('#repError').textContent = '';
    if (!from || !to) { $('#repError').textContent = 'Choose both a start and an end date.'; return; }
    if (from > to) { $('#repError').textContent = 'Start date is after end date.'; $('#reportBody').innerHTML = ''; return; }
    const r = analytics.periodReport(from, to);
    lastReport = { ...r, from, to };
    const T = r.totals;
    const num = (v) => `<td class="num">${money(v)}</td>`;
    const tile = (label, v, cls = '') => `<div class="kpi ${cls}"><div class="kpi__label">${label}</div><div class="kpi__value">${v}</div></div>`;
    $('#reportBody').innerHTML = !T.invoices ? '<div class="card empty">No invoices in this period.</div>' : `
      <div class="report-kpis">
        ${tile('Total sales', moneyCompact(T.sales), 'kpi--accent')}${tile('Taxable value', moneyCompact(T.taxable))}
        ${tile('CGST', money(T.cgst))}${tile('SGST', money(T.sgst))}${tile('IGST', money(T.igst))}
        ${tile('Invoices', `${T.invoices} <span class="small muted">(${T.b2bCount} B2B)</span>`)}
      </div>
      <div class="grid grid--2 report-section">
        <article class="card card--flush"><header class="card__head"><h2>Tax by GST rate</h2></header><div class="table-wrap"><table class="table">
          <thead><tr><th>Rate</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th></tr></thead>
          <tbody>${r.slabs.map((s) => `<tr><td><span class="pill">${s.rate}%</span></td>${num(s.taxable)}${num(s.cgst)}${num(s.sgst)}${num(s.igst)}</tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td>${num(T.taxable)}${num(T.cgst)}${num(T.sgst)}${num(T.igst)}</tr></tfoot></table></div></article>
        <article class="card card--flush"><header class="card__head"><h2>Top customers</h2></header><div class="table-wrap"><table class="table">
          <thead><tr><th>Customer</th><th class="num">Bills</th><th class="num">Billed</th><th class="num">Share</th></tr></thead>
          <tbody>${r.customers.slice(0, 6).map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.invoices}</td>${num(c.total)}<td class="num">${((c.total / T.sales) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div></article>
      </div>
      <article class="card card--flush report-section"><header class="card__head"><h2>HSN-wise summary <span class="muted small">(GSTR-1 Table 12)</span></h2></header><div class="table-wrap"><table class="table">
        <thead><tr><th>HSN</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th></tr></thead>
        <tbody>${r.hsn.map((h) => `<tr><td class="mono">${esc(h.hsn)}</td><td>${esc(h.description)}</td><td class="num">${h.qty} ${esc(h.unit)}</td><td class="num">${h.rate}%</td>${num(h.taxable)}${num(h.cgst)}${num(h.sgst)}${num(h.igst)}</tr>`).join('')}</tbody></table></div></article>
      <div class="grid grid--2 report-section">
        <article class="card card--flush"><header class="card__head"><h2>B2B: by buyer GSTIN <span class="muted small">(GSTR-1 Table 4)</span></h2></header><div class="table-wrap"><table class="table">
          <thead><tr><th>Buyer</th><th class="num">Bills</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
          <tbody>${r.b2b.map((b) => `<tr><td>${esc(b.name)}<span class="sub mono">${esc(b.gstin)}</span></td><td class="num">${b.invoices}</td>${num(b.taxable)}${num(b.tax)}</tr>`).join('') || '<tr><td colspan="4" class="empty">No B2B invoices</td></tr>'}</tbody></table></div></article>
        <article class="card card--flush"><header class="card__head"><h2>B2C: by state &amp; rate <span class="muted small">(GSTR-1 Table 7)</span></h2></header><div class="table-wrap"><table class="table">
          <thead><tr><th>Place of supply</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
          <tbody>${r.b2c.map((b) => `<tr><td>${esc(STATES.get(b.pos))}</td><td class="num">${b.rate}%</td>${num(b.taxable)}${num(b.tax)}</tr>`).join('') || '<tr><td colspan="4" class="empty">No B2C invoices</td></tr>'}</tbody></table></div></article>
      </div>`;
  }
  function exportHsnCSV() {
    if (!lastReport?.hsn.length) return toast('No HSN data for this period', { type: 'err' });
    const r = (p) => (p / 100).toFixed(2);
    GST.downloadCSV([
      ['HSN', 'Description', 'UQC', 'Total Quantity', 'Rate', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Total Value'],
      ...lastReport.hsn.map((h) => [h.hsn, h.description, h.unit.toUpperCase(), h.qty, h.rate, r(h.taxable), r(h.igst), r(h.cgst), r(h.sgst), r(h.taxable + h.igst + h.cgst + h.sgst)]),
    ], `hsn-summary-${lastReport.from}-to-${lastReport.to}.csv`);
  }

  /* =================== SETTINGS =================== */
  function settings() {
    const form = $('#settingsForm');
    for (const k of ['shopName', 'address', 'phone', 'gstin']) form.elements[k].value = store.settings[k] || '';
    netLog();
  }
  function netLog() {
    $('#netLog').innerHTML = GST.netLog.map((e) => `<li><time>${e.at.toLocaleTimeString('en-IN')}</time><span class="k-${e.kind}">${esc(e.message)}</span></li>`).join('') || '<li><span class="k-info">No network activity yet. Verify a GSTIN on a new bill.</span></li>';
  }
  function saveSettings(e) {
    e.preventDefault();
    const form = $('#settingsForm');
    const v = ui.formValues(form);
    if (v.phone && !/^[6-9]\d{9}$/.test(v.phone)) return ui.showError(form, new ValidationError('phone', 'Phone must be a 10-digit mobile number'));
    const oldState = store.settings.stateCode;
    try {
      store.updateSettings(v);
      ui.clearErrors(form);
      toast(store.settings.stateCode !== oldState
        ? `Saved. Shop state is now ${STATES.get(store.settings.stateCode)}: new bills will use the new tax split.`
        : 'Shop profile saved');
    } catch (err) {
      if (err instanceof ValidationError) ui.showError(form, err); else throw err;
    }
  }

  /* chrome shared by all views */
  function chrome() {
    const s = store.settings;
    $('#shopNameTop').textContent = s.shopName;
    $('#footShop').textContent = s.shopName;
    $('#footGstin').textContent = s.gstin;
    $('#footFy').textContent = 'FY ' + financialYear(todayISO());
  }

  GST.views = {
    dashboard, invoices, moreInvoices, exportInvoicesCSV, openInvoice, onInvoiceAction,
    products, onProductAction, openProductDialog, saveProduct, hsnHint,
    customers, onCustomerAction, openCustomerDialog, saveCustomer, customerGstinInput,
    reports, exportHsnCSV, settings, netLog, saveSettings, chrome,
  };
})(window.GST);
