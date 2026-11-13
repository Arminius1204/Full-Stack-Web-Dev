/* =========================================================
   billing.js — the "New bill" screen
   • Draft bill lives in one object; inputs update it, then a single
     recalc() refreshes amounts, totals, Invoice Guard and suggestions
   • Rows are rebuilt only when a row is added or removed, so typing
     never loses focus
   • GSTIN is verified asynchronously while the shopkeeper keeps typing:
     debounced, previous request aborted, retry button on failure
   • The draft is kept in sessionStorage, so a refresh doesn't lose a bill
   ========================================================= */
(function (GST) {
  'use strict';
  const { store, ui, guard, esc, money, toPaise, todayISO, ValidationError, STATES } = GST;
  const { $, toast } = ui;
  const DRAFT_KEY = 'gst-ledger:draft';

  let draft;
  let lineSeq = 0;
  let gstinState = { status: 'idle', result: null }; // idle | checking | ok | failed | invalid
  let verifyCtrl = null;
  let lastFindings = [];

  const blankLine = () => ({ key: ++lineSeq, productId: '', qty: 1, price: '', discount: '' });
  const freshDraft = () => ({
    customerId: null, customerText: '', customerGstin: '', placeOfSupply: store.settings.stateCode,
    date: todayISO(), paymentMode: 'cash', notes: '', lines: [blankLine()],
  });

  /* ---------- draft → engine input ---------- */
  function engineLines() {
    return draft.lines.filter((l) => l.productId).map((l) => {
      const p = store.products.get(l.productId);
      return {
        productId: l.productId, name: p?.name || 'Deleted product', hsn: p?.hsn || '', unit: p?.unit || '',
        qty: Number(l.qty), price: toPaise(Number(l.price) || 0), rate: p?.rate ?? 0,
        discount: toPaise(Number(l.discount) || 0), priceIncludesTax: !!p?.priceIncludesTax,
      };
    });
  }
  const isInter = () => draft.placeOfSupply !== store.settings.stateCode;

  /* ---------- rendering ---------- */
  function productOptions(selected) {
    const opts = [...store.products.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''} ${p.stock === 0 && p.id !== selected ? 'disabled' : ''}>${esc(p.name)} · ${p.stock} ${esc(p.unit)}${p.stock === 0 ? ' (out of stock)' : ''}</option>`);
    return `<option value="">Choose product…</option>${opts.join('')}`;
  }

  function renderRows() {
    $('#lineRows').innerHTML = draft.lines.map((l, i) => `
      <tr data-key="${l.key}">
        <td><select data-f="productId" aria-label="Product, row ${i + 1}">${productOptions(l.productId)}</select><span class="row-meta" data-meta></span></td>
        <td><input data-f="qty" type="number" min="1" step="1" inputmode="numeric" value="${esc(l.qty)}" aria-label="Quantity, row ${i + 1}" style="width:5.5rem"></td>
        <td><input data-f="price" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(l.price)}" aria-label="Price, row ${i + 1}" style="width:7rem"></td>
        <td><input data-f="discount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(l.discount)}" placeholder="0" aria-label="Discount, row ${i + 1}" style="width:6rem"></td>
        <td><span class="rate-tag" data-rate>—</span></td>
        <td><span class="amount" data-amount>—</span></td>
        <td><button type="button" class="icon-btn" data-remove aria-label="Remove row ${i + 1}" title="Remove">×</button></td>
      </tr>`).join('');
  }

  function renderCustomerOptions() {
    $('#customerOptions').innerHTML = [...store.customers.values()].map((c) =>
      `<option value="${esc(c.name)}">${esc(c.gstin || c.phone || STATES.get(c.stateCode))}</option>`).join('');
  }

  function recalc() {
    const lines = engineLines();
    const { lines: computed, totals } = GST.computeTotals(lines, isInter());
    // Per-row amount + meta
    let ci = 0;
    for (const l of draft.lines) {
      const row = $(`#lineRows tr[data-key="${l.key}"]`);
      if (!row) continue;
      const p = store.products.get(l.productId);
      if (!l.productId || !p) {
        row.querySelector('[data-amount]').textContent = '—';
        row.querySelector('[data-rate]').textContent = '—';
        row.querySelector('[data-meta]').textContent = '';
        continue;
      }
      const c = computed[ci++];
      row.querySelector('[data-amount]').textContent = money(c.total);
      row.querySelector('[data-rate]').innerHTML = `<span class="pill">${p.rate}%</span>`;
      row.querySelector('[data-meta]').textContent = `HSN ${p.hsn} · ${p.priceIncludesTax ? 'MRP incl. GST' : '+GST'} · ${p.stock} ${p.unit} in stock`;
    }
    // Totals
    const t = totals;
    $('#billTotals').innerHTML = `
      <dt>Items</dt><dd>${t.items}</dd>
      ${t.discount ? `<dt>Discount</dt><dd>−${money(t.discount)}</dd>` : ''}
      <dt>Taxable value</dt><dd>${money(t.taxable)}</dd>
      ${isInter() ? `<dt>IGST</dt><dd>${money(t.igst)}</dd>` : `<dt>CGST</dt><dd>${money(t.cgst)}</dd><dt>SGST</dt><dd>${money(t.sgst)}</dd>`}
      <dt>Round off</dt><dd>${t.roundOff >= 0 ? '+' : '−'}${money(Math.abs(t.roundOff))}</dd>
      <dt class="grand">Total</dt><dd class="grand">${money(t.grandTotal)}</dd>`;
    $('#billWords').textContent = t.grandTotal ? GST.amountInWords(t.grandTotal) : '';

    // Invoice Guard
    // engineLines() keeps draft order, so walk both lists together. A row with
    // numbers typed but no product chosen is passed through so the Guard can flag it.
    let ei = 0;
    const guardLines = [];
    for (const l of draft.lines) {
      if (l.productId) guardLines.push(lines[ei++]);
      else if (l.price || l.discount || String(l.qty) !== '1') guardLines.push({ productId: '', name: '', qty: Number(l.qty), price: 0, discount: 0, rate: 0 });
    }
    const engineDraft = { ...draft, customerGstin: draft.customerGstin.trim().toUpperCase(), lines: guardLines };
    lastFindings = lines.length || draft.customerGstin ? guard.check(engineDraft, {
      hsnMaster: GST.hsn?.map, totals,
      gstinStatus: gstinState.status === 'ok' ? gstinState.result : null,
    }) : [];
    renderGuard(lines.length);

    // Suggestions
    const sugg = guard.suggestions(lines.map((l) => l.productId));
    $('#suggestions').innerHTML = sugg.length ? 'Often bought with these: ' + sugg.map((s) =>
      `<button type="button" data-suggest="${s.product.id}" title="On ${Math.round(s.confidence * 100)}% of bills with these items">+ ${esc(s.product.name)}</button>`).join('') : '';

    $('#saveBill').disabled = lines.length === 0;
    saveDraft();
  }

  function renderGuard(hasLines) {
    const errs = lastFindings.filter((f) => f.level === 'error').length;
    const warns = lastFindings.filter((f) => f.level === 'warn').length;
    const count = $('#guardCount');
    count.textContent = errs ? `${errs} to fix` : warns ? `${warns} to review` : 'all clear';
    count.className = 'pill ' + (errs ? 'pill--err' : warns ? 'pill--warn' : 'pill--ok');
    const label = { error: 'Must fix', warn: 'Check', info: 'Note' };
    $('#guardList').innerHTML = lastFindings.length ? lastFindings.map((f, i) => `
      <li class="guard__item guard__item--${f.level}"><strong>${label[f.level]}</strong>${esc(f.message)}
        ${f.fix ? `<br><button type="button" class="btn btn--small btn--ghost" data-fix="${i}">${esc(f.fix.label)}</button>` : ''}</li>`).join('')
      : `<li class="guard__item guard__item--ok"><strong>All clear</strong>${hasLines ? 'Tax type, rates, stock and GSTIN look right.' : 'Add items to the bill. Invoice Guard checks tax type, GST rates, stock, duplicates and the buyer\'s GSTIN while you type.'}</li>`;
  }

  /* ---------- GSTIN (async) ---------- */
  function setGstinStatus(cls, html) {
    const out = $('#gstinStatus');
    out.className = 'status ' + cls;
    out.innerHTML = html;
  }

  const verifySoon = GST.debounce(verifyNow, 400);

  async function verifyNow() {
    verifyCtrl?.abort();
    const value = draft.customerGstin.trim().toUpperCase();
    $('#retryGstin').hidden = true;
    if (!value) { gstinState = { status: 'idle', result: null }; setGstinStatus('', ''); recalc(); return; }
    const offline = GST.validateGSTIN(value);
    if (!offline.ok) {
      gstinState = { status: 'invalid', result: null };
      setGstinStatus('status--err', esc(offline.reason));
      recalc();
      return;
    }
    // A saved customer with this GSTIN? Link them, so the bill counts towards their account.
    const saved = [...store.customers.values()].find((c) => c.gstin === offline.gstin);
    if (saved && saved.id !== draft.customerId) {
      draft.customerId = saved.id; draft.customerText = saved.name;
      $('#billCustomer').value = saved.name;
    }
    // Valid format: the state code decides place of supply straight away (no need to wait for the network)
    setPlaceOfSupply(offline.stateCode, { silent: true });
    verifyCtrl = new AbortController();
    gstinState = { status: 'checking', result: null };
    setGstinStatus('status--busy', '<span class="spinner"></span> Checksum OK · checking GST portal…');
    recalc();
    try {
      const r = await GST.verifyGSTIN(value, {
        signal: verifyCtrl.signal,
        onRetry: (n, err) => setGstinStatus('status--busy', `<span class="spinner"></span> ${esc(err.message)}. Retrying (${n}/2)…`),
      });
      if (draft.customerGstin.trim().toUpperCase() !== value) return; // input changed meanwhile
      gstinState = { status: 'ok', result: r };
      const good = r.status === 'Active';
      setGstinStatus(good ? 'status--ok' : 'status--err',
        `${good ? '✓' : '✕'} ${esc(r.status)} · ${esc(r.type)}${r.legalName ? ' · ' + esc(r.legalName) : ''}${r.fromCache ? ' <span class="muted">(cached)</span>' : ''}`);
      if (r.legalName && !draft.customerText) { draft.customerText = r.legalName; $('#billCustomer').value = r.legalName; }
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded by newer input, not an error
      gstinState = { status: 'failed', result: null };
      setGstinStatus('status--warn', `⚠ Checksum OK, but the GST portal didn't respond (${esc(err.message)}). You can still issue the bill.`);
      $('#retryGstin').hidden = false;
    }
    recalc();
  }

  /* ---------- actions used by Invoice Guard fixes ---------- */
  function setPlaceOfSupply(code, { silent = false } = {}) {
    draft.placeOfSupply = code;
    $('#billPos').value = code;
    if (!silent) recalc();
  }
  function fixProductRate(productId, rate) {
    const p = store.products.get(productId);
    if (!p) return;
    p.rate = rate;
    store.emit('product:update', { id: productId });
    toast(`${p.name} now taxed at ${rate}% (product list updated)`);
  }
  const formApi = { setPlaceOfSupply, fixProductRate };

  /* ---------- customer ---------- */
  function selectCustomer(c) {
    draft.customerId = c?.id || null;
    draft.customerText = c?.name || '';
    draft.customerGstin = c?.gstin || '';
    $('#billCustomer').value = draft.customerText;
    $('#billGstin').value = draft.customerGstin;
    if (c) setPlaceOfSupply(c.stateCode, { silent: true });
    if (c?.isB2B || c?.id) $('#billPayment').value = draft.paymentMode = 'credit';
    verifyNow();
  }
  function onCustomerInput() {
    const text = $('#billCustomer').value.trim();
    draft.customerText = text;
    const lower = text.toLowerCase();
    const match = [...store.customers.values()].find((c) => c.name.toLowerCase() === lower || c.phone === text || c.gstin === text.toUpperCase());
    if (match) { if (match.id !== draft.customerId) selectCustomer(match); return; }
    if (draft.customerId) { // typed away from a saved customer → walk-in again
      draft.customerId = null; draft.customerGstin = ''; $('#billGstin').value = '';
      setPlaceOfSupply(store.settings.stateCode, { silent: true });
      verifyNow();
    }
    recalc();
  }

  /* ---------- save ---------- */
  function save(e) {
    e?.preventDefault();
    $('#linesError').textContent = '';
    const lines = engineLines();
    if (!lines.length) { $('#linesError').textContent = 'Add at least one product.'; return; }
    const errors = lastFindings.filter((f) => f.level === 'error');
    if (errors.length) {
      toast(`Fix ${errors.length} issue${errors.length > 1 ? 's' : ''} flagged by Invoice Guard first`, { type: 'err' });
      $('.guard').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const warns = lastFindings.filter((f) => f.level === 'warn');
    if (warns.length && !confirm(`Invoice Guard has ${warns.length} warning${warns.length > 1 ? 's' : ''}:\n\n• ${warns.map((w) => w.message).join('\n• ')}\n\nIssue the invoice anyway?`)) return;
    if (gstinState.status === 'checking' && !confirm('GSTIN check is still running. Issue the invoice without waiting?')) return;

    const gstin = draft.customerGstin.trim().toUpperCase();
    try {
      const inv = store.createInvoice({
        date: draft.date,
        customerId: draft.customerId,
        customerName: draft.customerText || (gstin && gstinState.result?.legalName) || 'Walk-in Customer',
        customerGstin: gstin,
        placeOfSupply: draft.placeOfSupply,
        lines,
        paymentMode: draft.paymentMode,
        status: draft.paymentMode === 'credit' ? 'unpaid' : 'paid',
        notes: draft.notes,
      });
      toast(`${inv.number} issued · ${money(inv.totals.grandTotal)}`, { action: { label: 'View / print', run: () => GST.views.openInvoice(inv.id) } });
      reset();
    } catch (err) {
      if (err instanceof ValidationError) {
        if (err.field === 'date') { $('#billDate').setAttribute('aria-invalid', 'true'); $('#billDate').focus(); }
        $('#linesError').textContent = err.message;
        toast(err.message, { type: 'err' });
      } else throw err;
    }
  }

  /* ---------- draft persistence ---------- */
  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* not critical */ }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
      if (d && Array.isArray(d.lines) && d.lines.length) {
        d.lines.forEach((l) => { l.key = ++lineSeq; if (l.productId && !store.products.has(l.productId)) l.productId = ''; });
        return { ...freshDraft(), ...d };
      }
    } catch { /* corrupt draft: start fresh */ }
    return null;
  }

  function fillForm() {
    $('#billCustomer').value = draft.customerText;
    $('#billGstin').value = draft.customerGstin;
    $('#billDate').value = draft.date;
    $('#billDate').max = todayISO();
    $('#billPos').value = draft.placeOfSupply;
    $('#billPayment').value = draft.paymentMode;
    $('#billNotes').value = draft.notes;
    renderRows();
  }

  function reset() {
    verifyCtrl?.abort();
    draft = freshDraft();
    gstinState = { status: 'idle', result: null };
    setGstinStatus('', '');
    $('#retryGstin').hidden = true;
    $('#linesError').textContent = '';
    fillForm();
    recalc();
  }

  function addLine(productId = '') {
    const l = blankLine();
    if (productId) {
      const p = store.products.get(productId);
      l.productId = productId; l.price = (p.price / 100).toFixed(2);
    }
    draft.lines.push(l);
    renderRows();
    recalc();
    const row = $(`#lineRows tr[data-key="${l.key}"]`);
    row?.querySelector(productId ? '[data-f="qty"]' : 'select')?.focus();
  }

  /* ---------- wiring ---------- */
  function init() {
    ui.fillStateSelect($('#billPos'));
    draft = loadDraft() || freshDraft();
    fillForm();
    renderCustomerOptions();

    $('#billForm').addEventListener('submit', save);
    $('#billCustomer').addEventListener('input', onCustomerInput);
    $('#billGstin').addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase().replace(/\s/g, '');
      e.target.setSelectionRange(pos, pos);
      draft.customerGstin = e.target.value;
      gstinState = { status: 'idle', result: null };
      verifyCtrl?.abort(); // cancel the in-flight check immediately, not after the debounce
      verifySoon();
    });
    $('#retryGstin').addEventListener('click', verifyNow);
    $('#billPos').addEventListener('change', (e) => setPlaceOfSupply(e.target.value));
    $('#billDate').addEventListener('change', (e) => { e.target.removeAttribute('aria-invalid'); draft.date = e.target.value || todayISO(); recalc(); });
    $('#billPayment').addEventListener('change', (e) => { draft.paymentMode = e.target.value; saveDraft(); });
    $('#billNotes').addEventListener('input', (e) => { draft.notes = e.target.value; saveDraft(); });
    $('#addLine').addEventListener('click', () => addLine());
    $('#clearBill').addEventListener('click', () => { if (engineLines().length === 0 || confirm('Clear this bill?')) reset(); });

    // One delegated listener for all rows
    $('#lineRows').addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      const key = Number(e.target.closest('tr')?.dataset.key);
      const line = draft.lines.find((l) => l.key === key);
      if (!f || !line) return;
      line[f] = e.target.value;
      if (f === 'productId') {
        const p = store.products.get(line.productId);
        line.price = p ? (p.price / 100).toFixed(2) : '';
        e.target.closest('tr').querySelector('[data-f="price"]').value = line.price;
        e.target.closest('tr').querySelector('[data-f="qty"]').focus();
      }
      $('#linesError').textContent = '';
      recalc();
    });
    $('#lineRows').addEventListener('click', (e) => {
      if (!e.target.closest('[data-remove]')) return;
      const key = Number(e.target.closest('tr').dataset.key);
      draft.lines = draft.lines.filter((l) => l.key !== key);
      if (!draft.lines.length) draft.lines.push(blankLine());
      renderRows(); recalc();
    });
    $('#suggestions').addEventListener('click', (e) => {
      const id = e.target.closest('[data-suggest]')?.dataset.suggest;
      if (id) addLine(id);
    });
    $('#guardList').addEventListener('click', (e) => {
      const i = e.target.closest('[data-fix]')?.dataset.fix;
      if (i !== undefined) lastFindings[i]?.fix?.apply(formApi);
    });

    // Keep options/stock figures fresh when data changes elsewhere
    store.addEventListener('change', (e) => {
      const t = e.detail.type;
      if (t.startsWith('customer') || t === 'hydrate') renderCustomerOptions();
      if (t.startsWith('product') || t.startsWith('invoice') || t === 'hydrate') {
        for (const sel of document.querySelectorAll('#lineRows select[data-f="productId"]')) {
          const line = draft.lines.find((l) => l.key === Number(sel.closest('tr').dataset.key));
          if (line && line.productId && !store.products.has(line.productId)) line.productId = '';
          sel.innerHTML = productOptions(line?.productId);
        }
        recalc();
      }
      if (t === 'settings') recalc();
      $('#nextNumber').textContent = 'Next: ' + store.nextInvoiceNumber(draft.date);
    });
    $('#nextNumber').textContent = 'Next: ' + store.nextInvoiceNumber(draft.date);
    recalc();
    if (draft.customerGstin) verifyNow();
  }

  GST.billing = { init, reset, recalc, addLine, save, selectCustomer };
})(window.GST);
